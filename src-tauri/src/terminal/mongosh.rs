//! Finding `mongosh`, and starting it signed in as the connection.
//!
//! HuginnDB does not ship `mongosh` (it is a ~100 MB Node.js bundle with its
//! own release cadence); it uses the one the user installed. The session it
//! opens is signed in exactly as the connection's pool is: the same effective
//! profile (a personal database user included), the password that pool was
//! opened with, and — when the connection rides an SSH tunnel — the local end
//! of that same tunnel.
//!
//! **The password never reaches the command line.** A process's arguments are
//! readable by every user on Linux (`/proc/<pid>/cmdline`) and shown by every
//! process monitor; its environment is readable only by the same user. So
//! `mongosh` starts with `--nodb`, and a fixed bootstrap passed to `--eval` —
//! which names the variables but carries no secret — connects using the URI
//! from the environment and then deletes it from `process.env`, so a script
//! the user runs afterwards cannot read it back from there either. The
//! bootstrap is not written to `mongosh`'s history, which records only what is
//! typed at the prompt.

use std::path::{Path, PathBuf};
use std::time::Duration;

use portable_pty::CommandBuilder;

use super::shell::find_on_path;
use crate::error::{AppError, AppResult};
use crate::state::ConnectionProfile;

/// The environment variable that carries the connection URI, credentials
/// included, into the bootstrap.
pub const URI_ENV: &str = "HUGINNDB_MONGOSH_URI";
/// The database to switch to after connecting, when one was asked for.
pub const DB_ENV: &str = "HUGINNDB_MONGOSH_DB";

/// Run by `mongosh --eval` before the prompt appears. Ends in `void 0` because
/// `--eval` prints the value of its last expression, and the `delete` before
/// it would otherwise leave a stray `true` above the first prompt.
const BOOTSTRAP: &str = "db = connect(process.env.HUGINNDB_MONGOSH_URI); \
     if (process.env.HUGINNDB_MONGOSH_DB) { db = db.getSiblingDB(process.env.HUGINNDB_MONGOSH_DB); } \
     delete process.env.HUGINNDB_MONGOSH_URI; delete process.env.HUGINNDB_MONGOSH_DB; void 0";

/// The `mongosh` to run: the configured path if set, else the first found on
/// `PATH` or in an official installer's location.
pub fn locate(override_path: &str) -> AppResult<PathBuf> {
    let override_path = override_path.trim();
    if !override_path.is_empty() {
        let path = PathBuf::from(override_path);
        return if path.is_file() {
            Ok(path)
        } else {
            Err(AppError::Terminal(format!(
                "the mongosh set in Settings → Terminal does not exist: {override_path}"
            )))
        };
    }
    find_on_path("mongosh", std::env::var_os("PATH").as_deref())
        .or_else(|| install_locations().into_iter().find(|p| p.is_file()))
        .ok_or_else(|| {
            AppError::Terminal(
                "mongosh was not found. Install it from \
                 https://www.mongodb.com/try/download/shell, or set its path in \
                 Settings → Terminal."
                    .into(),
            )
        })
}

/// Where the official installers put `mongosh`, for when `PATH` does not say.
/// A GUI app on Linux and macOS is started without the login shell's `PATH`,
/// so a Homebrew or `~/.local` install is invisible to a `PATH` lookup there.
fn install_locations() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if cfg!(windows) {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            out.push(Path::new(&local).join(r"Programs\mongosh\mongosh.exe"));
        }
        if let Some(pf) = std::env::var_os("ProgramFiles") {
            out.push(Path::new(&pf).join(r"mongosh\mongosh.exe"));
        }
    } else {
        out.extend(
            [
                "/opt/homebrew/bin/mongosh",
                "/usr/local/bin/mongosh",
                "/usr/bin/mongosh",
                "/snap/bin/mongosh",
            ]
            .map(PathBuf::from),
        );
        if let Some(home) = dirs::home_dir() {
            out.push(home.join(".local/bin/mongosh"));
        }
    }
    out
}

/// `mongosh --version`, or `None` if it does not answer within a few seconds
/// (it is a Node.js program; a cold start takes about one).
pub async fn version(program: &Path) -> Option<String> {
    let mut cmd = tokio::process::Command::new(program);
    cmd.arg("--version").kill_on_drop(true);
    #[cfg(windows)]
    {
        // Settings is a GUI: without this, asking for the version flashes a
        // console window on the user's desktop.
        cmd.creation_flags(crate::updater::process::CREATE_NO_WINDOW);
    }
    let out = tokio::time::timeout(Duration::from_secs(10), cmd.output())
        .await
        .ok()?
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && !text.is_empty()).then_some(text)
}

/// The command that starts `program` signed in with `uri`, switched to
/// `database` when one is given.
pub fn command(program: &Path, uri: &str, database: Option<&str>) -> CommandBuilder {
    let mut cmd = CommandBuilder::new(program);
    cmd.args(["--nodb", "--shell", "--eval", BOOTSTRAP]);
    cmd.env(URI_ENV, uri);
    match database.map(str::trim).filter(|d| !d.is_empty()) {
        Some(db) => cmd.env(DB_ENV, db),
        None => cmd.env_remove(DB_ENV),
    }
    cmd
}

fn enc(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

/// A MongoDB connection string taken apart just enough to change who signs
/// in and where it dials. Not a validating parser — the driver inside
/// `mongosh` is that — and every part it does not touch is written back
/// exactly as it was read.
#[derive(Debug)]
struct MongoUri {
    srv: bool,
    /// Still percent-encoded, as written.
    userinfo: Option<String>,
    hosts: String,
    /// `""` or `/<database>`.
    path: String,
    options: Vec<(String, String)>,
}

impl MongoUri {
    fn parse(raw: &str) -> AppResult<Self> {
        let raw = raw.trim();
        let (srv, rest) = if let Some(rest) = raw.strip_prefix("mongodb+srv://") {
            (true, rest)
        } else if let Some(rest) = raw.strip_prefix("mongodb://") {
            (false, rest)
        } else {
            return Err(AppError::InvalidInput(
                "a MongoDB connection string starts with mongodb:// or mongodb+srv://".into(),
            ));
        };
        let end = rest.find(['/', '?']).unwrap_or(rest.len());
        let (authority, tail) = rest.split_at(end);
        let (userinfo, hosts) = match authority.rfind('@') {
            Some(at) => (Some(authority[..at].to_string()), &authority[at + 1..]),
            None => (None, authority),
        };
        let (path, query) = match tail.split_once('?') {
            Some((path, query)) => (path, query),
            None => (tail, ""),
        };
        let options = query
            .split('&')
            .filter(|kv| !kv.is_empty())
            .map(|kv| match kv.split_once('=') {
                Some((k, v)) => (k.to_string(), v.to_string()),
                None => (kv.to_string(), String::new()),
            })
            .collect();
        Ok(Self {
            srv,
            userinfo,
            hosts: hosts.to_string(),
            path: if path == "/" {
                String::new()
            } else {
                path.to_string()
            },
            options,
        })
    }

    /// URI options are case-insensitive (`authSource` = `authsource`).
    fn has_option(&self, key: &str) -> bool {
        self.options
            .iter()
            .any(|(k, _)| k.eq_ignore_ascii_case(key))
    }

    fn remove_option(&mut self, key: &str) {
        self.options.retain(|(k, _)| !k.eq_ignore_ascii_case(key));
    }

    fn set_option(&mut self, key: &str, value: &str) {
        self.remove_option(key);
        self.options.push((key.to_string(), value.to_string()));
    }

    fn render(&self) -> String {
        let mut out = String::from(if self.srv {
            "mongodb+srv://"
        } else {
            "mongodb://"
        });
        if let Some(userinfo) = &self.userinfo {
            out.push_str(userinfo);
            out.push('@');
        }
        out.push_str(&self.hosts);
        // The slash before `?` is required by the connection-string spec when
        // there are options and no database.
        if !self.path.is_empty() || !self.options.is_empty() {
            out.push_str(if self.path.is_empty() {
                "/"
            } else {
                &self.path
            });
        }
        if !self.options.is_empty() {
            out.push('?');
            let pairs: Vec<String> = self
                .options
                .iter()
                .map(|(k, v)| format!("{k}={v}"))
                .collect();
            out.push_str(&pairs.join("&"));
        }
        out
    }
}

/// The URI `mongosh` should connect with, credentials included: what
/// `db::mongo::open_pool` connects with, rendered back into one string.
///
/// - `profile` is the *effective* profile (`credentials::effective_profile`),
///   so a personal database user replaces the published one here exactly as
///   it does for the pool.
/// - `password` is the one the open pool was signed in with. Injected only
///   when the URI does not already carry one, as `open_pool` does.
/// - `tunnel_port` is the local end of the pool's SSH tunnel. The URI is
///   pointed at it with `directConnection=true` and without `replicaSet`, for
///   the reason `open_pool` gives: topology discovery would otherwise try to
///   reach the real hosts the tunnel stands in for.
pub fn launch_uri(
    profile: &ConnectionProfile,
    password: &str,
    tunnel_port: Option<u16>,
) -> AppResult<String> {
    let mut uri = match profile
        .connection_string
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(cs) => MongoUri::parse(cs)?,
        None => MongoUri {
            srv: false,
            userinfo: None,
            hosts: format!("{}:{}", profile.host, profile.effective_port()),
            path: if profile.database.is_empty() {
                String::new()
            } else {
                format!("/{}", profile.database)
            },
            options: Vec::new(),
        },
    };

    let has_password = uri.userinfo.as_deref().is_some_and(|u| u.contains(':'));
    if !has_password {
        let user = match uri.userinfo.take() {
            Some(encoded) => Some(encoded),
            None if !profile.username.is_empty() => Some(enc(&profile.username)),
            None => None,
        };
        uri.userinfo = match (user, password.is_empty()) {
            (Some(user), false) => Some(format!("{user}:{}", enc(password))),
            (user, _) => user,
        };
    }

    if let Some(source) = profile
        .auth_source
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        if !uri.has_option("authSource") {
            uri.set_option("authSource", &enc(source));
        }
    }

    if let Some(port) = tunnel_port {
        if uri.srv {
            return Err(AppError::InvalidInput(
                "a mongodb+srv:// connection cannot ride an SSH tunnel".into(),
            ));
        }
        if uri.hosts.contains(',') {
            return Err(AppError::InvalidInput(
                "an SSH tunnel needs a single-host connection string".into(),
            ));
        }
        uri.hosts = format!("127.0.0.1:{port}");
        uri.remove_option("replicaSet");
        uri.set_option("directConnection", "true");
    }

    Ok(uri.render())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::Driver;
    use crate::testkit;

    fn mongo(f: impl FnOnce(&mut ConnectionProfile)) -> ConnectionProfile {
        let mut p = ConnectionProfile {
            driver: Driver::Mongo,
            host: "db.example".into(),
            port: 27017,
            username: String::new(),
            ..testkit::profile("m")
        };
        f(&mut p);
        p
    }

    #[test]
    fn fields_without_a_user_make_a_bare_uri() {
        let p = mongo(|_| {});
        assert_eq!(
            launch_uri(&p, "", None).unwrap(),
            "mongodb://db.example:27017"
        );
    }

    #[test]
    fn fields_with_a_user_get_the_password_and_auth_source_encoded() {
        let p = mongo(|p| {
            p.username = "ana maría".into();
            p.database = "shop".into();
            p.auth_source = Some("admin".into());
        });
        assert_eq!(
            launch_uri(&p, "p@ss:w/rd", None).unwrap(),
            "mongodb://ana+mar%C3%ADa:p%40ss%3Aw%2Frd@db.example:27017/shop?authSource=admin"
        );
    }

    #[test]
    fn a_uri_that_carries_its_own_password_is_left_alone() {
        let cs = "mongodb://u:secret@h1:27017,h2:27017/app?replicaSet=rs0&tls=true";
        let p = mongo(|p| p.connection_string = Some(cs.into()));
        assert_eq!(launch_uri(&p, "keychain-pw", None).unwrap(), cs);
    }

    #[test]
    fn a_uri_with_a_user_but_no_password_gets_the_keychain_one() {
        let p = mongo(|p| p.connection_string = Some("mongodb+srv://u@cluster.example/".into()));
        assert_eq!(
            launch_uri(&p, "s3cr3t", None).unwrap(),
            "mongodb+srv://u:s3cr3t@cluster.example"
        );
    }

    /// The shape a personal database user leaves: `credentials` strips the
    /// published user from the URI and puts the person's in `username`.
    #[test]
    fn a_uri_without_a_user_signs_in_as_the_profile_user() {
        let p = mongo(|p| {
            p.connection_string = Some("mongodb://h:27017/?tls=true".into());
            p.username = "alex".into();
        });
        assert_eq!(
            launch_uri(&p, "pw", None).unwrap(),
            "mongodb://alex:pw@h:27017/?tls=true"
        );
    }

    #[test]
    fn an_auth_source_already_in_the_uri_is_not_doubled() {
        let p = mongo(|p| {
            p.connection_string = Some("mongodb://u:p@h/?authsource=other".into());
            p.auth_source = Some("admin".into());
        });
        assert_eq!(
            launch_uri(&p, "", None).unwrap(),
            "mongodb://u:p@h/?authsource=other"
        );
    }

    #[test]
    fn a_tunnel_points_at_its_local_end_directly() {
        let p = mongo(|p| {
            p.connection_string =
                Some("mongodb://u:p@10.0.0.5:27017/app?replicaSet=rs0&tls=false".into())
        });
        assert_eq!(
            launch_uri(&p, "", Some(40123)).unwrap(),
            "mongodb://u:p@127.0.0.1:40123/app?tls=false&directConnection=true"
        );
    }

    #[test]
    fn a_tunnel_cannot_carry_srv_or_a_seed_list() {
        let srv = mongo(|p| p.connection_string = Some("mongodb+srv://c.example".into()));
        assert!(launch_uri(&srv, "", Some(1)).is_err());
        let seeds = mongo(|p| p.connection_string = Some("mongodb://a:1,b:2".into()));
        assert!(launch_uri(&seeds, "", Some(1)).is_err());
    }

    #[test]
    fn something_that_is_not_a_mongodb_uri_is_refused() {
        let p = mongo(|p| p.connection_string = Some("postgres://h/db".into()));
        assert!(matches!(
            launch_uri(&p, "", None),
            Err(AppError::InvalidInput(_))
        ));
    }

    #[test]
    fn the_password_travels_in_the_environment_never_the_arguments() {
        let uri = "mongodb://u:hunter2@h:27017";
        let cmd = command(Path::new("/usr/bin/mongosh"), uri, Some("shop"));
        let argv: Vec<String> = cmd
            .get_argv()
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert!(argv.iter().all(|a| !a.contains("hunter2")), "{argv:?}");
        assert!(argv.contains(&"--nodb".to_string()));
        assert_eq!(
            cmd.get_env(URI_ENV)
                .map(|v| v.to_string_lossy().into_owned()),
            Some(uri.to_string())
        );
        assert_eq!(
            cmd.get_env(DB_ENV)
                .map(|v| v.to_string_lossy().into_owned()),
            Some("shop".to_string())
        );
        let none = command(Path::new("mongosh"), uri, Some("  "));
        assert!(none.get_env(DB_ENV).is_none());
    }

    #[test]
    fn an_override_that_does_not_exist_is_refused() {
        let err = locate("/nonexistent/mongosh").unwrap_err();
        assert!(err.to_string().contains("does not exist"), "{err}");
    }

    /// The whole path against a real server and a real `mongosh`, `#[ignore]`d
    /// so `cargo test` needs neither. Run it by hand when touching this module:
    ///
    /// ```text
    /// docker run -d --name huginn-mongo-test -p 127.0.0.1:27017:27017 \
    ///   -e MONGO_INITDB_ROOT_USERNAME=huginn -e MONGO_INITDB_ROOT_PASSWORD=<pw> mongo:7.0
    /// HUGINNDB_TEST_MONGO_HOST=127.0.0.1:27017 HUGINNDB_TEST_MONGO_USER=huginn \
    ///   HUGINNDB_TEST_MONGO_PASSWORD=<pw> cargo test --features mcp -- --ignored live_mongosh
    /// ```
    ///
    /// The password goes in the way a URI-form profile with a keychain
    /// password does: the profile's URI carries the user and no password.
    #[cfg(unix)]
    #[test]
    #[ignore = "needs mongosh on PATH and a MongoDB server; run by hand"]
    fn live_mongosh_signs_in_and_never_prints_the_password() {
        use crate::terminal::{Owner, TerminalEvent, TerminalRegistry};
        use std::sync::{mpsc, Arc};
        use std::time::{Duration, Instant};

        let var = |k: &str| std::env::var(k).unwrap_or_else(|_| panic!("set {k}"));
        let (host, user, password) = (
            var("HUGINNDB_TEST_MONGO_HOST"),
            var("HUGINNDB_TEST_MONGO_USER"),
            var("HUGINNDB_TEST_MONGO_PASSWORD"),
        );
        let p = mongo(|p| {
            p.connection_string = Some(format!("mongodb://{user}@{host}/?authSource=admin"));
        });
        let uri = launch_uri(&p, &password, None).unwrap();
        let program = locate("").expect("mongosh on PATH");
        let mut cmd = command(&program, &uri, Some("huginn_terminal_test"));
        crate::terminal::prepare(&mut cmd);

        let (tx, rx) = mpsc::channel::<TerminalEvent>();
        let tx = parking_lot::Mutex::new(tx);
        let registry = TerminalRegistry::default();
        let id = registry
            .spawn(
                cmd,
                120,
                30,
                Owner {
                    window: "main".into(),
                    connection_id: Some("m".into()),
                },
                Arc::new(move |e| {
                    let _ = tx.lock().send(e);
                }),
            )
            .unwrap();

        let mut out = String::new();
        let wait_for = |needle: &str, out: &mut String| {
            let deadline = Instant::now() + Duration::from_secs(30);
            while !out.contains(needle) {
                let left = deadline.saturating_duration_since(Instant::now());
                match rx.recv_timeout(left) {
                    Ok(TerminalEvent::Output { data }) => out.push_str(&data),
                    Ok(TerminalEvent::Exit { code }) => panic!("exited ({code:?}): {out}"),
                    Err(_) => panic!("never saw {needle:?} in: {out}"),
                }
            }
        };
        wait_for("huginn_terminal_test>", &mut out);
        registry
            .write(&id, b"print('ping=' + db.runCommand({ping: 1}).ok)\r")
            .unwrap();
        wait_for("ping=1", &mut out);
        registry
            .write(
                &id,
                b"print('leak=' + typeof process.env.HUGINNDB_MONGOSH_URI)\r",
            )
            .unwrap();
        wait_for("leak=undefined", &mut out);
        assert!(!out.contains(&password), "the password reached the screen");
        registry.close_connection("m");
    }
}
