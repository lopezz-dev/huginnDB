//! Sidecar side of the MCP bridge: the client that hands data-path calls to a
//! running desktop app instead of opening pools of its own.
//!
//! See [`crate::bridge`] for the rationale. This half's job is narrow but has
//! one rule that has to be exactly right — the fallback rule in
//! [`BridgeClient::call`].

use crate::bridge::protocol::{BridgeRequest, BridgeResponse, Hello, HelloAck, PROTOCOL_VERSION};
use crate::bridge::read_discovery;
use serde_json::Value;
use std::io;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tokio::time::{timeout, Duration};

/// How long to wait for the app to answer one call, unless the call carries a
/// timeout of its own ([`reply_wait`]).
///
/// Generous, because the app is running a real query on our behalf and a slow
/// database is not a broken bridge. This only bounds the case where the app
/// process is wedged rather than busy: the calls that may legitimately run for
/// long — `run_script`, `run_writes` — are bounded by the app itself, which
/// cancels them and answers.
const CALL_TIMEOUT: Duration = Duration::from_secs(300);

/// What a call bounded by the app is given on top of twice its timeout, for
/// the cancel to be acknowledged and the reply to cross.
const REPLY_SLACK: Duration = Duration::from_secs(120);

/// How long to wait for the app's answer to `request`.
///
/// For a `run_script` / `run_writes` the app enforces the timeout and answers
/// once it has cancelled and rolled back — and a rollback undoes what the
/// statement did so far, which can take about as long again. So the wait is
/// twice the timeout plus [`REPLY_SLACK`]: well past the point where the app
/// has given its own, certain, answer, so that this side giving up first —
/// with no idea whether the script committed — takes a wedged app rather than
/// a slow rollback.
pub(crate) fn reply_wait(request: &BridgeRequest) -> Duration {
    match request {
        BridgeRequest::RunScript { timeout_secs, .. }
        | BridgeRequest::RunWriteBatch { timeout_secs, .. } => {
            let secs = timeout_secs
                .unwrap_or(crate::state::DEFAULT_MCP_TIMEOUT_SECS)
                .clamp(1, crate::state::MAX_MCP_TIMEOUT_SECS);
            CALL_TIMEOUT.max(Duration::from_secs(2 * u64::from(secs)) + REPLY_SLACK)
        }
        _ => CALL_TIMEOUT,
    }
}

/// How long to wait for the initial connect + handshake. Short: the app is on
/// loopback, and this runs on the sidecar's *first* tool call, where a stall
/// would look like a hung MCP server.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);

/// What went wrong with a bridged call. The distinction drives the fallback.
#[derive(Debug)]
pub enum BridgeError {
    /// The app could not be reached, or the connection broke. **Only ever
    /// returned before the request was written** — see [`BridgeClient::call`].
    Unreachable(String),
    /// The app answered, and the answer was an error. This is the database's
    /// or the policy's verdict and must be reported as-is.
    Remote(String),
}

/// A live connection to the desktop app.
///
/// The stream is behind a `Mutex` rather than being cloned per call: the
/// protocol is strictly one request, one response, in order, on one connection.
/// Two concurrent calls would interleave their lines and each would read the
/// other's answer. MCP dispatches tools serially so contention is nil, but the
/// lock is what makes that a guarantee rather than an assumption.
pub struct BridgeClient {
    stream: Mutex<Connection>,
    /// Connections this client is allowed to reach, re-sent on reconnect.
    allowed: Vec<String>,
    /// Whether the app should authorize against `mcp_exposed` rather than
    /// against `allowed`. Re-sent on reconnect for the same reason `allowed`
    /// is: a reconnect is a fresh handshake and the app remembers nothing.
    defer_exposure: bool,
}

struct Connection {
    reader: tokio::io::Lines<BufReader<OwnedReadHalf>>,
    writer: OwnedWriteHalf,
}

impl BridgeClient {
    /// Try to attach to a running desktop app.
    ///
    /// `None` — never an error — when there is no app to attach to: no
    /// discovery file, a stale one pointing at a dead port, a version mismatch,
    /// or a rejected token. Every one of those is a normal reason to fall back
    /// to local pools, and none of them should fail a tool call or print
    /// anything alarming.
    /// `defer_exposure` says the sidecar has no `--connections` list of its own
    /// and the app should authorize against `ConnectionProfile::mcp_exposed`
    /// instead, re-read per request. `allowed` still carries this process's
    /// snapshot of that set — see the note where [`crate::mcp::serve`] builds
    /// it for why the snapshot travels even then.
    pub async fn connect(allowed: Vec<String>, defer_exposure: bool) -> Option<Self> {
        let discovery = read_discovery()?;
        let connection = timeout(
            CONNECT_TIMEOUT,
            Self::handshake(&discovery.token, discovery.port, &allowed, defer_exposure),
        )
        .await
        .ok()?
        .ok()?;
        Some(Self {
            stream: Mutex::new(connection),
            allowed,
            defer_exposure,
        })
    }

    async fn handshake(
        token: &str,
        port: u16,
        allowed: &[String],
        defer_exposure: bool,
    ) -> io::Result<Connection> {
        let stream = TcpStream::connect(("127.0.0.1", port)).await?;
        // Interactive request/response on loopback: Nagle would add latency to
        // every call for no batching benefit.
        stream.set_nodelay(true)?;
        let (read_half, mut writer) = stream.into_split();
        let mut reader = BufReader::new(read_half).lines();

        write_line(
            &mut writer,
            &Hello {
                protocol_version: PROTOCOL_VERSION,
                token: token.to_string(),
                allowed: allowed.to_vec(),
                defer_exposure,
            },
        )
        .await?;

        let line = reader
            .next_line()
            .await?
            .ok_or_else(|| io::Error::other("app closed the connection during handshake"))?;
        let ack: HelloAck = serde_json::from_str(&line).map_err(io::Error::other)?;
        if let Some(error) = ack.error {
            return Err(io::Error::other(error));
        }
        Ok(Connection { reader, writer })
    }

    /// Send one request and await its reply.
    ///
    /// # The fallback rule
    ///
    /// `Unreachable` is returned **only** when the request never left this
    /// process — i.e. the write itself failed, or a reconnect could not be
    /// established. Once bytes are on the wire, a broken connection comes back
    /// as `Remote`, not `Unreachable`.
    ///
    /// That asymmetry is deliberate and is the whole reason [`BridgeError`]
    /// has two variants. The caller's fallback for `Unreachable` is "run it
    /// against a local pool instead" — which is correct for a request that was
    /// never sent, and a data-corruption bug for one that was: if the app
    /// applied an `INSERT` and then died before replying, retrying locally
    /// writes the row twice. When we cannot tell whether a mutating call
    /// landed, the only safe answer is to report the failure.
    pub async fn call(&self, request: &BridgeRequest) -> Result<Value, BridgeError> {
        self.call_within(request, reply_wait(request)).await
    }

    /// [`Self::call`], waiting `wait` for the reply.
    async fn call_within(
        &self,
        request: &BridgeRequest,
        wait: Duration,
    ) -> Result<Value, BridgeError> {
        let mut guard = self.stream.lock().await;

        let payload = serde_json::to_vec(request)
            .map_err(|e| BridgeError::Unreachable(format!("could not encode request: {e}")))?;

        // Find out whether the app already hung up *before* sending anything.
        //
        // The reconnect below only runs when the write fails, and a write to a
        // socket whose peer has closed usually succeeds: the kernel accepts the
        // bytes, and the error only shows up on the next operation. So the
        // first call after the app restarted wrote into the old connection,
        // read EOF, and failed as `Remote` ("closed the connection before
        // answering") — once per app restart, on whatever the AI asked first.
        // The protocol never sends unsolicited lines, so a read side that is
        // ready before we have written anything can only be EOF, an error, or
        // a desync. Any of those means the connection is unusable, and since
        // nothing has been sent yet, replacing it is as safe as the reconnect
        // below.
        if connection_is_stale(&mut guard).await {
            match self.reconnect().await {
                Some(fresh) => *guard = fresh,
                None => {
                    return Err(BridgeError::Unreachable(
                        "the HuginnDB app closed the bridge connection (request not sent)".into(),
                    ))
                }
            }
        }

        // One reconnect attempt, but only for a request we have not sent yet:
        // an MCP client keeps a sidecar alive for days, across app restarts, so
        // the *first* call after the app came back would otherwise always fail.
        //
        // Why retrying is safe even for a write: the framing is
        // newline-delimited, and the newline is a *separate* write from the
        // payload. A failure therefore always leaves an incomplete line on the
        // wire, which the app can never parse into a request — so a failed send
        // provably did not execute, and re-sending cannot double-apply. If the
        // framing ever stops being newline-delimited, this reasoning goes with
        // it.
        if let Err(e) = write_payload(&mut guard.writer, &payload).await {
            let unsent = |e: std::io::Error| {
                BridgeError::Unreachable(format!(
                    "{e} (request not sent{})",
                    if request.is_mutating() {
                        "; the incomplete frame cannot have been executed"
                    } else {
                        ""
                    }
                ))
            };
            match self.reconnect().await {
                Some(fresh) => {
                    *guard = fresh;
                    if let Err(e) = write_payload(&mut guard.writer, &payload).await {
                        return Err(unsent(e));
                    }
                }
                None => return Err(unsent(e)),
            }
        }

        // From here on the request is in flight. Every failure is `Remote`.
        let line = match timeout(wait, guard.reader.next_line()).await {
            Err(_) => {
                // The app is still working on it, and will write its reply to
                // this connection when it is done. Left open, the next call
                // would be queued behind this one and read *that* reply as
                // its own — the result of a script for a SELECT, or a
                // success for a re-run that has not happened yet. Shutting the
                // write half makes the next call fail to send and reconnect
                // instead, which is safe because nothing of it was sent.
                let _ = guard.writer.shutdown().await;
                return Err(BridgeError::Remote(format!(
                    "the HuginnDB app did not answer within {} s; whether this call \
                     completed is unknown — check before running it again",
                    wait.as_secs()
                )));
            }
            Ok(Err(e)) => return Err(BridgeError::Remote(e.to_string())),
            Ok(Ok(None)) => {
                return Err(BridgeError::Remote(
                    "the HuginnDB app closed the connection before answering".into(),
                ))
            }
            Ok(Ok(Some(line))) => line,
        };

        let response: BridgeResponse = serde_json::from_str(&line)
            .map_err(|e| BridgeError::Remote(format!("malformed reply: {e}")))?;
        match (response.ok, response.err) {
            (Some(wrapper), _) => Ok(wrapper.value),
            (None, Some(err)) => Err(BridgeError::Remote(err)),
            (None, None) => Err(BridgeError::Remote("empty reply".into())),
        }
    }

    /// Re-read the discovery file and dial again — the app may have restarted
    /// on a different port with a different token since we attached.
    async fn reconnect(&self) -> Option<Connection> {
        let discovery = read_discovery()?;
        timeout(
            CONNECT_TIMEOUT,
            Self::handshake(
                &discovery.token,
                discovery.port,
                &self.allowed,
                self.defer_exposure,
            ),
        )
        .await
        .ok()?
        .ok()
    }
}

/// Whether the read side of an idle connection already has something on it,
/// which in a strictly request-then-reply protocol means it is dead.
///
/// A zero-length timeout still polls the read once — `tokio::time::timeout`
/// polls its future before it looks at the deadline — so this is a
/// non-blocking peek, not a wait. `Lines::next_line` is cancellation-safe, so
/// abandoning the pending read leaves the stream intact.
async fn connection_is_stale(connection: &mut Connection) -> bool {
    // `Err` is the timeout firing: still pending, nothing to read, so the
    // connection is idle and alive. Anything that *resolved* is the problem.
    timeout(Duration::ZERO, connection.reader.next_line())
        .await
        .is_ok()
}

/// The sidecar's link to the desktop app: attached at startup, or later.
///
/// A sidecar used to try once, at startup, and keep the answer for life. MCP
/// clients keep sidecars running for days — on one machine, twelve of thirteen
/// live sidecars had been started before the app currently running — so any
/// session that began while the app was closed opened pools of its own for as
/// long as it lived, however long the app had been back. Now a sidecar with no
/// bridge tries again when it is next used, at most every [`ATTACH_RETRY`].
/// Once attached it stays attached: [`BridgeClient::call`] already survives the
/// app restarting.
pub struct BridgeSlot {
    client: std::sync::OnceLock<std::sync::Arc<BridgeClient>>,
    last_attempt: parking_lot::Mutex<Option<std::time::Instant>>,
    allowed: Vec<String>,
    defer_exposure: bool,
    /// `false` for a slot that must never attach — see [`Self::never`].
    enabled: bool,
}

/// How often a sidecar with no bridge looks for one again.
///
/// Cheap when there is no app (a missing discovery file is a failed file
/// read; a stale one is a refused loopback connect) but not free when the app
/// is wedged ([`CONNECT_TIMEOUT`]), and a tool call should not pay that every
/// time.
pub const ATTACH_RETRY: Duration = Duration::from_secs(30);

impl BridgeSlot {
    /// Try to attach now; whether it worked or not, the slot keeps trying later.
    pub async fn new(allowed: Vec<String>, defer_exposure: bool) -> Self {
        let slot = Self {
            client: std::sync::OnceLock::new(),
            last_attempt: parking_lot::Mutex::new(None),
            allowed,
            defer_exposure,
            enabled: true,
        };
        let _ = slot.get().await;
        slot
    }

    /// A slot that never attaches: the local path, unconditionally.
    ///
    /// For the tests that exercise that path. A slot that merely had not
    /// attached *yet* would look for the discovery file on its first call — and
    /// on a developer's machine with the app open, find it, and send the test's
    /// requests to their real app.
    #[cfg(test)]
    pub fn never() -> Self {
        Self {
            client: std::sync::OnceLock::new(),
            last_attempt: parking_lot::Mutex::new(None),
            allowed: Vec::new(),
            defer_exposure: false,
            enabled: false,
        }
    }

    /// The bridge, attaching first if it is time to try again.
    pub async fn get(&self) -> Option<std::sync::Arc<BridgeClient>> {
        if let Some(client) = self.client.get() {
            return Some(client.clone());
        }
        if !self.enabled {
            return None;
        }
        {
            let mut last = self.last_attempt.lock();
            if last.is_some_and(|at| at.elapsed() < ATTACH_RETRY) {
                return None;
            }
            *last = Some(std::time::Instant::now());
        }
        let client = BridgeClient::connect(self.allowed.clone(), self.defer_exposure).await?;
        // Two calls racing to attach both connected; keep whichever landed
        // first and let the other connection drop.
        let attached = self
            .client
            .get_or_init(|| std::sync::Arc::new(client))
            .clone();
        eprintln!(
            "[huginndb-mcp] attached to the running HuginnDB app: it owns the connection pools, \
             and this session's activity appears in its Console"
        );
        Some(attached)
    }
}

async fn write_line<T: serde::Serialize>(writer: &mut OwnedWriteHalf, value: &T) -> io::Result<()> {
    let payload = serde_json::to_vec(value).map_err(io::Error::other)?;
    write_payload(writer, &payload).await
}

async fn write_payload(writer: &mut OwnedWriteHalf, payload: &[u8]) -> io::Result<()> {
    writer.write_all(payload).await?;
    writer.write_all(b"\n").await?;
    // Explicit flush: `OwnedWriteHalf` is unbuffered today, but a caller
    // blocking on a reply that is sitting in a buffer is a deadlock that costs
    // nothing to rule out.
    writer.flush().await
}

#[cfg(test)]
impl BridgeClient {
    /// Attach to an app listening on `port` with `token`, bypassing the
    /// discovery file — for tests that stand up a fake app.
    pub(crate) async fn connect_to_for_test(port: u16, token: &str) -> Self {
        Self {
            stream: Mutex::new(Self::handshake(token, port, &[], true).await.unwrap()),
            allowed: Vec::new(),
            defer_exposure: true,
        }
    }
}

#[cfg(test)]
impl BridgeSlot {
    /// A slot already attached to `client`, which never looks for another.
    pub(crate) fn attached_for_test(client: BridgeClient) -> Self {
        let slot = Self::never();
        let _ = slot.client.set(std::sync::Arc::new(client));
        slot
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use crate::bridge::protocol::HelloAck;
    use tokio::net::TcpListener;

    /// What a fake app does once it has accepted the handshake.
    pub(crate) enum AfterHello {
        /// Hold the connection open and say nothing, like an idle healthy app.
        Idle,
        /// Close the connection, like an app that quit.
        Quit,
        /// Send a line nobody asked for, which the protocol never does.
        Babble,
        /// Answer each request, but the first one only after this long —
        /// like an app still running a long script when the client gives up.
        SlowFirst(Duration),
    }

    /// A one-connection stand-in for the desktop app's bridge server. Returns
    /// its port; the task ends when the connection does.
    pub(crate) async fn fake_app(after: AfterHello) -> u16 {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (read_half, mut writer) = stream.into_split();
            let mut reader = BufReader::new(read_half).lines();
            let _hello = reader.next_line().await.unwrap();
            write_line(
                &mut writer,
                &HelloAck {
                    protocol_version: PROTOCOL_VERSION,
                    error: None,
                },
            )
            .await
            .unwrap();
            match after {
                AfterHello::Idle => {
                    // Keep both halves alive until the client hangs up.
                    let _ = reader.next_line().await;
                }
                AfterHello::Quit => drop((reader, writer)),
                AfterHello::Babble => {
                    writer.write_all(b"{\"unsolicited\":true}\n").await.unwrap();
                    let _ = reader.next_line().await;
                }
                AfterHello::SlowFirst(delay) => {
                    let mut n = 0;
                    while let Ok(Some(_)) = reader.next_line().await {
                        if n == 0 {
                            tokio::time::sleep(delay).await;
                        }
                        let reply = crate::bridge::protocol::BridgeResponse::ok(serde_json::json!(
                            format!("reply to request {n}")
                        ));
                        if write_line(&mut writer, &reply).await.is_err() {
                            return;
                        }
                        n += 1;
                    }
                }
            }
        });
        port
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::{fake_app, AfterHello};
    use super::*;

    async fn connected(after: AfterHello) -> Connection {
        let port = fake_app(after).await;
        BridgeClient::handshake("t", port, &[], true).await.unwrap()
    }

    #[tokio::test]
    async fn an_idle_live_connection_is_not_stale() {
        let mut c = connected(AfterHello::Idle).await;
        assert!(!connection_is_stale(&mut c).await);
        // And the peek consumed nothing: asking again gives the same answer.
        assert!(!connection_is_stale(&mut c).await);
    }

    /// The case that made the first call after an app restart fail: the write
    /// into the dead connection succeeds, and only the read finds out.
    #[tokio::test]
    async fn a_connection_the_app_closed_is_stale_before_anything_is_written() {
        let mut c = connected(AfterHello::Quit).await;
        // Give the FIN a moment to land.
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(connection_is_stale(&mut c).await);
    }

    #[tokio::test]
    async fn an_unsolicited_line_means_the_connection_cannot_be_trusted() {
        let mut c = connected(AfterHello::Babble).await;
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(connection_is_stale(&mut c).await);
    }

    /// With the app gone and no discovery file to find another, the call must
    /// come back `Unreachable` — "never sent" — which is what licenses the
    /// caller to fall back to a local pool.
    #[tokio::test]
    async fn a_call_to_an_app_that_quit_is_unreachable_not_remote() {
        let port = fake_app(AfterHello::Quit).await;
        let client = BridgeClient::connect_to_for_test(port, "t").await;
        tokio::time::sleep(Duration::from_millis(50)).await;
        // `reconnect` reads the real discovery file; on a machine with the app
        // running it would find it and this test would talk to that app.
        // Skip rather than send a request to someone's real HuginnDB.
        if crate::bridge::read_discovery().is_some() {
            eprintln!("skipped: a real HuginnDB bridge is published on this machine");
            return;
        }
        let err = client
            .call(&BridgeRequest::IsMongo {
                connection_id: "p".into(),
            })
            .await
            .expect_err("nobody is there to answer");
        assert!(matches!(err, BridgeError::Unreachable(_)), "{err:?}");
    }

    /// The bug a timed-out call used to leave behind: the app kept working on
    /// it, the next call was queued behind it on the same connection, and read
    /// its reply as its own.
    #[tokio::test]
    async fn a_reply_that_comes_after_the_wait_is_never_read_as_the_next_one() {
        let port = fake_app(AfterHello::SlowFirst(Duration::from_millis(400))).await;
        let client = BridgeClient::connect_to_for_test(port, "t").await;
        // The next call reconnects through the real discovery file; skip
        // rather than send a request to someone's real HuginnDB.
        if crate::bridge::read_discovery().is_some() {
            eprintln!("skipped: a real HuginnDB bridge is published on this machine");
            return;
        }
        let request = BridgeRequest::IsMongo {
            connection_id: "p".into(),
        };
        let first = client
            .call_within(&request, Duration::from_millis(50))
            .await
            .expect_err("the app is still busy");
        assert!(
            matches!(&first, BridgeError::Remote(m) if m.contains("unknown")),
            "{first:?}"
        );
        // Before and after the late reply lands: either way the next call
        // must not come back with it.
        for _ in 0..2 {
            match client.call(&request).await {
                Ok(v) => panic!("read a reply that was not this call's: {v}"),
                Err(e) => assert!(matches!(e, BridgeError::Unreachable(_)), "{e:?}"),
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }

    #[test]
    fn a_long_call_waits_past_the_point_the_app_has_answered() {
        let script = |timeout_secs| BridgeRequest::RunScript {
            connection_id: "c".into(),
            policy_id: "c".into(),
            sql: "SELECT 1".into(),
            transaction: true,
            max_rows: 1,
            timeout_secs,
        };
        assert_eq!(reply_wait(&script(None)), Duration::from_secs(720));
        assert_eq!(reply_wait(&script(Some(5))), CALL_TIMEOUT);
        assert_eq!(
            reply_wait(&script(Some(3600))),
            Duration::from_secs(2 * 3600 + 120)
        );
        assert_eq!(
            reply_wait(&BridgeRequest::IsMongo {
                connection_id: "c".into()
            }),
            CALL_TIMEOUT
        );
    }

    #[tokio::test]
    async fn a_slot_that_must_never_attach_never_does() {
        assert!(BridgeSlot::never().get().await.is_none());
    }
}
