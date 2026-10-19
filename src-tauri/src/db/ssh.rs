//! SSH-tunnel support for server-backed connections.
//!
//! Given an [`SshTunnel`] config and a secret (password or private-key
//! passphrase), [`open_tunnel`] establishes an SSH session, binds a local
//! TCP listener, and proxies every accepted socket through an SSH
//! `direct-tcpip` channel pointing at `(remote_host, remote_port)`.
//!
//! The returned [`SshTunnelHandle`] owns:
//!
//! * the bound local port (which may differ from the configured one when
//!   the user asks for `0` / auto-assign),
//! * a [`CancellationToken`] that, when triggered (or when the handle is
//!   dropped), stops the accept loop and tears the listener down.
//!
//! ### Host-key verification
//!
//! The first thing the SSH handshake does is hand us the server's public
//! key. We compare its SHA-256 fingerprint against
//! [`crate::ssh_known_hosts`] using the policy on the tunnel config:
//!
//! * [`HostKeyPolicy::Strict`]     — only accept a fingerprint that
//!   matches a previously stored entry. Reject unknown servers.
//! * [`HostKeyPolicy::AcceptNew`]  — trust on first use: accept and
//!   persist new fingerprints, reject mismatches afterwards. Same model
//!   as `ssh -o StrictHostKeyChecking=accept-new`. Recommended default.
//! * [`HostKeyPolicy::AcceptAny`]  — accept anything. Offers no MITM
//!   protection; only useful for throwaway test setups.
//!
//! When the handler decides to reject, `russh` short-circuits the
//! handshake with a generic error. We stash a richer human-readable
//! reason in a shared cell and substitute it on the way out so the user
//! actually sees what happened.

use crate::error::{AppError, AppResult};
use crate::ssh_known_hosts::{self, SharedKnownHosts};
use crate::state::{HostKeyPolicy, SshAuth, SshTunnel};
use parking_lot::Mutex;
use russh::client::{self, Handle};
use russh::keys::ssh_key::HashAlg;
use russh::keys::{load_secret_key, PrivateKeyWithHashAlg, PublicKey};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::io::copy_bidirectional;
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

/// Wrap any `russh` error into [`AppError::Ssh`].
fn ssh_err(label: &str, e: impl std::fmt::Display) -> AppError {
    AppError::Ssh(format!("{label}: {e}"))
}

/// Whether a `TcpListener::bind` error on a *pinned* local port means the
/// port simply can't be used (so we should fall back to an ephemeral one)
/// rather than a fatal problem. See the call site for the per-platform
/// `ErrorKind` rationale.
fn is_port_unavailable(kind: std::io::ErrorKind) -> bool {
    use std::io::ErrorKind::*;
    matches!(kind, AddrInUse | PermissionDenied | AddrNotAvailable)
}

/// Active SSH tunnel. Drop the handle to tear the tunnel down.
pub struct SshTunnelHandle {
    /// Local TCP port the tunnel is listening on. When the caller asked
    /// for `local_port = 0`, this exposes the OS-assigned port so the
    /// downstream `sqlx` URL can target it.
    pub local_port: u16,
    cancel: CancellationToken,
}

impl Drop for SshTunnelHandle {
    fn drop(&mut self) {
        // Cancellation cascades into both the accept loop and any in-flight
        // proxy task, allowing them to release the listener and the SSH
        // session promptly.
        self.cancel.cancel();
    }
}

/// Outcome of host-key verification carried out of [`Client::check_server_key`].
#[derive(Debug, Default, Clone)]
struct VerifyOutcome {
    /// Set when the handler rejected the key; used to substitute a useful
    /// error message for the generic one russh emits on close.
    rejection: Option<String>,
    /// `true` when we accepted an unknown key under [`HostKeyPolicy::AcceptNew`]
    /// and the store needs to be flushed to disk.
    persisted_new: bool,
}

/// `russh` client handler that runs host-key verification according to the
/// configured policy and records its decision on the shared
/// [`VerifyOutcome`] so callers can react.
struct Client {
    policy: HostKeyPolicy,
    host_port: String,
    store: SharedKnownHosts,
    outcome: Arc<Mutex<VerifyOutcome>>,
}

impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        // OpenSSH-style "SHA256:<base64>" representation. Stable across
        // crate versions because it's the on-wire fingerprint format.
        let fp = server_public_key.fingerprint(HashAlg::Sha256).to_string();

        match self.policy {
            HostKeyPolicy::AcceptAny => Ok(true),

            HostKeyPolicy::Strict => {
                let known = self.store.read().get(&self.host_port).cloned();
                match known {
                    Some(stored) if stored == fp => Ok(true),
                    Some(stored) => {
                        self.outcome.lock().rejection = Some(format!(
                            "host key mismatch for {} — stored {}, presented {}. Use \"Forget host key\" if the server was legitimately reinstalled.",
                            self.host_port, stored, fp
                        ));
                        Ok(false)
                    }
                    None => {
                        self.outcome.lock().rejection = Some(format!(
                            "host key for {} is not trusted (got {}). Switch the policy to \"Trust on first use\" to accept it.",
                            self.host_port, fp
                        ));
                        Ok(false)
                    }
                }
            }

            HostKeyPolicy::AcceptNew => {
                let known = self.store.read().get(&self.host_port).cloned();
                match known {
                    Some(stored) if stored == fp => Ok(true),
                    Some(stored) => {
                        self.outcome.lock().rejection = Some(format!(
                            "host key changed for {} — previously stored {}, now {}. Use \"Forget host key\" if the server was legitimately reinstalled.",
                            self.host_port, stored, fp
                        ));
                        Ok(false)
                    }
                    None => {
                        self.store.write().insert(self.host_port.clone(), fp);
                        self.outcome.lock().persisted_new = true;
                        Ok(true)
                    }
                }
            }
        }
    }
}

/// How often the SSH session sends its own keepalive, and how many may go
/// unanswered before `russh` declares the session dead.
///
/// `russh` sends none by default. A tunnel used to rely entirely on the
/// database keepalive (`crate::keepalive`, every three minutes, through the
/// top-level pool) to keep its TCP connection to the bastion warm, and
/// per-database pools — which dialled tunnels of their own — had nothing at
/// all. A NAT or firewall that drops idle flows after a few minutes then
/// killed the session silently, and the next query sat waiting on a socket
/// that would never answer. Thirty seconds is well under any common idle
/// timeout and costs one tiny packet. Three misses (~90–120 s) is when the
/// session is given up as dead, so [`TunnelSession::channel`] can dial a new
/// one.
const SSH_KEEPALIVE_INTERVAL: std::time::Duration = std::time::Duration::from_secs(30);
const SSH_KEEPALIVE_MAX: usize = 3;

/// How long opening one `direct-tcpip` channel may take before the session is
/// presumed dead.
///
/// A session whose TCP connection was dropped without a FIN looks alive
/// (`is_closed()` is false) until the keepalive notices, minutes later, and
/// meanwhile a channel request just waits. On a live session a channel opens
/// in one round trip, so ten seconds only ever expires on a dead one.
const CHANNEL_OPEN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// How long dialling a session may take, end to end: the TCP connect, the key
/// exchange, the host-key check and authentication.
///
/// `russh` bounds none of it. A TCP connect to a host behind a firewall that
/// drops packets lasts until the operating system gives up (about 21 s on
/// Windows), and a server that accepts the connection and then never speaks —
/// a tarpit, an `sshd` stalled under load, a port-22 rate limit that holds
/// rather than refuses — never ends at all. That mattered twice over. A first
/// connect sat on "Connecting…" with nothing to report. And a *redial* runs
/// under [`TunnelSession`]'s lock, so every connection the pool tried to open
/// through the tunnel queued behind it, and each of them dialled the bastion
/// again in turn once the lock was released. Fifteen seconds is several times
/// what a healthy bastion takes over a VPN, including a slow password check.
const SSH_DIAL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// Everything needed to dial and authenticate the SSH session again, kept so
/// the tunnel can replace a dead session on its own rather than failing every
/// connection through it until the user reconnects by hand.
struct Dialer {
    tunnel: SshTunnel,
    secret: Option<String>,
    store: SharedKnownHosts,
    /// [`SSH_DIAL_TIMEOUT`] outside tests, which shorten it.
    timeout: std::time::Duration,
}

impl Dialer {
    /// Connect to the SSH server, verify its host key and authenticate, within
    /// [`Dialer::timeout`].
    ///
    /// Host-key verification runs on every dial, the reconnect included: a
    /// server that answers with a different key after the tunnel dropped is
    /// exactly the case the policy exists for, and it is refused the same way.
    async fn dial(&self) -> AppResult<Handle<Client>> {
        match tokio::time::timeout(self.timeout, self.dial_unbounded()).await {
            Ok(dialled) => dialled,
            Err(_) => Err(AppError::Ssh(format!(
                "connect: no answer from the SSH server {}:{} within {}s — the host may be \
                 unreachable, or something between here and it is holding the connection open \
                 without answering",
                self.tunnel.host,
                self.tunnel.port,
                self.timeout.as_secs()
            ))),
        }
    }

    async fn dial_unbounded(&self) -> AppResult<Handle<Client>> {
        let tunnel = &self.tunnel;
        let outcome = Arc::new(Mutex::new(VerifyOutcome::default()));
        let host_port = format!("{}:{}", tunnel.host, tunnel.port);

        let handler = Client {
            policy: tunnel.host_key_policy,
            host_port: host_port.clone(),
            store: self.store.clone(),
            outcome: outcome.clone(),
        };

        let config = Arc::new(client::Config {
            keepalive_interval: Some(SSH_KEEPALIVE_INTERVAL),
            keepalive_max: SSH_KEEPALIVE_MAX,
            // `russh` leaves Nagle's algorithm on by default. A database
            // conversation is small writes waiting on small answers — exactly
            // the traffic Nagle holds back until the previous segment is
            // acknowledged, and the peer's delayed ACK can take tens of
            // milliseconds to come. See `accept_loop` for the other half.
            nodelay: true,
            ..client::Config::default()
        });
        let mut session = client::connect(config, (tunnel.host.as_str(), tunnel.port), handler)
            .await
            .map_err(|e| {
                // If our handler rejected the host key, surface the real reason
                // instead of the generic "connection closed" russh emits.
                if let Some(reason) = outcome.lock().rejection.take() {
                    AppError::Ssh(reason)
                } else {
                    ssh_err("connect", e)
                }
            })?;

        // First-use under AcceptNew adds an entry; flush it to disk so the
        // trust decision survives a restart.
        if outcome.lock().persisted_new {
            let snapshot = self.store.read().clone();
            if let Err(e) = ssh_known_hosts::save(&snapshot) {
                eprintln!("[ssh] failed to persist known_hosts: {e}");
            }
        }

        let authenticated = match &tunnel.auth {
            SshAuth::Password => {
                let pw = self.secret.clone().unwrap_or_default();
                session
                    .authenticate_password(&tunnel.username, pw)
                    .await
                    .map_err(|e| ssh_err("auth-password", e))?
            }
            SshAuth::Key { path } => {
                let passphrase = self.secret.clone().filter(|s| !s.is_empty());
                let key = load_secret_key(PathBuf::from(path), passphrase.as_deref())
                    .map_err(|e| ssh_err("load-key", e))?;
                session
                    .authenticate_publickey(
                        &tunnel.username,
                        PrivateKeyWithHashAlg::new(Arc::new(key), None),
                    )
                    .await
                    .map_err(|e| ssh_err("auth-publickey", e))?
            }
        };
        if !authenticated.success() {
            return Err(AppError::Ssh("authentication rejected by server".into()));
        }
        Ok(session)
    }
}

/// The tunnel's SSH session, replaced in place when it dies.
///
/// Before this, a tunnel was one session for its whole life: if a firewall or
/// a bastion restart dropped it, the local listener kept accepting and every
/// connection through it failed, so the pool behind it was dead until the user
/// noticed and reconnected. Now the first connection to find the session gone
/// dials a new one, under the lock so a pool opening several connections at
/// once dials once, and every connection after it rides the new session.
struct TunnelSession {
    current: tokio::sync::Mutex<Arc<Handle<Client>>>,
    dialer: Dialer,
}

impl TunnelSession {
    /// Open a `direct-tcpip` channel, dialling a fresh session first when the
    /// current one is gone.
    ///
    /// Only a *dead* session is redialled. A channel the server refuses on a
    /// live session (the remote port is closed, `AllowTcpForwarding no`) is a
    /// real answer and is returned as the error; dialling again would only get
    /// the same answer more slowly.
    async fn channel(
        &self,
        remote_host: &str,
        remote_port: u16,
        local_port: u16,
    ) -> AppResult<russh::Channel<client::Msg>> {
        let session = self.current.lock().await.clone();
        if !session.is_closed() {
            match open_channel(&session, remote_host, remote_port, local_port).await {
                Ok(channel) => return Ok(channel),
                Err(ChannelError::Refused(e)) if !session.is_closed() => return Err(e),
                // Closed under us, or never answered: presumed dead.
                Err(_) => {}
            }
        }

        let mut current = self.current.lock().await;
        // Someone else may have redialled while we waited for the lock.
        if Arc::ptr_eq(&current, &session) {
            eprintln!(
                "[ssh] session to {}:{} is gone; reconnecting",
                self.dialer.tunnel.host, self.dialer.tunnel.port
            );
            *current = Arc::new(self.dialer.dial().await?);
        }
        let session = current.clone();
        drop(current);
        open_channel(&session, remote_host, remote_port, local_port)
            .await
            .map_err(ChannelError::into_app)
    }
}

/// Why a channel did not open: the server said no, or nothing answered.
enum ChannelError {
    Refused(AppError),
    TimedOut,
}

impl ChannelError {
    fn into_app(self) -> AppError {
        match self {
            Self::Refused(e) => e,
            Self::TimedOut => AppError::Ssh(format!(
                "open-channel: no answer from the SSH server within {}s",
                CHANNEL_OPEN_TIMEOUT.as_secs()
            )),
        }
    }
}

async fn open_channel(
    session: &Handle<Client>,
    remote_host: &str,
    remote_port: u16,
    local_port: u16,
) -> Result<russh::Channel<client::Msg>, ChannelError> {
    let opening = session.channel_open_direct_tcpip(
        remote_host.to_string(),
        remote_port as u32,
        "127.0.0.1".to_string(),
        local_port as u32,
    );
    match tokio::time::timeout(CHANNEL_OPEN_TIMEOUT, opening).await {
        Ok(Ok(channel)) => Ok(channel),
        Ok(Err(e)) => Err(ChannelError::Refused(ssh_err("open-channel", e))),
        Err(_) => Err(ChannelError::TimedOut),
    }
}

/// Open an SSH session, authenticate, bind the local listener and spawn
/// the accept loop.
pub async fn open_tunnel(
    tunnel: &SshTunnel,
    secret: Option<String>,
    remote_host: &str,
    remote_port: u16,
    store: SharedKnownHosts,
) -> AppResult<SshTunnelHandle> {
    let dialer = Dialer {
        tunnel: tunnel.clone(),
        secret,
        store,
        timeout: SSH_DIAL_TIMEOUT,
    };
    let session = dialer.dial().await?;

    // Bind locally. `local_port = 0` requests an ephemeral port from the
    // OS; we read the actual port back via `local_addr()`.
    //
    // If the user pinned a fixed `local_port` and something else already holds
    // it (e.g. another SSH tunnel the user opened by hand, or an unrelated
    // service on the same port), the bind fails and the whole connection would
    // break. Rather than surface a raw OS error, fall back to an ephemeral
    // port: the pool is pointed at the *bound* port we return on the handle,
    // so swapping the local port at runtime is transparent. The saved profile
    // is left untouched — the override only lasts for this tunnel's lifetime.
    //
    // The conflict surfaces as different `ErrorKind`s across platforms:
    //   * `AddrInUse`        — the common case (POSIX `EADDRINUSE`, and a
    //     plain Windows `WSAEADDRINUSE`).
    //   * `PermissionDenied` — Windows returns `WSAEACCES` when the port is
    //     held by a socket opened with exclusive access, or sits inside a
    //     reserved/excluded range (e.g. Hyper-V / WSL `netsh` reservations).
    //   * `AddrNotAvailable` — occasionally seen for excluded ranges too.
    // All three mean "this specific port won't work"; for a pinned port that
    // is exactly when we want to retry on an OS-assigned one.
    let listener = match TcpListener::bind(("127.0.0.1", tunnel.local_port)).await {
        Ok(l) => l,
        Err(e) if tunnel.local_port != 0 && is_port_unavailable(e.kind()) => {
            eprintln!(
                "[ssh] local port {} unavailable ({:?}); falling back to an ephemeral port",
                tunnel.local_port,
                e.kind()
            );
            TcpListener::bind(("127.0.0.1", 0))
                .await
                .map_err(|e| ssh_err("bind-local-fallback", e))?
        }
        Err(e) => return Err(ssh_err("bind-local", e)),
    };
    let bound_port = listener
        .local_addr()
        .map_err(|e| ssh_err("local-addr", e))?
        .port();

    let cancel = CancellationToken::new();
    let cancel_loop = cancel.clone();
    let session = Arc::new(TunnelSession {
        current: tokio::sync::Mutex::new(Arc::new(session)),
        dialer,
    });
    let remote_host_owned = remote_host.to_string();

    tokio::spawn(async move {
        accept_loop(
            listener,
            session,
            remote_host_owned,
            remote_port,
            bound_port,
            cancel_loop,
        )
        .await;
    });

    Ok(SshTunnelHandle {
        local_port: bound_port,
        cancel,
    })
}

/// Accept incoming TCP connections on the local listener and proxy each
/// one through a fresh `direct-tcpip` SSH channel until cancelled.
async fn accept_loop(
    listener: TcpListener,
    session: Arc<TunnelSession>,
    remote_host: String,
    remote_port: u16,
    local_port: u16,
    cancel: CancellationToken,
) {
    loop {
        tokio::select! {
            _ = cancel.cancelled() => return,
            accepted = listener.accept() => {
                let Ok((socket, _peer)) = accepted else { return };
                // The local hop needs it too: the driver disables Nagle on its
                // own end of this socket, but this end — ours — is what writes
                // the server's answers back to it. Best effort; a socket that
                // refuses the option still works, only slower.
                let _ = socket.set_nodelay(true);
                let session = session.clone();
                let remote_host = remote_host.clone();
                let cancel = cancel.clone();
                tokio::spawn(async move {
                    let _ = proxy_one(
                        socket,
                        session,
                        remote_host,
                        remote_port,
                        local_port,
                        cancel,
                    )
                    .await;
                });
            }
        }
    }
}

/// Proxy a single accepted TCP socket end-to-end through a freshly opened
/// SSH `direct-tcpip` channel using `copy_bidirectional` over the channel's
/// `AsyncRead + AsyncWrite` adapter.
async fn proxy_one(
    mut socket: tokio::net::TcpStream,
    session: Arc<TunnelSession>,
    remote_host: String,
    remote_port: u16,
    local_port: u16,
    cancel: CancellationToken,
) -> AppResult<()> {
    let channel = session
        .channel(&remote_host, remote_port, local_port)
        .await?;

    let mut stream = channel.into_stream();
    tokio::select! {
        _ = cancel.cancelled() => Ok(()),
        result = copy_bidirectional(&mut socket, &mut stream) => {
            result.map(|_| ()).map_err(|e| ssh_err("proxy", e))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dialer_to(port: u16, timeout: std::time::Duration) -> Dialer {
        Dialer {
            tunnel: SshTunnel {
                host: "127.0.0.1".into(),
                port,
                username: "u".into(),
                auth: SshAuth::Password,
                local_port: 0,
                host_key_policy: HostKeyPolicy::AcceptAny,
            },
            secret: None,
            store: Default::default(),
            timeout,
        }
    }

    /// A server that accepts the TCP connection and then never speaks — a
    /// tarpit, or an `sshd` stalled under load — used to hold a dial forever,
    /// and a redial holds the tunnel's lock while it waits. It must give up.
    #[tokio::test]
    async fn a_server_that_accepts_and_never_answers_fails_the_dial_in_bounded_time() {
        let silent = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = silent.local_addr().unwrap().port();
        // Accept and keep the socket open without writing a byte.
        let held = tokio::spawn(async move {
            let (socket, _) = silent.accept().await.unwrap();
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
            drop(socket);
        });

        let started = std::time::Instant::now();
        let outcome = dialer_to(port, std::time::Duration::from_millis(300))
            .dial()
            .await;
        let Err(e) = outcome else {
            panic!("a server that never answers must not produce a session");
        };
        assert!(
            started.elapsed() < std::time::Duration::from_secs(5),
            "the dial must give up at its bound, not wait on the server"
        );
        assert!(matches!(e, AppError::Ssh(_)));
        let rendered = e.to_string();
        assert!(
            rendered.contains(&format!("127.0.0.1:{port}")),
            "{rendered}"
        );
        assert!(rendered.contains("no answer"), "{rendered}");
        held.abort();
    }

    /// The bound is a ceiling, not a delay: a refused connection still fails
    /// at once and as itself.
    #[tokio::test]
    async fn a_refused_connection_fails_at_once_and_as_itself() {
        // Bind and drop to get a port nothing listens on.
        let port = {
            let l = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            l.local_addr().unwrap().port()
        };
        let started = std::time::Instant::now();
        let Err(e) = dialer_to(port, std::time::Duration::from_secs(15))
            .dial()
            .await
        else {
            panic!("nothing is listening");
        };
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
        assert!(!e.to_string().contains("no answer"), "{e}");
    }
}
