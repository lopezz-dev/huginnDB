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
//!
//! ### Host certificates
//!
//! Since `russh` 0.65 the server may prove its identity with an OpenSSH host
//! certificate instead of a bare key — but only if the client advertises the
//! `*-cert-v01@openssh.com` algorithms, and we never do ([`client_config`]).
//! A server configured with `HostCertificate` therefore presents its bare key
//! to us, exactly as before, and every stored fingerprint keeps matching.
//!
//! Should a certificate arrive anyway, it is pinned by the key *inside* it
//! ([`pinned_fingerprint`]): the same fingerprint the bare key has, and the
//! same guarantee, because that key is what signs the key exchange. The
//! certificate's own signature is not trusted — no certificate authority is
//! configured here — which is what OpenSSH does for a host it has no
//! `@cert-authority` line for. See ADR #117.

use crate::error::{AppError, AppResult};
use crate::ssh_known_hosts::{self, SharedKnownHosts};
use crate::state::{HostKeyPolicy, SshAuth, SshTunnel};
use parking_lot::Mutex;
use russh::client::{self, Handle};
use russh::keys::ssh_key::HashAlg;
use russh::keys::{load_secret_key, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh::Preferred;
use std::borrow::Cow;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::io::copy_bidirectional;
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

/// Wrap any `russh` error into [`AppError::Ssh`].
fn ssh_err(label: &str, e: impl std::fmt::Display) -> AppError {
    AppError::Ssh(format!("{label}: {e}"))
}

/// The signature hashes to offer an RSA key with, in order, given what the
/// server advertised in `server-sig-algs` (RFC 8308) — the answer of
/// [`Handle::best_supported_rsa_hash`]. For a key that is not RSA the hash is
/// ignored, and the caller passes `Some(None)`.
///
/// `russh` maps a missing hash to `ssh-rsa`, which signs with SHA-1, and that
/// is what an RSA key used to sign with here no matter the server. OpenSSH
/// 8.8 and later refuse it by default (`signature algorithm ssh-rsa not in
/// PubkeyAcceptedAlgorithms`), so an RSA key could not log in to any current
/// server (gotcha #115). The OpenSSH client asks the server instead, and so
/// does this:
///
/// * the server named its best RSA hash → that one alone. If it is `None`,
///   the server takes nothing but `ssh-rsa`, and SHA-1 is the only way in;
/// * the server sent no `server-sig-algs` (one older than OpenSSH 7.2, or one
///   that never implemented RFC 8308) → SHA-512, then SHA-256, then SHA-1 as
///   a last resort. Each refusal is one failed attempt against the server's
///   `MaxAuthTries` (six by default in OpenSSH), well inside the budget.
///
/// SHA-1 is never tried while a SHA-2 hash is known to work, so a server
/// that accepts both is always signed for with SHA-2.
fn signature_hashes(advertised: Option<Option<HashAlg>>) -> Vec<Option<HashAlg>> {
    match advertised {
        Some(best) => vec![best],
        None => vec![Some(HashAlg::Sha512), Some(HashAlg::Sha256), None],
    }
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
    /// The server proved its identity with a certificate rather than a bare
    /// key — so a test can tell it exercised that arm.
    #[cfg(test)]
    certificate_presented: bool,
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

/// The fingerprint a server's host key is pinned by in
/// [`crate::ssh_known_hosts`]: OpenSSH-style `SHA256:<base64>`, stable across
/// crate versions because it is the on-wire fingerprint format.
///
/// A certificate is pinned by the key it certifies, so a host that starts
/// presenting one keeps the fingerprint its bare key was trusted under. Its
/// authority is not consulted (see "Host certificates" in the module docs).
fn pinned_fingerprint(server_key: &PublicKeyOrCertificate) -> String {
    server_key
        .public_key()
        .fingerprint(HashAlg::Sha256)
        .to_string()
}

/// The `russh` client configuration every tunnel dials with.
fn client_config() -> client::Config {
    client::Config {
        keepalive_interval: Some(SSH_KEEPALIVE_INTERVAL),
        keepalive_max: SSH_KEEPALIVE_MAX,
        // `russh` leaves Nagle's algorithm on by default. A database
        // conversation is small writes waiting on small answers — exactly
        // the traffic Nagle holds back until the previous segment is
        // acknowledged, and the peer's delayed ACK can take tens of
        // milliseconds to come. See `accept_loop` for the other half.
        nodelay: true,
        preferred: Preferred {
            // Never ask for a host certificate. `russh` advertises none by
            // default; this keeps it so should that default change, because
            // a server holding one would then present it instead of the bare
            // key it was trusted under (ADR #117).
            host_key_certificates: Cow::Borrowed(&[]),
            ..Preferred::DEFAULT
        },
        ..client::Config::default()
    }
}

impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let fp = pinned_fingerprint(server_key);
        #[cfg(test)]
        {
            self.outcome.lock().certificate_presented = server_key.certificate().is_some();
        }

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

        let config = Arc::new(client_config());
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
                    .success()
            }
            SshAuth::Key { path } => {
                let passphrase = self.secret.clone().filter(|s| !s.is_empty());
                let key = load_secret_key(PathBuf::from(path), passphrase.as_deref())
                    .map_err(|e| ssh_err("load-key", e))?;
                let key = Arc::new(key);
                // Only an RSA key has a choice of signature hash, and asking
                // the server waits up to a second for its EXT_INFO — not a
                // wait to impose on an Ed25519 or ECDSA key for nothing.
                let advertised = if key.algorithm().is_rsa() {
                    session
                        .best_supported_rsa_hash()
                        .await
                        .map_err(|e| ssh_err("auth-publickey", e))?
                } else {
                    Some(None)
                };
                let mut accepted = false;
                for hash in signature_hashes(advertised) {
                    accepted = session
                        .authenticate_publickey(
                            &tunnel.username,
                            PrivateKeyWithHashAlg::new(key.clone(), hash),
                        )
                        .await
                        .map_err(|e| ssh_err("auth-publickey", e))?
                        .success();
                    if accepted {
                        break;
                    }
                }
                accepted
            }
        };
        if !authenticated {
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
    /// Read and written only while `current` is held.
    backoff: Mutex<Backoff>,
}

/// Wait after the first failed redial; each further failure doubles it.
const REDIAL_BACKOFF_BASE: std::time::Duration = std::time::Duration::from_secs(5);

/// Longest wait between redials of a tunnel whose server keeps failing them.
///
/// Five minutes: long enough that a server which bans an address for repeated
/// logins (fail2ban, an `iptables recent` rule) sees a handful of attempts an
/// hour instead of one per query, short enough that a bastion that comes back
/// is found again within a coffee break without anyone clicking Reconnect.
const REDIAL_BACKOFF_MAX: std::time::Duration = std::time::Duration::from_secs(300);

/// When a tunnel whose redial failed may try again.
///
/// Without it every connection through a dead tunnel dialled the bastion: the
/// heartbeat's retries and then one every 30 s, Pulse once a minute, MongoDB's
/// monitor every 10 s — every 0.5 s while a query waited — and each click. A
/// connection queued behind a failing dial dialled again the moment it got the
/// lock. Against a server that refuses or bans, that kept knocking for as long
/// as the connection stayed open in the app, and a ban that counts attempts
/// never expired. Now one dial fails, and until the backoff runs out every
/// other channel fails at once, without touching the network.
#[derive(Debug, Default)]
struct Backoff {
    failures: u32,
    until: Option<std::time::Instant>,
    last_error: String,
}

impl Backoff {
    /// The wait after `failures` consecutive failed redials.
    fn delay(failures: u32) -> std::time::Duration {
        let doublings = failures.saturating_sub(1).min(16);
        REDIAL_BACKOFF_BASE
            .saturating_mul(1 << doublings)
            .min(REDIAL_BACKOFF_MAX)
    }

    /// How long until a redial may be attempted, if one may not be yet.
    fn remaining(&self, now: std::time::Instant) -> Option<std::time::Duration> {
        self.until
            .filter(|until| *until > now)
            .map(|until| until - now)
    }

    /// Record a failed redial and return the wait it earned.
    fn failed(&mut self, now: std::time::Instant, error: &AppError) -> std::time::Duration {
        self.failures = self.failures.saturating_add(1);
        let wait = Self::delay(self.failures);
        self.until = Some(now + wait);
        self.last_error = error.to_string();
        wait
    }

    fn succeeded(&mut self) {
        *self = Self::default();
    }
}

impl TunnelSession {
    /// Open a `direct-tcpip` channel, dialling a fresh session first when the
    /// current one is gone.
    ///
    /// Only a *dead* session is redialled. A channel the server refuses on a
    /// live session (the remote port is closed, `AllowTcpForwarding no`) is a
    /// real answer and is returned as the error; dialling again would only get
    /// the same answer more slowly.
    ///
    /// **One session per tunnel, always.** A channel that does not open in
    /// [`CHANNEL_OPEN_TIMEOUT`] used to be enough to dial a second session, but
    /// a slow channel is not a dead session: a bastion under load, or one whose
    /// forwarding target is slow to accept, answers late on a session that is
    /// perfectly alive. The session is now asked directly ([`answers_ping`])
    /// and only one that does not answer is replaced. And a replaced session
    /// is now closed: it used to be dropped, which in `russh` closes nothing
    /// while a channel on it is still open — a pooled database connection
    /// keeps its channel for up to [`crate::db::pool::MAX_LIFETIME`], MongoDB's
    /// monitor for as long as the client lives — so every redial against a
    /// slow bastion left one more session counting against its limit.
    async fn channel(
        &self,
        remote_host: &str,
        remote_port: u16,
        local_port: u16,
    ) -> AppResult<russh::Channel<client::Msg>> {
        let session = self.current.lock().await.clone();
        if !session.is_closed() {
            let failure = match open_channel(&session, remote_host, remote_port, local_port).await {
                Ok(channel) => return Ok(channel),
                Err(failure) => failure,
            };
            let answered = match failure {
                // Only a channel that never answered needs the question asked.
                ChannelError::TimedOut if !session.is_closed() => answers_ping(&session).await,
                _ => false,
            };
            match verdict(&failure, session.is_closed(), answered) {
                Verdict::Report => return Err(failure.into_app()),
                Verdict::Slow => {
                    return Err(AppError::Ssh(format!(
                        "open-channel: the SSH server {}:{} is up but did not open a channel to \
                         {remote_host}:{remote_port} within {}s",
                        self.dialer.tunnel.host,
                        self.dialer.tunnel.port,
                        CHANNEL_OPEN_TIMEOUT.as_secs()
                    )))
                }
                Verdict::Redial => {}
            }
        }

        let mut current = self.current.lock().await;
        // Someone else may have redialled while we waited for the lock.
        if Arc::ptr_eq(&current, &session) {
            let (host, port) = (&self.dialer.tunnel.host, self.dialer.tunnel.port);
            // A redial failed a moment ago: fail now, without dialling. Checked
            // under the lock, so the connections queued behind a failing dial
            // fail with it instead of each dialling in turn.
            let pending = {
                let backoff = self.backoff.lock();
                backoff
                    .remaining(std::time::Instant::now())
                    .map(|wait| (wait, backoff.last_error.clone()))
            };
            if let Some((wait, last)) = pending {
                return Err(AppError::Ssh(format!(
                    "the SSH session to {host}:{port} is down and reconnecting failed ({last}); \
                     next attempt in {}s",
                    wait.as_secs().max(1)
                )));
            }
            eprintln!("[ssh] session to {host}:{port} is gone; reconnecting");
            // Closed before the new one is dialled, not after: if the server
            // still counts it, a limit on concurrent sessions has room for the
            // replacement. On a session that is already gone this is a no-op.
            retire(&current).await;
            match self.dialer.dial().await {
                Ok(fresh) => {
                    self.backoff.lock().succeeded();
                    *current = Arc::new(fresh);
                }
                Err(e) => {
                    let wait = self.backoff.lock().failed(std::time::Instant::now(), &e);
                    eprintln!(
                        "[ssh] reconnecting to {host}:{port} failed ({e}); next attempt in {}s",
                        wait.as_secs()
                    );
                    return Err(e);
                }
            }
        }
        let session = current.clone();
        drop(current);
        open_channel(&session, remote_host, remote_port, local_port)
            .await
            .map_err(ChannelError::into_app)
    }
}

/// What [`TunnelSession::channel`] does about a channel that did not open.
#[derive(Debug, PartialEq, Eq)]
enum Verdict {
    /// The server refused the channel on a live session: its answer, returned
    /// as is. Dialling again would only get the same answer more slowly.
    Report,
    /// The channel never opened but the session answers a ping: the server is
    /// slow, not gone. Reported, never redialled — a second session would add
    /// to the load and to the count of a server that is already struggling.
    Slow,
    /// The session is gone: closed under us, or silent to a ping as well.
    Redial,
}

/// The decision, kept pure so the table is testable without an SSH server.
fn verdict(failure: &ChannelError, closed: bool, answered_ping: bool) -> Verdict {
    match failure {
        _ if closed => Verdict::Redial,
        ChannelError::Refused(_) => Verdict::Report,
        ChannelError::TimedOut if answered_ping => Verdict::Slow,
        ChannelError::TimedOut => Verdict::Redial,
    }
}

/// How long a session suspected dead has to answer a ping.
///
/// Asked only after a channel open has already waited out
/// [`CHANNEL_OPEN_TIMEOUT`], so this is the extra cost of telling "slow" from
/// "gone" before a redial. A live session answers in one round trip.
const PING_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// Whether `session` is alive: it answers a ping, and is still open after.
///
/// `send_ping` resolves on the server's reply, including the
/// `SSH_MSG_REQUEST_FAILURE` OpenSSH sends for a keepalive request — but it
/// also resolves, quietly, if the session ends while waiting, hence the
/// `is_closed` check after it.
async fn answers_ping(session: &Handle<Client>) -> bool {
    matches!(
        tokio::time::timeout(PING_TIMEOUT, session.send_ping()).await,
        Ok(Ok(()))
    ) && !session.is_closed()
}

/// Upper bound on handing a session its disconnect. The message only has to
/// reach the session's own task, which writes it and ends; a task that cannot
/// take it within this is past saving and will end with its socket anyway.
const RETIRE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

/// Close a session being replaced, channels and all.
///
/// Dropping the handle is not enough: `russh` ends a session when its handle
/// *and every channel* opened on it are gone, and a channel lives as long as
/// the pooled connection riding it. `SSH_MSG_DISCONNECT` ends it now, so the
/// server stops counting it now. Connections still riding it fail and are
/// replaced by their pools through the new session — they were riding a
/// session we had already given up on.
async fn retire(session: &Handle<Client>) {
    let _ = tokio::time::timeout(
        RETIRE_TIMEOUT,
        session.disconnect(
            russh::Disconnect::ByApplication,
            "replaced by a new session",
            "en",
        ),
    )
    .await;
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
        backoff: Mutex::new(Backoff::default()),
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
    use russh::server::{self, Auth};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// An RSA key used to sign with `ssh-rsa` (SHA-1) whatever the server
    /// said, which OpenSSH 8.8+ refuses by default.
    #[test]
    fn an_rsa_key_signs_with_sha2_unless_the_server_takes_nothing_else() {
        // The server named its best hash: that one, and nothing weaker.
        assert_eq!(
            signature_hashes(Some(Some(HashAlg::Sha512))),
            vec![Some(HashAlg::Sha512)]
        );
        assert_eq!(
            signature_hashes(Some(Some(HashAlg::Sha256))),
            vec![Some(HashAlg::Sha256)]
        );
        // The server takes only `ssh-rsa`: SHA-1 is the only way in.
        assert_eq!(signature_hashes(Some(None)), vec![None]);
        // The server did not say: strongest first, SHA-1 last.
        assert_eq!(
            signature_hashes(None),
            vec![Some(HashAlg::Sha512), Some(HashAlg::Sha256), None]
        );
    }

    #[test]
    fn only_a_session_that_is_gone_is_redialled() {
        let refused = || ChannelError::Refused(AppError::Ssh("administratively prohibited".into()));
        // The server said no on a live session: its answer, not a redial.
        assert_eq!(verdict(&refused(), false, false), Verdict::Report);
        // A slow channel on a session that answers a ping: slow, not gone.
        assert_eq!(verdict(&ChannelError::TimedOut, false, true), Verdict::Slow);
        // Silent to the channel and to the ping: gone.
        assert_eq!(
            verdict(&ChannelError::TimedOut, false, false),
            Verdict::Redial
        );
        // Closed under us, whatever the channel said.
        assert_eq!(verdict(&refused(), true, false), Verdict::Redial);
        assert_eq!(
            verdict(&ChannelError::TimedOut, true, true),
            Verdict::Redial
        );
    }

    /// Throwaway host key for the in-process bastion below. Generated for this
    /// test with `ssh-keygen -t ed25519 -N ""`; it guards nothing.
    const TEST_HOST_KEY: &str = "-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACBFkhDXVHVxBY2Lq6uttRuneDzRuqu1wqwpP5niwBH08gAAAJgN86qNDfOq
jQAAAAtzc2gtZWQyNTUxOQAAACBFkhDXVHVxBY2Lq6uttRuneDzRuqu1wqwpP5niwBH08g
AAAEBV/5ZmRKBjAklL1FiZULZi3LH5rPONK0LklzJJdjvUcEWSENdUdXEFjYurq621G6d4
PNG6q7XCrCk/meLAEfTyAAAAFWh1Z2lubmRiLXRlc3QtYmFzdGlvbg==
-----END OPENSSH PRIVATE KEY-----
";

    /// [`TEST_HOST_KEY`] certified as a host key by a throwaway CA
    /// (`ssh-keygen -s ca -I huginndb-test-bastion -h -n 127.0.0.1`), valid
    /// forever. It guards nothing either.
    const TEST_HOST_CERT: &str = "ssh-ed25519-cert-v01@openssh.com AAAAIHNzaC1lZDI1NTE5LWNlcnQtdjAxQG9wZW5zc2guY29tAAAAIO1i7WZXKfGu+of2alHk0ruQjH+72+YKweg7Cxk6hakxAAAAIEWSENdUdXEFjYurq621G6d4PNG6q7XCrCk/meLAEfTyAAAAAAAAAAAAAAACAAAAFWh1Z2lubmRiLXRlc3QtYmFzdGlvbgAAAA0AAAAJMTI3LjAuMC4xAAAAAAAAAAD//////////wAAAAAAAAAAAAAAAAAAADMAAAALc3NoLWVkMjU1MTkAAAAg1ncTwf7aM61FIdGLx9tbkov52zhWddzGRJh+mvMgz0sAAABTAAAAC3NzaC1lZDI1NTE5AAAAQHkHGaIZH91h8aGP3+74TZWIuBTN9T/luc4Veimvpbl6UFYcdKu2IJW44l/FnTzL0e9bizlQYEz+CgiGp2EZYAU= huginndb-test-bastion";

    fn test_host_key() -> russh::keys::PrivateKey {
        russh::keys::decode_secret_key(TEST_HOST_KEY, None).unwrap()
    }

    fn test_host_cert() -> russh::keys::Certificate {
        russh::keys::Certificate::from_openssh(TEST_HOST_CERT).unwrap()
    }

    /// The fingerprint of [`TEST_HOST_KEY`] as the bare key a server presents.
    fn bare_key_fingerprint() -> String {
        pinned_fingerprint(&test_host_key().public_key().clone().into())
    }

    /// A user who trusted a host by its bare key must not see "host key
    /// changed" the day it presents a certificate for that same key.
    #[test]
    fn a_host_certificate_is_pinned_by_the_key_it_certifies() {
        let presented: PublicKeyOrCertificate = test_host_cert().into();
        assert_eq!(pinned_fingerprint(&presented), bare_key_fingerprint());
        // Nor is the authority that signed it ever what gets pinned.
        assert_ne!(
            pinned_fingerprint(&presented),
            test_host_cert()
                .signature_key()
                .fingerprint(HashAlg::Sha256)
                .to_string()
        );
    }

    /// The tunnel never asks for a host certificate, so a server holding one
    /// presents the bare key every stored fingerprint was taken from.
    #[test]
    fn the_tunnel_never_advertises_host_certificate_algorithms() {
        assert!(client_config().preferred.host_key_certificates.is_empty());
    }

    /// An in-process server holding [`TEST_HOST_CERT`]; returns its port.
    async fn certified_server() -> u16 {
        let config = Arc::new(server::Config {
            keys: vec![test_host_key()],
            certificates: vec![test_host_cert()],
            auth_rejection_time: Duration::from_millis(0),
            ..Default::default()
        });
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((socket, _)) = listener.accept().await {
                let handler = BastionSession {
                    seen: Default::default(),
                    forward_to: 1,
                    authenticated: false,
                };
                let config = config.clone();
                tokio::spawn(async move {
                    if let Ok(running) = server::run_stream(config, socket, handler).await {
                        let _ = running.await;
                    }
                });
            }
        });
        port
    }

    /// Dial `port` with the tunnel's handler under `policy`, advertising host
    /// certificates when `ask_for_certificate` — which the tunnel never does,
    /// and is the only way to make a server present one.
    async fn handshake(
        port: u16,
        policy: HostKeyPolicy,
        store: SharedKnownHosts,
        ask_for_certificate: bool,
    ) -> (bool, Arc<Mutex<VerifyOutcome>>) {
        let outcome = Arc::new(Mutex::new(VerifyOutcome::default()));
        let handler = Client {
            policy,
            host_port: format!("127.0.0.1:{port}"),
            store,
            outcome: outcome.clone(),
        };
        let mut config = client_config();
        if ask_for_certificate {
            config.preferred.host_key_certificates =
                Cow::Owned(vec![russh::keys::Algorithm::Ed25519]);
        }
        let connected = client::connect(Arc::new(config), ("127.0.0.1", port), handler)
            .await
            .is_ok();
        (connected, outcome)
    }

    /// Both arms of the certificate decision against a server that holds one:
    /// as the tunnel dials, it presents the bare key; made to present the
    /// certificate, it is pinned by the same fingerprint, so a stored entry
    /// keeps matching, `Strict` still refuses a host it does not know, and
    /// `AcceptNew` stores what the bare key would have stored.
    #[tokio::test]
    async fn a_server_with_a_host_certificate_keeps_its_stored_fingerprint() {
        let port = certified_server().await;
        let host_port = format!("127.0.0.1:{port}");
        let trusted = || -> SharedKnownHosts {
            let store = SharedKnownHosts::default();
            store
                .write()
                .insert(host_port.clone(), bare_key_fingerprint());
            store
        };

        for ask_for_certificate in [false, true] {
            // Trusted before the certificate existed: still trusted.
            let (connected, outcome) =
                handshake(port, HostKeyPolicy::Strict, trusted(), ask_for_certificate).await;
            assert!(
                connected,
                "certificate asked for: {ask_for_certificate}; {:?}",
                outcome.lock().rejection
            );
            // The server presents its certificate only when asked for it.
            assert_eq!(outcome.lock().certificate_presented, ask_for_certificate);

            // Unknown to a strict policy: refused.
            let (connected, outcome) = handshake(
                port,
                HostKeyPolicy::Strict,
                Default::default(),
                ask_for_certificate,
            )
            .await;
            assert!(!connected);
            assert!(outcome.lock().rejection.is_some());

            // Trusted on first use: by the bare key's fingerprint.
            let store = SharedKnownHosts::default();
            let (connected, outcome) = handshake(
                port,
                HostKeyPolicy::AcceptNew,
                store.clone(),
                ask_for_certificate,
            )
            .await;
            assert!(connected);
            assert!(outcome.lock().persisted_new);
            assert_eq!(
                store.read().get(&host_port).cloned(),
                Some(bare_key_fingerprint())
            );
        }
    }

    /// What the in-process bastion has seen: how many logins it accepted, and
    /// how many of those sessions are still alive — the number a server-side
    /// limit on SSH sessions counts.
    #[derive(Default)]
    struct Seen {
        logins: AtomicUsize,
        live: AtomicUsize,
        /// Stall the next `direct-tcpip` open for [`STALL`]. The stall holds
        /// the server's session loop, so the session also stops answering
        /// pings — which is what a session the network dropped looks like from
        /// the client.
        stall_next: AtomicBool,
        /// Every password login attempted, accepted or not: what a rule that
        /// bans an address for repeated logins counts.
        attempts: AtomicUsize,
        /// Reject every login while set — a bastion that has banned us.
        refuse_logins: AtomicBool,
        /// The server side of every session, so a test can end them.
        sessions: parking_lot::Mutex<Vec<server::Handle>>,
    }

    impl Seen {
        /// End every session from the server side, as a bastion restart or a
        /// firewall reset would.
        async fn drop_every_session(&self) {
            let sessions: Vec<_> = self.sessions.lock().drain(..).collect();
            for session in sessions {
                let _ = session
                    .disconnect(
                        russh::Disconnect::ByApplication,
                        "going away".into(),
                        "en".into(),
                    )
                    .await;
            }
        }
    }

    /// Longer than [`CHANNEL_OPEN_TIMEOUT`] plus [`PING_TIMEOUT`], so the
    /// client has given the session up by the time the stall ends.
    const STALL: Duration = Duration::from_secs(16);

    struct BastionSession {
        seen: Arc<Seen>,
        forward_to: u16,
        authenticated: bool,
    }

    impl Drop for BastionSession {
        fn drop(&mut self) {
            if self.authenticated {
                self.seen.live.fetch_sub(1, Ordering::SeqCst);
            }
        }
    }

    impl server::Handler for BastionSession {
        type Error = russh::Error;

        async fn auth_password(
            &mut self,
            _user: &str,
            _password: &str,
        ) -> Result<Auth, Self::Error> {
            self.seen.attempts.fetch_add(1, Ordering::SeqCst);
            if self.seen.refuse_logins.load(Ordering::SeqCst) {
                return Ok(Auth::reject());
            }
            self.authenticated = true;
            self.seen.logins.fetch_add(1, Ordering::SeqCst);
            self.seen.live.fetch_add(1, Ordering::SeqCst);
            Ok(Auth::Accept)
        }

        async fn channel_open_direct_tcpip(
            &mut self,
            channel: russh::Channel<server::Msg>,
            _host_to_connect: &str,
            _port_to_connect: u32,
            _originator_address: &str,
            _originator_port: u32,
            reply: server::ChannelOpenHandle,
            _session: &mut server::Session,
        ) -> Result<(), Self::Error> {
            if self.seen.stall_next.swap(false, Ordering::SeqCst) {
                tokio::time::sleep(STALL).await;
            }
            reply.accept().await;
            let port = self.forward_to;
            tokio::spawn(async move {
                if let Ok(mut upstream) = tokio::net::TcpStream::connect(("127.0.0.1", port)).await
                {
                    let mut stream = channel.into_stream();
                    let _ = copy_bidirectional(&mut stream, &mut upstream).await;
                }
            });
            Ok(())
        }
    }

    /// An echo server standing in for the database, and an SSH bastion in
    /// front of it. Returns the bastion's port and what it has seen.
    async fn bastion() -> (u16, Arc<Seen>) {
        let echo = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let echo_port = echo.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = echo.accept().await {
                tokio::spawn(async move {
                    let (mut r, mut w) = socket.split();
                    let _ = tokio::io::copy(&mut r, &mut w).await;
                });
            }
        });

        let config = Arc::new(server::Config {
            keys: vec![test_host_key()],
            auth_rejection_time: Duration::from_millis(0),
            ..Default::default()
        });
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(Seen::default());
        let for_server = seen.clone();
        tokio::spawn(async move {
            while let Ok((socket, _)) = listener.accept().await {
                let handler = BastionSession {
                    seen: for_server.clone(),
                    forward_to: echo_port,
                    authenticated: false,
                };
                let config = config.clone();
                let seen = for_server.clone();
                tokio::spawn(async move {
                    if let Ok(running) = server::run_stream(config, socket, handler).await {
                        seen.sessions.lock().push(running.handle());
                        let _ = running.await;
                    }
                });
            }
        });
        (port, seen)
    }

    async fn eventually(what: &str, check: impl Fn() -> bool) {
        let deadline = std::time::Instant::now() + Duration::from_secs(40);
        while !check() {
            assert!(
                std::time::Instant::now() < deadline,
                "timed out waiting for {what}"
            );
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    /// The finding behind this: a redial dropped the old session instead of
    /// closing it, and `russh` keeps a session alive while any channel on it
    /// is open. A pooled connection holds its channel for up to half an hour,
    /// so the bastion went on counting the old session next to the new one.
    ///
    /// A connection is held open on the first session, then the session goes
    /// silent (the bastion stalls on the next channel), the tunnel gives up on
    /// it and redials — and the bastion must end up with one live session, not
    /// two. About twenty seconds: the stall has to outlast the channel timeout
    /// and the ping that confirms the session is gone.
    #[tokio::test]
    async fn a_redial_closes_the_session_it_replaces_even_with_a_channel_open_on_it() {
        let (port, seen) = bastion().await;
        let tunnel = SshTunnel {
            host: "127.0.0.1".into(),
            port,
            username: "u".into(),
            auth: SshAuth::Password,
            local_port: 0,
            host_key_policy: HostKeyPolicy::AcceptAny,
        };
        let handle = open_tunnel(
            &tunnel,
            Some("p".into()),
            "127.0.0.1",
            1,
            Default::default(),
        )
        .await
        .unwrap();
        assert_eq!(seen.live.load(Ordering::SeqCst), 1);

        // A connection riding the first session, kept open throughout — the
        // pooled database connection of the finding.
        let mut held = tokio::net::TcpStream::connect(("127.0.0.1", handle.local_port))
            .await
            .unwrap();
        held.write_all(b"ping").await.unwrap();
        let mut echoed = [0u8; 4];
        held.read_exact(&mut echoed).await.unwrap();
        assert_eq!(&echoed, b"ping");

        // The next channel finds the session silent, and the tunnel redials.
        seen.stall_next.store(true, Ordering::SeqCst);
        let _next = tokio::net::TcpStream::connect(("127.0.0.1", handle.local_port))
            .await
            .unwrap();
        eventually("the tunnel to log in again", || {
            seen.logins.load(Ordering::SeqCst) == 2
        })
        .await;
        eventually("the bastion to be left with one live session", || {
            seen.live.load(Ordering::SeqCst) == 1
        })
        .await;
        drop(held);
        drop(handle);
    }

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

    #[test]
    fn the_redial_wait_doubles_up_to_its_ceiling_and_a_success_clears_it() {
        let waits: Vec<u64> = (1..=9).map(|n| Backoff::delay(n).as_secs()).collect();
        assert_eq!(waits, [5, 10, 20, 40, 80, 160, 300, 300, 300]);
        // Never overflows, however long the server stays down.
        assert_eq!(Backoff::delay(u32::MAX), REDIAL_BACKOFF_MAX);

        let now = std::time::Instant::now();
        let mut backoff = Backoff::default();
        assert_eq!(
            backoff.remaining(now),
            None,
            "a tunnel that never failed waits for nothing"
        );
        let wait = backoff.failed(now, &AppError::Ssh("refused".into()));
        assert_eq!(wait, REDIAL_BACKOFF_BASE);
        assert_eq!(backoff.remaining(now), Some(REDIAL_BACKOFF_BASE));
        assert_eq!(backoff.remaining(now + REDIAL_BACKOFF_BASE), None);
        assert_eq!(
            backoff.failed(now, &AppError::Ssh("refused".into())),
            REDIAL_BACKOFF_BASE * 2
        );
        backoff.succeeded();
        assert_eq!(backoff.remaining(now), None);
        assert_eq!(backoff.failures, 0);
    }

    /// Opens a connection through the tunnel and reports whether the tunnel
    /// closed it — which is what it does when it cannot get a channel.
    async fn tunnel_refuses(local_port: u16) -> bool {
        let mut socket = tokio::net::TcpStream::connect(("127.0.0.1", local_port))
            .await
            .unwrap();
        let mut buf = [0u8; 1];
        matches!(
            tokio::time::timeout(Duration::from_secs(30), socket.read(&mut buf)).await,
            Ok(Ok(0) | Err(_))
        )
    }

    /// The finding behind this: once a redial failed, every connection
    /// through the tunnel dialled the bastion again — the heartbeat, Pulse,
    /// MongoDB's monitor, each click — so a server that bans an address for
    /// repeated logins saw a steady stream of them and the ban never expired.
    ///
    /// The bastion drops every session and starts refusing logins. The first
    /// connection after that redials once and is refused; the next five, all
    /// at once, must not reach the bastion at all. After the wait one more
    /// attempt goes out, and once the bastion lets us in the tunnel works and
    /// the slate is clean. About twenty seconds: two real backoff waits.
    #[tokio::test]
    async fn a_failed_redial_holds_off_the_next_ones_instead_of_one_per_connection() {
        let (port, seen) = bastion().await;
        let tunnel = SshTunnel {
            host: "127.0.0.1".into(),
            port,
            username: "u".into(),
            auth: SshAuth::Password,
            local_port: 0,
            host_key_policy: HostKeyPolicy::AcceptAny,
        };
        let handle = open_tunnel(
            &tunnel,
            Some("p".into()),
            "127.0.0.1",
            1,
            Default::default(),
        )
        .await
        .unwrap();
        let local = handle.local_port;
        assert_eq!(seen.attempts.load(Ordering::SeqCst), 1);

        seen.refuse_logins.store(true, Ordering::SeqCst);
        seen.drop_every_session().await;

        // The first connection after the loss redials, and is refused.
        assert!(tunnel_refuses(local).await);
        assert_eq!(seen.attempts.load(Ordering::SeqCst), 2);

        // Five more at once fail without a single login reaching the bastion.
        let burst = futures_util::future::join_all((0..5).map(|_| tunnel_refuses(local))).await;
        assert!(burst.into_iter().all(|refused| refused));
        assert_eq!(
            seen.attempts.load(Ordering::SeqCst),
            2,
            "connections inside the backoff must not dial the bastion"
        );

        // Once the wait is over, exactly one more attempt.
        tokio::time::sleep(REDIAL_BACKOFF_BASE + Duration::from_millis(500)).await;
        assert!(tunnel_refuses(local).await);
        assert_eq!(seen.attempts.load(Ordering::SeqCst), 3);

        // The bastion lets us back in: after the doubled wait the tunnel
        // works again, through a fresh session.
        seen.refuse_logins.store(false, Ordering::SeqCst);
        tokio::time::sleep(REDIAL_BACKOFF_BASE * 2 + Duration::from_millis(500)).await;
        let mut socket = tokio::net::TcpStream::connect(("127.0.0.1", local))
            .await
            .unwrap();
        socket.write_all(b"back").await.unwrap();
        let mut echoed = [0u8; 4];
        tokio::time::timeout(Duration::from_secs(10), socket.read_exact(&mut echoed))
            .await
            .expect("the tunnel should carry traffic again")
            .unwrap();
        assert_eq!(&echoed, b"back");
        assert_eq!(seen.live.load(Ordering::SeqCst), 1);
        drop(handle);
    }
}
