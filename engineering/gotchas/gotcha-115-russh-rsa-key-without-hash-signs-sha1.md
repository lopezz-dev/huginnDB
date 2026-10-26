---
id: 115
type: gotcha
status: active
date: 2026-10-26
tags: [russh, ssh, openssh]
related: [105, 110]
supersedes: []
superseded_by: null
amends: []
---

# Gotcha #115: `russh` signs an RSA key with `ssh-rsa` (SHA-1) unless it is told the hash, and OpenSSH 8.8+ refuses that

`PrivateKeyWithHashAlg::new(key, None)` reads as "no particular hash", but for an RSA key `russh` maps `None` to the legacy `ssh-rsa` signature algorithm, which signs with SHA-1. OpenSSH 8.8 (2021) removed `ssh-rsa` from the server's default `PubkeyAcceptedAlgorithms`, so a tunnel built that way authenticates fine against an old bastion or an in-process `russh` test server and is turned away by every current OpenSSH one. `russh` does not negotiate this on its own: the client has to ask the server with `Handle::best_supported_rsa_hash()`, which reads RFC 8308's `server-sig-algs`, and pass the answer in.

**Trap:** An RSA key wrapped with `PrivateKeyWithHashAlg::new(key, None)` signs with SHA-1 `ssh-rsa`, which OpenSSH 8.8+ rejects by default; `russh` never negotiates `rsa-sha2-*` unless the caller asks `best_supported_rsa_hash()` and passes the hash.

## Detail

- **Symptom:** key authentication through the SSH tunnel fails with "authentication rejected by server" for RSA keys only; the server's log says `userauth_pubkey: signature algorithm ssh-rsa not in PubkeyAcceptedAlgorithms`. Ed25519 and ECDSA keys work, and so does the same RSA key with the `ssh` command line, because the OpenSSH client negotiates.
- **Cause:** `russh::keys::PrivateKeyWithHashAlg::new` documents that, for RSA, `None` "is mapped to the legacy `sha-rsa` (SHA-1)". `russh`'s own in-process server does not enforce the signature algorithm, so a test against it cannot see the difference.
- **What to do:** for an RSA key, ask `Handle::best_supported_rsa_hash()` after the handshake and sign with what it names; when the server sent no `server-sig-algs`, try SHA-512, SHA-256 and only then `ssh-rsa`. The decision lives in `db::ssh::signature_hashes`, and `Dialer::dial_unbounded` is the one caller. `best_supported_rsa_hash()` waits up to a second for the server's EXT_INFO, so it is asked only for RSA keys.
- **Still true in `russh` 0.65** (checked 2026-10-26 on the upgrade): `authenticate_publickey` forwards the key as given, `PrivateKeyWithHashAlg::new` still maps `None` to `ssh-rsa` for RSA, and `best_supported_rsa_hash` still returns `Result<Option<Option<HashAlg>>>`. Verified against OpenSSH 8.9: the RSA key signed with `rsa-sha2-512`.
- **Retire when:** `russh` negotiates the RSA signature hash itself inside `authenticate_publickey`.
