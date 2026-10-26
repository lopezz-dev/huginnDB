---
id: 117
type: adr
status: accepted
date: 2026-10-26
tags: [ssh, russh]
triggered_by_external_trap: true
related: [105, 110, 115]
supersedes: []
superseded_by: null
amends: []
---

# ADR #117: the tunnel never asks for a host certificate, and one that arrives anyway is pinned by the key it certifies

`russh` 0.65 lets a server prove its identity with an OpenSSH host certificate instead of a bare key, and hands `check_server_key` a `PublicKeyOrCertificate`. Every tunnel pins a host by the SHA-256 fingerprint of its key in `ssh_known_hosts.json`, and those fingerprints were all taken from bare keys. The tunnel keeps it that way: it never advertises the certificate algorithms, so a server with `HostCertificate` keeps presenting the key it was trusted under. Should a certificate arrive anyway, it is pinned by the key inside it — the same fingerprint, and the same guarantee, since that key is what signs the key exchange. No certificate authority is trusted.

**External trap behind it:** since `russh` 0.65 a server that holds a host certificate presents it *instead of* its bare key whenever the client lists the `*-cert-v01@openssh.com` algorithms (`Preferred::host_key_certificates`), and the certificate is a different blob with a different fingerprint from the key it certifies.

**Decision:** `db::ssh::client_config` sets `Preferred::host_key_certificates` empty explicitly, and `db::ssh::pinned_fingerprint` fingerprints `PublicKeyOrCertificate::public_key()` — the certified key, never the certificate — under every `HostKeyPolicy` unchanged.

**Alternatives rejected:**

- Rejecting certificates outright — rejected because the arm is unreachable today and only becomes reachable if the advertising changes; if it did, every user of a host with a certificate would be locked out with an error, where pinning the certified key keeps them connected with no weaker a check.
- Pinning the inner key without touching `Preferred` — rejected because it leaves the advertising to a `russh` default nothing here would notice changing; `the_tunnel_never_advertises_host_certificate_algorithms` now does.
- Trusting a certificate authority — out of scope: there is no UI or store for `@cert-authority`, and trusting a CA the user never configured would accept a host nobody vouched for.

## Context

The upgrade from `russh` 0.60 to 0.65 (prompted by RUSTSEC-2026-0387 in the `crypto-bigint` that 0.60's forked `ssh-key` pulled in) changed `client::Handler::check_server_key` from `&PublicKey` to `&PublicKeyOrCertificate`. The tunnel's whole host-key model — `Strict`, `AcceptNew` and `AcceptAny` over fingerprints in `ssh_known_hosts.json` — predates certificates. The one outcome that could not be allowed was a user who updates the app and is told "host key changed" by a server that has not changed.

What 0.65 actually does, read from its source:

- `Preferred::DEFAULT.host_key_certificates` is empty, documented as "turning it on is the caller's decision, never a default". The client only negotiates a certificate it advertised (`negotiation.rs`), so with defaults a server's `HostCertificate` is never used against us.
- When a certificate *is* negotiated, `russh` verifies the key-exchange signature with the key inside the certificate (`client/kex.rs`) and leaves the certificate's own signature to the handler. So the inner key proves possession exactly as a bare key does.
- `PublicKeyOrCertificate::public_key()` returns that inner key, whose fingerprint is the bare key's.

OpenSSH behaves the same way for a host it has no `@cert-authority` line for: it falls back to checking the certified key against `known_hosts`.

## Consequences

- Fingerprints stored before the upgrade keep matching, whether the server has a certificate or not; `Strict` still refuses an unknown host and `AcceptNew` stores the bare key's fingerprint.
- The certificate's validity period, principals and signing CA are not looked at. They mean nothing without a trusted CA; adding CA trust is a feature with its own UI and its own ADR, and it must keep these fingerprints valid rather than replace them.
- **Tests.** `db::ssh::tests::a_server_with_a_host_certificate_keeps_its_stored_fingerprint` runs an in-process `russh` server holding a certificate (`TEST_HOST_CERT`, signed by a throwaway CA) and dials it twice per policy: as the tunnel does, where it must present the bare key, and with certificates forced into `Preferred`, where it must present the certificate (`VerifyOutcome::certificate_presented`, test-only) and still be pinned by the same fingerprint. It was also checked by hand against OpenSSH 8.9 with `HostCertificate`: the OpenSSH client was offered the certificate, the tunnel negotiated plain `ssh-ed25519`.
- Do not set `host_key_certificates` without revisiting this ADR.
