---
id: 70
type: adr
status: accepted
date: 2026-09-09
tags: [mongodb, ui]
triggered_by_external_trap: false
related: []
supersedes: []
superseded_by: null
amends: []
---

# ADR #70: The MongoDB form owns the options it models and carries the rest; raw-edit is not a one-way door

`parseMongoUri` is `parseMongoUriLossy` with a "nothing was lost" gate, so the strict and tolerant views cannot drift; unmodelled query options ride through in `extraOptions` instead of forcing raw-edit, and the four shapes that genuinely cannot be a form now raise a confirmation rather than a silent no-op.

**Decision:** parseMongoUri is parseMongoUriLossy plus a nothing-lost gate; unmodelled options travel in extraOptions, and only four loss kinds (srv, multiHost, embeddedPassword, unparseable) force raw-edit, with a confirmation dialog when leaving it.

**Alternatives rejected:**

- Refusing any unmodelled query option (forcing raw-edit): rejected because every Atlas URI carries retryWrites/w.
- Two separate strict and lossy parser implementations kept in step by hand: replaced by one implementation with a gate.
- Building the parser on URL: rejected because URL throws on multi-host commas.
- Silently flipping back to raw-edit: rejected in favour of a named confirmation.
- Rendering an empty host as a blank field: rejected because buildMongoUri would fill in localhost.

## Detail

**Saving a MongoDB profile from a hand-written URI used to make the form unreachable for the rest of that profile's life**, through two independent mechanisms that both had to go.

- **Refusing an unmodelled query option is not conservatism, it is a trap.** The dialog reads a `null` parse as "open in raw-edit mode", and `parseMongoUri` returned `null` for any option outside `authSource`/`directConnection` — which is to say for every Atlas URI, since the console hands you `retryWrites` and `w`. Those options now travel as opaque `[key, value]` pairs in `MongoUriFields.extraOptions`, re-emitted by `buildMongoUri` **after** the modelled pair. A round trip through the form therefore normalises option *order* and never option *content*. A repeated modelled key (`?authSource=a&authSource=b`) becomes an extra too: one field cannot own two values, and dropping the duplicate would change what the URI means.
- **`parseMongoUri` is defined as `parseMongoUriLossy` plus a gate**, and that is the whole reason the two cannot disagree. The module doc's standing rule — an option `buildMongoUri` emits but `parseMongoUri` refuses strands every profile that uses it — used to rest on two implementations staying in step by hand. Now there is one implementation and `lost.length === 0` is the strict view of it.
- **`MongoUriLoss` is closed at four members**, and they are the only shapes a single-host form cannot hold: `srv`, `multiHost`, `embeddedPassword`, `unparseable`. Leaving raw-edit with one of those raises `mongoFoldConflict` and `MongoUriFoldDialog` names each one, rather than the switch silently flipping back under the cursor with nothing on screen saying why. Confirming folds in whatever was legible and drops the rest, with a pill afterwards: the form visibly repopulates, but the discarded parts are precisely the ones *not* on screen. An embedded password is dropped rather than surfaced — retyping it into the password field is what puts it in the keychain, where it belongs.
- **The lossy parse is hand-rolled rather than built on `URL`, deliberately.** The shape that matters most here is the one `URL` refuses outright: `mongodb://a:27017,b:27017/db` throws on the comma it reads as part of a port, and losing the whole URI to that is the dead end the function exists to open up. It splits on the *rightmost* `@` (a password may carry a percent-encoded one, a host never can), treats a colon after `]` as a port so an IPv6 literal survives, and decodes through a `safeDecode` that returns the raw text on a malformed escape.
- **An empty host is `unparseable`, not a representable field.** `mongodb:///shop` would render as a blank Host box that `buildMongoUri` then fills in with `localhost` — silently retargeting the connection, which is worse than admitting the string could not be read.
