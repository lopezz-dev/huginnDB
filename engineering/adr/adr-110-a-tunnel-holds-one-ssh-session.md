---
id: 110
type: adr
status: accepted
date: 2026-10-19
tags: [ssh]
triggered_by_external_trap: true
related: [105]
supersedes: []
superseded_by: null
amends: [105]
---

# ADR #110: a tunnel holds one SSH session — a slow channel is not a dead session, and a replaced session is closed

ADR #105 redialled a tunnel's session when a channel did not open within 10 s, and replaced it by dropping the handle. Both halves added sessions on the bastion. A channel can be slow on a session that is perfectly alive, and dropping a `russh` handle closes nothing while a channel on that session is open, which a pooled connection keeps for up to 30 minutes. Against a bastion that limits SSH sessions (the "5-6 per server" rule that prompted this), every slow moment left one more session counting. A timed-out channel now asks the session for a ping and only a silent one is replaced, and the replaced session is sent `SSH_MSG_DISCONNECT` before the new one is dialled.

**External trap behind it:** `russh` ends a client session only when its `Handle` and every `Channel` opened on it are dropped (each channel holds a clone of the session's sender), so dropping the handle of a session with open channels leaves it connected.

**Decision:** `TunnelSession::channel` decides through a pure `verdict`: a refused channel on a live session is reported, a timed-out channel on a session that answers `send_ping` within 5 s is reported as slow, and only a closed or silent session is redialled; the session being replaced is `retire`d (`disconnect(ByApplication)`, bounded at 2 s) before `Dialer::dial` runs.

**Alternatives rejected:**

- Keeping the timeout-means-dead rule and only closing the old session — rejected because a slow bastion would still have its session torn down and redialled every time it was slow, which is load and logins against a server that is already struggling.
- Retiring the old session after the new one is up — rejected because a server limiting concurrent sessions may have no room for the replacement while the old one still counts.
- Lowering `CHANNEL_OPEN_TIMEOUT` instead — rejected because it changes how soon a dead session is noticed, not whether a live one is mistaken for dead.

## Context

The review of Sergio's report on servers blocking SSH found two ways a single tunnel could hold more than one session against the bastion.

- **Timeout meant dead.** `TunnelSession::channel` treated a channel that did not open in `CHANNEL_OPEN_TIMEOUT` as proof the session was gone, because a TCP connection dropped without a FIN looks alive until the keepalive notices. That is true of a dead session, but a session on a loaded bastion, or one whose forwarding target is slow to accept, also answers late, and it is alive.
- **Drop did not close.** The replacement was `*current = Arc::new(new)`. In `russh` 0.60 the client session's loop ends when its receiver yields `None`, that is, when every `Sender<Msg>` is gone, and `Channel::write_half` holds a clone of the handle's sender (`client/mod.rs`, `wait_channel_confirmation`). Every pooled database connection riding the old session kept it connected, for up to `MAX_LIFETIME` (30 min) on the SQL side and for the life of the client on MongoDB, whose monitor holds a permanent connection.

## Detail

- **`verdict(failure, closed, answered_ping)`** is the whole decision, pure so it is tested as a table (`db::ssh::tests::only_a_session_that_is_gone_is_redialled`):
  - closed under us, whatever the channel said: `Redial`;
  - refused on a live session: `Report`, the server's own answer, as before;
  - timed out, session answers a ping: `Slow`, reported as an SSH error that says the server is up but did not open a channel to the target;
  - timed out, ping unanswered: `Redial`.
- **`answers_ping`** is `send_ping` within `PING_TIMEOUT` (5 s) and still open afterwards. OpenSSH answers the keepalive request with `SSH_MSG_REQUEST_FAILURE` and `russh` resolves the ping on failure as well as success. `send_ping` also resolves quietly if the session ends mid-wait, which is why `is_closed` is checked after it. The question is only asked after a timeout, so a healthy tunnel never pays for it.
- **`retire`** sends `disconnect(ByApplication)` bounded by `RETIRE_TIMEOUT` (2 s). It only has to reach the session's own task, which writes the message and ends its loop, closing the socket and every channel on it. The connections riding it fail and their pools replace them through the new session (`check_before_use`, ADR #105). They were riding a session already given up on, so nothing healthy is lost.
- **Order: retire, then dial.** If the server still counts the old session, a limit on concurrent sessions has room for the new one. On a session that is already gone the disconnect is a no-op.

## Consequences

- One tunnel is one session on the bastion, through redials, which is what the endpoint budget and the report's per-person count assume.
- A slow bastion now produces an error on the slow channel instead of a new session. The pool retries that connection on its next checkout through the same session.
- **Test seam.** `db::ssh::tests` runs an in-process `russh` server (throwaway ed25519 host key, password auth that accepts anything, `direct-tcpip` forwarded to a local echo server) that counts logins and live sessions. `a_redial_closes_the_session_it_replaces_even_with_a_channel_open_on_it` holds a connection open, stalls the next channel past timeout and ping, and requires one live session after the redial. With `retire` removed it fails with two.
- **Not covered end to end: the `Slow` branch.** `russh`'s server runs handlers inline in the session loop, so a stalled `channel_open_direct_tcpip` also stalls the ping reply. The fake bastion can play a dead session but not a live, slow one. That branch rests on the `verdict` table.
