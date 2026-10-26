# HuginnDB managed policy — design rationale and phased build-out

Status: **phase 0 and phase 1 shipped** (unreleased, next minor — PRs #186,
#188, #189; the AI is bound, see [`POLICY.md`](POLICY.md)); **phases 2–4 open**.
This document is the specification for
*managed policy*: per-role permissions, set by an administrator in one place,
that bound what each **person** can do in HuginnDB and what an **AI** acting for
that person can do, on every installation in an organization.

It is written to be executed one phase at a time. Every phase states what to
build, what "done" means, and what *not* to do. Read the whole document before
starting phase 1 — decisions in later phases constrain earlier ones.

Companion documents:

- [`ENVIRONMENTS.md`](ENVIRONMENTS.md) — shared origins, the existing way a
  team distributes connections from a network share. Policy reuses its file
  delivery, **not** its trust model (see §4).
- [`MCP.md`](MCP.md) / [`MCP_CONNECTOR_ROADMAP.md`](MCP_CONNECTOR_ROADMAP.md) —
  the connector whose per-connection write policy this generalises.
- [`AI.md`](AI.md) — the in-app AI panel, the second AI surface policy binds.

---

## 1. The problem

HuginnDB is being prepared for sale to organizations. Installing it on every
workstation is not the objection; **configuring and auditing permissions on
every workstation individually is.** The requirement, as stated by the
prospective customer:

- **Visibility / access** per user or role: whether a database, table or view
  can be read at all — *including* discovery through system catalogs
  (`INFORMATION_SCHEMA`, `sys.*`, `master`, `pg_catalog`, `sqlite_master`,
  `listCollections`), so a restriction cannot be bypassed by asking the catalog.
- **Write** per user or role: `SELECT` only, or `INSERT`, `UPDATE`, and
  `DELETE` as a **separate** grant.
- Scoped by department: *sales reads the billing tables and views; production
  only sees its own area.*
- It applies to **people and to the AI alike.** An administrator must be able to
  answer, in one place, both "what can each user do on my databases?" and "what
  can the AI do on my databases?".
- Administered **once**, affecting every installation.

Out of scope for this document: Active Directory / LDAP identity. Every customer
integrates differently; identity is the OS user name (§5.1) until a customer
needs more.

## 2. Decisions already taken

| # | Decision | Why |
|---|----------|-----|
| D1 | A role carries **two permission blocks, `human` and `ai`, with `ai ⊆ human`.** | The AI never does more than the person it works for, so the two policies cannot drift apart; an admin can still give the AI less (e.g. sales writes billing, its AI only reads it). |
| D2 | For people, v1 is a **guardrail plus per-user database credentials**, and HuginnDB **generates the `GRANT` script** from the policy. | See §3. The database is the only thing that can enforce against a person who holds the password. |
| D3 | **Free SQL is disabled** (query editor for people, `run_query`/`run_write` for the AI) in any rule whose scope is narrower than the whole connection. | Extracting the relations a statement touches is not solvable airtight across five dialects (§6.3). Structured surfaces can be filtered exactly. |
| D4 | The policy is anchored per machine in **both** the HKLM registry and a system-directory file; the registry wins. | Same shape as VS Code and Claude Code (§8). The file works without Group Policy and on every OS; the registry is what GPO/Intune deploy. |
| D5 | **One role per user.** A user is in their department and nothing else; roles are never combined. | Combining roles makes the effective permission something nobody wrote down, and the support cost of explaining it lands on us. |
| D6 | **No signing and no local copy.** An unreadable policy blocks (§5.4); tampering is prevented by the share's permissions (only administrators write). | The signature's main job was to make an offline cache safe to trust. A machine that reaches its database but not the share is rare enough not to justify a key pair and a new dependency. |

## 3. What can and cannot be enforced — say this to customers verbatim

**For the AI, HuginnDB is the enforcement point, and it is airtight.** The model
never holds a database credential; `huginndb-mcp` and the AI panel do, and every
request passes through one choke point (`BridgeRequest`, §6.1). If policy
refuses a request, the model cannot perform it.

**For a person, HuginnDB alone is a guardrail.** A person whose workstation
holds the database password — in their OS keychain, or recoverable from a
shared origin with the passphrase — can open any other client and ignore
HuginnDB's policy. So the product claim is:

> HuginnDB applies your policy to people and to the AI. To make it impossible
> for a person to bypass, give each person their own database user —
> HuginnDB generates the grants that make the database agree with the policy.

A third option — a server that holds every credential so none reaches a
workstation (a "gateway" / tenant) — would make HuginnDB the enforcement point
for people too. It is a different product (months, a server component, its own
authentication) and is **not** part of this plan.

## 4. Why shared origins are not enough on their own

Origins already put a file on a share that many installations read. But an
origin is **attached by the user**, on their own machine, and can be detached
by the same user; its per-connection trust flags (`mcp_write`, `mcp_exposed`,
`ai_*`, `pulse_enabled`) are deliberately preserved *locally* against the
publisher (`merge_into`). Both properties are right for origins and wrong for
policy. Policy therefore:

- is located by a **machine-level anchor** a standard user cannot write (§5.2);
- **overrides** local settings, with one exception: a local setting may only
  *narrow* policy, never widen it (effective = policy ∩ local, the same rule
  Claude Code applies to a stricter lower-level value);
- may reuse the origin code path for *reading and watching* a file on a share.

## 5. The policy document

### 5.1 Identity

The subject is the **OS user name** of the process — the app, or the
`huginndb-mcp` sidecar the user's AI client launched (both run as the user).
Matched case-insensitively, with or without the `DOMAIN\` prefix. It is not
verified against anything; the user list is maintained by hand. A user not
listed gets `defaultRole`, which should be the most restrictive role.

It is read from the operating system (`whoami::username()`, which calls
`GetUserNameW` on Windows), **never from an environment variable**: `USERNAME`
and `USER` are set by whoever launches the process, so a user could start the
app with `USERNAME=admin` and inherit the administrator's role.

### 5.2 Anchors (D4)

Read in order; **the first source that carries a policy wins**, the rest are
ignored (no merging across sources in v1):

1. **Registry** `HKLM\SOFTWARE\Policies\HuginnDB` — value `Policy` (REG_SZ,
   the JSON inline) or `PolicySource` (REG_SZ, a path to the JSON, typically
   on a share).
2. **File** `managed-policy.json` in the system directory:
   `C:\Program Files\HuginnDB\` (Windows), `/etc/huginndb/` (Linux),
   `/Library/Application Support/HuginnDB/` (macOS). Same two shapes: the
   policy inline, or `{ "source": "\\\\server\\share\\huginn-policy.json" }`.

`HKCU` is **not** a source: it is user-writable.

No anchor → the installation is unmanaged and behaves exactly as today.

### 5.3 Shape (sketch — the real schema ships as a JSON Schema)

```json
{
  "version": 1,
  "defaultRole": "none",
  "users": { "scara": "admin", "alopez": "sales" },
  "roles": {
    "none": { "rules": [] },
    "sales": {
      "rules": [{
        "endpoint": { "driver": "mysql", "host": "erp.local", "port": 3306 },
        "databases": ["billing"],
        "relations": { "allow": ["invoices", "v_invoice_*"], "deny": ["cards"] },
        "human": ["select", "insert", "update", "export"],
        "ai": ["select"]
      }]
    },
    "admin": {
      "rules": [{
        "endpoint": "*",
        "human": ["select", "insert", "update", "delete", "ddl", "export", "monitor"],
        "ai": ["select"]
      }]
    }
  },
  "unmanagedConnections": "allow"
}
```

Semantics:

- **Rules match by endpoint, not by profile id.** A profile id is local and
  free to mint: a user who re-creates a connection by hand would get a fresh id
  the policy has never heard of. The endpoint (driver + normalised host +
  effective port + tunnel, i.e. `db::endpoint::EndpointKey`) is what the server
  actually is. SQLite has no endpoint key; its rules match the file path.
- **Scope:** `databases` / `schemas` / `relations` accept `*` globs; absent
  means "all". `deny` wins over `allow`. A user has exactly one role (D5), so
  there is no cross-role merge to define.
- **Verbs:** `select`, `insert`, `update`, `delete`, `ddl`, `export`
  (reading is not exporting: it is the channel data leaves by), `monitor`
  (Pulse, sessions, the Security panel — they show *other users'* statement
  text, which can carry data from relations this role cannot read).
- **`ai ⊆ human`** is validated when the policy is loaded; a violating rule is
  **intersected** at runtime and reported in diagnostics, never widened.
- **Endpoints no rule matches** are unreachable for managed users when
  `unmanagedConnections` is `"deny"`; with `"allow"` they behave as today
  (a developer's local SQLite, say). Default: `"deny"`.

### 5.4 Failure: closed, never open

An anchor that exists but cannot be read or parsed, or a `source` that cannot be
reached, **fails closed**: managed endpoints become read-nothing for people and
unreachable for the AI, with a banner naming the source and the error. It never
falls back to "unmanaged", and there is no cached copy to fall back to (D6): a
machine that reaches its database but not the share cannot use managed
endpoints until the share is back.

## 6. Enforcement

### 6.1 The AI — airtight

Every AI request, from the MCP sidecar and from the AI panel, is a
`BridgeRequest`, and every one of them is executed by **one function**,
`bridge::exec::execute`. It has exactly four callers, and all four act for an
AI:

| Caller | Path |
|--------|------|
| `bridge/server.rs` | MCP sidecar served by the running app |
| `mcp/mod.rs` (`Huginn::call`) | MCP sidecar running alone, owning its own pools |
| `ai/exec.rs` | the AI panel's agent mode |
| `ai/tasks.rs` | the AI panel's assisted tasks — which today skip `check_policy` |

Policy is checked **there**, not in `bridge::server`: `check_policy` in the
server misses the sidecar running alone, the assisted tasks and every read.
The subject is always the AI, so no caller parameter is needed.

- **Discovery is filtered, not refused.** `ListDatabases` and `ListTables` are
  filtered on their typed `Vec` before it is serialised, so a model does not
  learn the names of relations it cannot read.
- **Structured tools** (`browse_table`, `describe_table`, `insert_row`,
  `update_cell`, `delete_rows`, …) name their relation, so they are checked
  exactly: scope, then verb (`insert_row` → `insert`, `update_cell` →
  `update`, `delete_rows` → `delete`).
- **`run_query` / `run_write`** are allowed only where the rule's scope is the
  whole endpoint (D3). Where it is not:
  - in the **AI panel** they are removed from the catalogue, as metadata-only
    mode already removes the row tools (`ai::tools::catalogue`);
  - over **MCP** they are refused at call time. The MCP tool list cannot vary
    per connection: clients cache `tools/list` for the session, which is why
    only `--read-only` ever changes it (ADRs #58, #59).
- `pulse_*`, `list_users` and `list_privileges` require `monitor`.
- The per-variant mapping is an exhaustive `match` with no `_` arm (gotchas
  #49, #71), so a new `BridgeRequest` variant cannot be added without deciding
  what policy it needs.
- The audit log records the OS user and the resolved role on every call.

Three things do **not** pass through `execute` and are checked where they are:

- `EnsureConnected`, intercepted by `bridge/server.rs` and by the sidecar's
  `ensure_connected`: refused unless some rule of the role matches the endpoint.
- The MCP `list_connections` tool, which never builds a `BridgeRequest`: it
  hides the connections the role cannot reach.
- The local per-connection settings, which policy can only **narrow**: the
  effective MCP write policy is policy ∩ `mcp_write`, and `mcp_exposed` /
  `ai_enabled` are still required.

The AI's exposure map in `ai/tools.rs` stays exhaustive with no `_` arm
(ADR #71); policy adds a check, it does not add an escape hatch. Convention #49's
three unenforced `_ => None` arms are a hazard here: phase 1 must make at least
`policy_id_of` exhaustive before policy depends on it.

### 6.2 People — guardrail, enforced in the backend

Enforced in the Tauri **commands**, with the UI mirroring the result, so hiding
a button is never the only thing that stands in the way:

- explorer: databases/relations outside scope are not listed;
- grid: insert / edit / delete follow the verbs;
- query editor: absent for scoped rules (D3);
- structure editor, import, JSON-row insert: need `ddl` / `insert`;
- export: needs `export`; Pulse / Security panel: need `monitor`;
- every locked control shows *managed by your organization*.

### 6.3 Why free SQL is not filtered (D3)

To allow free SQL under a relation scope, HuginnDB would have to name every
relation a statement touches: through views, CTEs, functions, synonyms,
cross-database names, dynamic SQL (`EXEC`, `PREPARE`, `sp_executesql`) and the
system catalogs. `classify` was already caught out by a far easier question
(ADR #76). A best-effort extractor can come later as a *warning*; it must
never be the thing a customer's restriction depends on. Where free SQL is
needed under a scope, the answer is a restricted database user (§7), and a
later version may allow free SQL on a rule that declares it is backed by one.

### 6.4 Splitting the write tier

Classification gains a **set** of verbs (`db::classify::verbs_of`, still the
union over every statement in the batch, ADR #76) that `DataWrite` is split
into. `StmtClass` stays, *derived* from the set, so the existing `== Read`
checks and ADR #54's single-source rule keep holding without touching every
caller. Mixed statements claim every verb they can perform, and a statement
nothing recognises claims all three write verbs — the same conservative side
today's `DataWrite` default takes:

| Statement | Verbs |
|-----------|-------|
| `INSERT … ON CONFLICT DO UPDATE` / `ON DUPLICATE KEY UPDATE` / upsert | insert + update |
| `MERGE` | insert + update + delete |
| MySQL `REPLACE` | insert + delete |
| `TRUNCATE` | ddl (unchanged) |
| Mongo `insert*` / `update*` / `replaceOne` / `delete*` | insert / update / update / delete |
| Mongo `aggregate` ending in `$out` / `$merge` | ddl / insert + update |
| Mongo `findOneAndReplace` / `findOneAndUpdate` / `findOneAndDelete`, `bulkWrite` | not in the grammar today (refused as unsupported); when added: update / update / delete, and the union of its operations |

`McpWritePolicy` survives as the unmanaged per-connection setting and maps
onto the verb sets (`ReadOnly` = {select}, `Data` = {select, insert, update,
delete}, `Full` = + ddl). On a managed endpoint it can only narrow (§4).

## 7. Making it real for people: per-user credentials and `GRANT` generation (D2)

- An origin can already publish a connection whose consumers keep their own
  password (`ConnectionProfile::secret_override`, ADR #69). Per-user
  credentials need the same for the **user name**.
- From a role's rules HuginnDB generates a script for a database role —
  PostgreSQL / MySQL / SQL Server `GRANT`s, MongoDB `createRole` privileges —
  for the admin to review and run. HuginnDB never runs it by itself.
- Catalog visibility is part of the script where the engine allows it, and the
  script's comments say what it cannot hide:
  - MySQL and SQL Server only show objects the user holds a permission on;
    SQL Server's `sys.databases` still lists every database unless
    `VIEW ANY DATABASE` is revoked from `public`, which the script offers.
  - MongoDB: `listCollections` / `listDatabases` with `authorized*`.
  - PostgreSQL: `information_schema` is filtered, but `pg_catalog` shows every
    relation **name** to everyone. Data stays protected; names do not.
  - SQLite has no users; only the file's ACL protects it.

## 8. Prior art

**VS Code enterprise policies.** Windows Group Policy (ADMX/ADML templates,
values under `HKLM\Software\Policies\Microsoft\VSCode`, since 1.69), macOS
`.mobileconfig` profiles (1.99), Linux `/etc/vscode/policy.json` (1.106). A
policy overrides the setting at every level and the UI marks it as managed by
the organization; *Developer: Policy Diagnostics* reports what applied.
Relevant policies: `AllowedExtensions`, `ChatMCP`,
`ChatAllowedMcpServers` / `ChatDeniedMcpServers`, `ChatAgentMode`,
`ChatToolsAutoApprove`, `TelemetryLevel`, `UpdateMode`. Its policies are per
machine with no roles — differentiation comes from GPO targeting AD groups,
which is why this design carries roles inside the document instead.

**Claude Code managed settings.** `managed-settings.json` in
`C:\Program Files\ClaudeCode\` (or the same JSON under
`HKLM\SOFTWARE\Policies\ClaudeCode`), above every other settings level;
permission rules per tool as `allow` / `ask` / `deny` with deny winning; a
present-but-unparseable admin source **refuses to start**; `HKCU` is only a
fallback because it is user-writable. Its docs note a local administrator can
edit the managed source — which holds here too.

## 9. Phases

0. **Prerequisite — trust the classifier** — *shipped* (PR #186). Mapping `StmtClass`'s
   call sites for this work found three writes classified as reads — a `WITH`
   carrying DML, `EXPLAIN ANALYZE`, and a MongoDB `aggregate` ending in
   `$out`/`$merge` — which a `read-only` MCP connection and the AI panel let
   run. Fixed in the classifier, plus a read-only transaction around every read
   an AI sends (ADR #93). The verb split builds on it, so it lands first.
1. **Core, AI enforcement** — *shipped* (PRs #188, #189; ADR #94). Verb split in `classify` (§6.4) with tests; a
   pure resolver *(policy, user, endpoint, relation, verb) → allow/deny* with
   exhaustive tests; anchor loading (§5.2) and fail-closed (§5.4); enforcement
   in `bridge::exec::execute` plus the three paths outside it (§6.1); a
   read-only **Policy diagnostics** view: source, state, user, role, effective
   permissions per connection.
   *Done:* a managed user's AI cannot list, read or write outside its rule,
   proven by tests at the bridge.
2. **People** — *shipped* (ADRs #95–#96). Command-level enforcement
   (every command guarded, a test holds the list complete) and UI mirroring
   (§6.2): locked controls with the reason, locked tabs, a window bar while
   the policy is loading or broken, `unmanagedConnections`.
3. **Real enforcement for people** — *shipped* (ADRs #97–#98). A
   person's own database user (a rule's `dbUser`, or their own choice on an
   origin connection, with the shared secret no longer landed), and the
   `GRANT` / `createRole` script generated from a role against the live
   catalog (§7), which HuginnDB never runs.
4. **Authoring.** The in-app editor — *shipped* (ADRs #99–#100): form and
   JSON over one draft, validated by the parser that applies it, "view as"
   under the draft, saved only where the share accepts a write, and a "create
   policy" wizard. ADMX/ADML templates for GPO — *open*.
5. **Column limits** — *shipped* (ADR #113). A rule's `columns.insert` /
   `columns.update` narrow which columns those verbs write, on every relation
   the rule reaches; checked as a `Need::Columns` beside the relation's verb,
   for the AI at the bridge and for people in each row-writing wrapper; locked
   per column in the grid, picked from the rule's tables in the editor, and
   granted per column by the script (`UPDATE (…)` everywhere, `INSERT (…)`
   except on SQL Server, which has no such permission). Hiding columns from
   reading is *open*: it touches every surface that shows a row (browse,
   export, copy, the AI's tools), and on SQL Server a `SELECT *` over a denied
   column fails outright.

Not in any phase: AD/LDAP identity, a gateway server, filtering free SQL.

## 10. Open questions

Closed (2026-09-24):

- ~~Q1 — Signing~~ → no (D6). Tampering is prevented by the share's
  permissions: only administrators may write the policy file, which the admin
  documentation must say in so many words.
- ~~Q2 — Offline~~ → no cache (D6). A machine that reaches its database but
  not the share is rare, and blocking is the safe answer.
- ~~Q3 — Multiple roles per user~~ → one role (D5).

Open:

- **Q4 — Licence.** The repository is MIT. If managed policy is the part that
  is sold, it needs a separate licence (open core). A business decision, to
  settle before phase 1 ships publicly.
