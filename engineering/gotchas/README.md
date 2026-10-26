# Gotchas

A gotcha is **a fact about something outside HuginnDB's own design** (a library, a driver, the platform, CI, a language model) where the obvious code is wrong. It is not a choice and it is not ours to revisit. It stays true for as long as the dependency behaves this way, and it is retired (`status: obsolete`) when the dependency stops doing it. See [the taxonomy](../README.md#three-kinds-of-entry).

This index is grouped by the technology that bites. It lists both:

- **Gotcha** entries: the fact is the whole entry.
- **ADR** entries whose decision was forced by an external trap (`triggered_by_external_trap: true`). The trap is the context, and what you would revisit is the decision, so the entry lives under [`adr/`](../adr/README.md).

Template: [`../templates/gotcha.md`](../templates/gotcha.md).

<!-- index:start -->
### ai

| # | Entry | Trap | Status |
| - | ----- | ---- | ------ |
| 72 | ADR: [Metadata-only removes the row tools from the catalogue instead of refusing them at call time](../adr/adr-072-metadata-only-removes-tools-not-refuses.md) | A language model will try any tool it can see, and treats a refusal it reads as something to negotiate or route around. | accepted |
| 77 | ADR: [A refusal is prompt text too — it must name the fix the model can apply, and the classifier is part of the prompt](../adr/adr-077-a-refusal-is-prompt-text-and-must-name-the-fix.md) | A model reads refusal text as an instruction and follows it literally, and without being told the engine it writes whatever SQL dialect it has seen most. | accepted |
| 78 | ADR: [When a small model will not follow an instruction, detect the failure instead of writing the instruction again](../adr/adr-078-detect-the-failure-instead-of-prompting-harder.md) | A 12B model sometimes ends a turn by printing a SELECT for the user to run despite clear instructions to run reads itself. | accepted |
| 80 | ADR: [An agent needs breadth before depth — hand it the table map, and let the user write down what the schema cannot say](../adr/adr-080-breadth-before-depth-map-and-notes.md) | An agent given only tools, with no map of the database, fixes on the table or column the question names and assumes nothing else exists. | accepted |

### grid

| # | Entry | Trap | Status |
| - | ----- | ---- | ------ |
| 86 | ADR: [Formatting a cell *on open* must refuse any reformat that changed more than whitespace](../adr/adr-086-auto-format-on-open-must-refuse-a-lossy-reformat.md) | JSON.parse + JSON.stringify is a value round trip, not a whitespace transform: large integers lose precision, 1.0 becomes 1, duplicate keys vanish, integer-like keys are reordered and escapes are normalised. | accepted |

### llm

| # | Entry | Trap | Status |
| - | ----- | ---- | ------ |
| 73 | ADR: [A tool result must be bounded in size, not in rows — Ollama truncates from the front](../adr/adr-073-tool-result-budget-is-bytes-not-rows.md) | Ollama truncates an over-long request from the front, evicting the system prompt and the user's question while the last tool result survives, with no error. | accepted |
| 74 | Gotcha: [A tool's description is read at the decision point, so it must never tell the model to delegate the tool's own job](gotcha-074-tool-description-read-at-decision-point.md) | Guidance in a tool's description is read at the decision point, so a sentence telling the model to propose instead of run made it stop calling the tool and hand SQL to the user. | active |
| 79 | ADR: [A data assistant asks for a low temperature, and `temperature` / `reasoning_effort` are mutually exclusive](../adr/adr-079-low-temperature-and-mutually-exclusive-with-effort.md) | Ollama and llama.cpp default to temperature 0.8, and OpenAI reasoning models reject any temperature other than 1 while ordinary models reject reasoning_effort. | accepted |

### mcp

| # | Entry | Trap | Status |
| - | ----- | ---- | ------ |
| 20 | ADR: [huginndb-mcp lives in its own workspace crate, never a second [[bin]]](../adr/adr-020-mcp-sidecar-separate-workspace-crate.md) | tauri-bundler's Windows bundling enumerates every [[bin]] in the package's cargo metadata regardless of required-features and fails sizing a binary that a normal build never compiles (tauri#4807, #14176). | accepted |
| 22 | ADR: [huginndb-mcp ships as a Tauri externalBin sidecar staged by CI](../adr/adr-022-mcp-sidecar-external-bin-staging.md) | tauri-build hard-fails any compile of huginndb_lib if the externalBin file for the current target triple is not already on disk, creating a circular dependency with building the sidecar itself. | accepted |
| 59 | ADR: [MCP tool annotations are read once at startup, so they must be constants](../adr/adr-059-mcp-tool-annotation-constants-split.md) | MCP clients fetch tools/list (and its annotations) once at startup and cache it for the session, and destructiveHint defaults to true when absent. | accepted |

### monaco

| # | Entry | Trap | Status |
| - | ----- | ---- | ------ |
| 2 | ADR: [Monaco is bundled, never CDN-loaded](../adr/adr-002-monaco-bundled-not-cdn.md) | Monaco loaded from cdn.jsdelivr.net renders blank editors whenever the Tauri app cannot reach the CDN. | accepted |
| 9 | Gotcha: [Monaco commands are per-editor; providers are global to the language](gotcha-009-monaco-ctrl-enter-global-providers.md) | Monaco swallows Ctrl+Enter so window listeners never see it, and its completion/CodeLens providers are global to the language, so registering them per editor duplicates them once per open tab. | active |

### mongodb

| # | Entry | Trap | Status |
| - | ----- | ---- | ------ |
| 34 | ADR: [MongoDB indexes are read from raw listIndexes, never mongodb::IndexModel](../adr/adr-034-mongo-indexes-raw-not-indexmodel.md) | mongodb::IndexModel drops per-key direction/type, sparse, expireAfterSeconds, partialFilterExpression, collation, weights and hidden, so rebuilding from it silently recreates indexes differently. | accepted |
| 38 | ADR: [MongoDB can rename a collection but genuinely cannot rename a view](../adr/adr-038-mongo-rename-collection-not-view.md) | MongoDB's renameCollection is an admin-database run-command on fully-qualified names that can move collections across databases, but a view cannot be renamed. | accepted |
| 48 | ADR: [drop_view must verify the name is actually a view before dropping it](../adr/adr-048-mongo-drop-view-type-check.md) | A MongoDB view and a collection share one namespace and dropping either is the same db.collection(name).drop() call, so a mistyped name silently deletes a collection's data. | accepted |
| 65 | ADR: [A describe has two halves, and the best-effort half must never decide whether the authoritative one runs](../adr/adr-065-describe-relation-two-halves-lenient-view.md) | On a MongoDB view, listIndexes fails with CommandNotSupportedOnView (166) and $sample cannot use its random-cursor fast path because the view's pipeline runs first, so inference times out. | accepted |
| 68 | ADR: [MongoDB's client is lazy, so `connect` could not fail — and the app announced success for a server that never answered](../adr/adr-068-mongo-lazy-client-connect-cannot-fail.md) | mongodb's Client::with_options performs no network round trip, so a client builds 'successfully' against an unreachable server; also mongodb::error::Error's Display drags a hex dump of the server reply. | accepted |

### mssql

| # | Entry | Trap | Status |
| - | ----- | ---- | ------ |
| 31 | ADR: [SQL Server needs its own pool (tiberius) and four T-SQL divergences](../adr/adr-031-mssql-tiberius-pool-and-tsql.md) | sqlx has no MSSQL driver, tiberius has no pool and Client::query takes &mut self, OFFSET/FETCH requires ORDER BY, OUTPUT is refused on tables with triggers (error 334), and implicit nvarchar->varbinary conversion stores the characters' bytes. | accepted |
| 37 | ADR: [SQL Server accepts SSMS's HOST\INSTANCE in either field, split centrally](../adr/adr-037-mssql-host-instance-splitting.md) | Users type SSMS's single-box HOST\INSTANCE; unsplit, a backslash in the host breaks DNS and the whole string as an instance name never matches SQL Browser, which reports only the bare name. | accepted |
| 89 | ADR: [A blank port means the driver's default, and `tiberius` aims its SQL Browser lookup at whatever port the `Config` carries](../adr/adr-089-a-blank-port-means-the-drivers-default.md) | tiberius' connect_named sends the SQL Browser datagram to Config::get_addr(), so a config carrying the login port aims the lookup at the instance's TCP port where no UDP listener exists; until 1.27.0 the Browser path never worked. | accepted |

### mysql

| # | Entry | Trap | Status |
| - | ----- | ---- | ------ |
| 15 | Gotcha: [MySQL integer and BIT decoding is width- and type-specific](gotcha-015-mysql-integer-bit-decoding.md) | sqlx rejects mismatched integer widths, reports TINYINT(1) as "BOOLEAN" (which does not contain "INT"), and a textual "1" written to a BIT column is stored as ASCII 0x31, so naive decode/write shows NULLs or wrong bits. | active |
| 17 | Gotcha: [MySQL BLOB vs TEXT is decided by content, not the type name](gotcha-017-mysql-blob-text-content-sniffing.md) | sqlx names a column LONGBLOB vs LONGTEXT from the protocol BINARY flag, which MySQL sometimes sets on real text columns, and try_get::<String> rejects such columns before looking at the bytes. | active |

### react

| # | Entry | Trap | Status |
| - | ----- | ---- | ------ |
| 51 | ADR: [Markdown's navigator is React context, and its scroll-to-anchor clears last](../adr/adr-051-markdown-navigator-context-scroll-order.md) | In a React effect that schedules a requestAnimationFrame, updating a dependency before the frame runs triggers the effect cleanup, which cancels the frame so the scroll never happens. | accepted |
| 85 | Gotcha: ["Adjust state when a prop changes" must remember the previous prop in *state* — a ref survives the render StrictMode throws away](gotcha-085-adjust-state-during-render-needs-state-not-a-ref.md) | Under StrictMode a component body runs twice and the first pass is discarded, but a useRef mutation is not, so a ref-based 'last applied' marker makes the second pass skip the setState and the update is lost; tests not mounted in StrictMode cannot see it. | active |

### russh

| # | Entry | Trap | Status |
| - | ----- | ---- | ------ |
| 115 | Gotcha: [`russh` signs an RSA key with `ssh-rsa` (SHA-1) unless it is told the hash, and OpenSSH 8.8+ refuses that](gotcha-115-russh-rsa-key-without-hash-signs-sha1.md) | An RSA key wrapped with `PrivateKeyWithHashAlg::new(key, None)` signs with SHA-1 `ssh-rsa`, which OpenSSH 8.8+ rejects by default; `russh` never negotiates `rsa-sha2-*` unless the caller asks `best_supported_rsa_hash()` and passes the hash. | active |

### security

| # | Entry | Trap | Status |
| - | ----- | ---- | ------ |
| 93 | ADR: [A statement's tier is read from its text, so a read an AI sends must also be run where the database refuses to write](../adr/adr-093-a-read-is-proven-by-the-database-not-the-text.md) | Statements whose first keyword reads as a read can write: a WITH carrying DML, EXPLAIN ANALYZE (executes the statement), and a MongoDB aggregate ending in $out/$merge; on MySQL DDL implicitly commits an open transaction. | accepted |

### serde

| # | Entry | Trap | Status |
| - | ----- | ---- | ------ |
| 14 | Gotcha: [An undeclared field on a typed IPC struct is silently dropped](gotcha-014-serde-drops-undeclared-fields.md) | A field sent through a typed Tauri command but not declared on the Rust struct is silently dropped by serde on deserialize, e.g. never reaching disk or silently reinstating COUNT(*) when withCount is lost. | active |

### sqlx

| # | Entry | Trap | Status |
| - | ----- | ---- | ------ |
| 5 | ADR: [update_cell's value is Option<String> end-to-end](../adr/adr-005-update-cell-option-string.md) | sqlx's postgres driver will not encode a serde_json::Value to arbitrary column types. | accepted |
| 11 | Gotcha: [sqlx rejects Vec<u8> reads on a MySQL BIT column](gotcha-011-mysql-bit-vecu8-rejected.md) | sqlx rejects try_get::<Vec<u8>> on a MySQL BIT column because its blob compatibility check accepts only BLOB/STRING/VARBINARY. | superseded → #15 |
| 66 | ADR: [sqlx's eager `connect()` discards why it failed, so an unreachable host was reported as "too many connections"](../adr/adr-066-sqlx-eager-connect-masks-the-real-cause.md) | sqlx's eager PoolOptions::connect_with retries what it deems transient (ConnectionRefused, Postgres 53300/57P03) until acquire_timeout and then returns PoolTimedOut, discarding the real error. | accepted |

### ssh

| # | Entry | Trap | Status |
| - | ----- | ---- | ------ |
| 105 | ADR: [an SSH tunnel redials its own session, views ride their parent's tunnel, and every pool check is bounded](../adr/adr-105-ssh-tunnels-heal-and-pool-checks-are-bounded.md) | russh sends no keepalive by default, so a firewall-dropped session goes unnoticed; sqlx's test_before_acquire ping has no timeout (a silently dropped socket costs 30 s and surfaces as 'too many connections'); sqlx 0.8 also pings unconditionally on release. | accepted |
| 110 | ADR: [a tunnel holds one SSH session — a slow channel is not a dead session, and a replaced session is closed](../adr/adr-110-a-tunnel-holds-one-ssh-session.md) | `russh` ends a client session only when its `Handle` and every `Channel` opened on it are dropped (each channel holds a clone of the session's sender), so dropping the handle of a session with open channels leaves it connected. | accepted |

### tanstack

| # | Entry | Trap | Status |
| - | ----- | ---- | ------ |
| 7 | ADR: [DataGrid mutation callbacks use row values, not a row index](../adr/adr-007-datagrid-row-identity-not-index.md) | TanStack Table's row.index is the filtered display index, so it diverges from the unfiltered backend page as soon as a client filter is active. | accepted |

### tauri

| # | Entry | Trap | Status |
| - | ----- | ---- | ------ |
| 3 | Gotcha: [tauri::State does not auto-deref into &T](gotcha-003-tauri-state-inner-deref.md) | Passing &state where a helper expects &AppState does not work because tauri::State does not auto-deref; state.inner() must be used. | active |
| 19 | Gotcha: [Building a WebviewWindow must happen inside an async Tauri command](gotcha-019-webview-window-builder-async-fn.md) | Calling WebviewWindowBuilder::build() from a sync Tauri command on Windows deadlocks, showing a blank/white window tagged Not Responding with no error. | active |
| 25 | Gotcha: [An untargeted frontend listener receives every window's emit_to](gotcha-025-tauri-listen-target-scoping.md) | A frontend listen(event) without a target receives every window's emit_to, so a second window's Console duplicated the first window's log entries. | active |

### themes

| # | Entry | Trap | Status |
| - | ----- | ---- | ------ |
| 87 | ADR: [A VS Code theme is *translated* into Monaco and *derived* into the chrome — and alpha is resolved at import, not in the pipeline](../adr/adr-087-vscode-theme-import-derives-chrome-translates-editor.md) | Real VS Code themes are often JSONC (do not parse with JSON.parse), carry many translucent #RRGGBBAA colours, omit keys such as menu.* and button.*, may omit `type`, and one extension contributes several themes; Monaco's defineTheme rejects unknown colour keys. | accepted |

### tiberius

| # | Entry | Trap | Status |
| - | ----- | ---- | ------ |
| 116 | Gotcha: [tiberius 0.13 bounds every query at 30 s and the handshake at 15 s by default, and its connect future is three times larger](gotcha-116-tiberius-013-default-timeouts.md) | tiberius 0.13 compiles unchanged over 0.12 but cuts any query whose server round-trip passes 30 s (TimedOut, connection desynced) unless `command_timeout(None)` is set, and its larger connect future, left inline, overflowed a 2 MiB thread stack in a debug build. | active |

### updater

| # | Entry | Trap | Status |
| - | ----- | ---- | ------ |
| 23 | Gotcha: [A running huginndb-mcp.exe blocks the self-updater's overwrite](gotcha-023-mcp-sidecar-blocks-updater.md) | Tauri's NSIS template only closes the main huginndb.exe, so a running huginndb-mcp.exe makes the update overwrite fail with ERROR_SHARING_VIOLATION, surfaced as a generic access-denied error. | active |

### webview2

| # | Entry | Trap | Status |
| - | ----- | ---- | ------ |
| 63 | ADR: [The clipboard is read and written natively, never through `navigator.clipboard`](../adr/adr-063-clipboard-native-plugin-not-webview.md) | In WebView2, navigator.clipboard.readText() raises the engine's own permission prompt and writeText() stays in the webview's channel instead of reaching the system clipboard. | accepted |

### windows

| # | Entry | Trap | Status |
| - | ----- | ---- | ------ |
| 21 | ADR: [Windows installer target is NSIS, not MSI/WiX](../adr/adr-021-windows-installer-nsis-not-msi.md) | WiX v3's light.exe fails to launch on GitHub's Windows runners (likely AV heuristics flagging that binary), while candle.exe runs fine. | accepted |
| 62 | Gotcha: [Windows' default 1 MiB main-thread stack is too small for the structure/view introspection chain in release](gotcha-062-windows-main-thread-stack-reserve.md) | Release builds on Windows crash with 'thread main has overflowed its stack' because MSVC's default 1 MiB SizeOfStackReserve is too small once optimisation collapses the call chain into larger frames; fixed with /STACK:8388608 in .cargo/config.toml. | active |

### zustand

| # | Entry | Trap | Status |
| - | ----- | ---- | ------ |
| 1 | Gotcha: [Zustand selectors must be reference-stable](gotcha-001-zustand-selector-stability.md) | A selector like s => s.entries.filter(...) returns a fresh reference every call, so Object.is always differs and React hits its update-depth cap from infinite re-renders. | active |
<!-- index:end -->
