---
id: 100
type: adr
status: accepted
date: 2026-09-24
tags: [policy, ui, ux]
triggered_by_external_trap: false
related: [99]
supersedes: []
superseded_by: null
amends: []
---

# ADR #100: The policy editor's draft is text, the form is a view of it, and it opens for everyone

The interface half of phase 4. It is the `PolicyEditorDialog` in `settings/dialogs/`, with its panes in `settings/policyEditor/` and the pure helpers in `lib/policy/draft.ts`, built on the backend of ADR #99.

**Decision:** The policy editor keeps the JSON text as the only source of truth with the form as a view of it, validates through the backend, always opens (showing read-only when the share is not writable), and has servers/databases/tables picked from catalogs.

**Alternatives rejected:**

- A form that keeps its own model — rejected so form and JSON cannot disagree.
- Re-implementing validation rules in the frontend — rejected; the backend parser validates.
- A locked entry button decided up front by probing the share — the plan had one; replaced because probing creates and deletes a file every time Settings opens.
- Free-text boxes for servers and tables — first version, replaced because a misspelled name silently grants nothing.
- Writing an incomplete endpoint `{ host: "" }` on mode switch — first version, replaced because the parser rejects it.
- Drawing the rail with Button — replaced by the shared ui/nav-rail.tsx.
- A NativeSelect for the server pickers — replaced by the connection form's Radix Select with DriverBadge.

## Detail

- **One source of truth: the text.** The dialog holds `text`.
  - The form panes edit the object `parseDraft(text)` returns, using the pure, immutable helpers in `lib/policy/draft.ts`, and write it back with `formatDraft` (two-space JSON and a final newline).
  - The JSON pane edits the text directly.
  - The form never keeps a model of its own, so it and the JSON cannot disagree. A field this version does not know is carried along untouched, because the helpers spread the object rather than rebuild it, and JavaScript keeps key order.
  - While the text is not JSON, the form panes show "fix it in the JSON pane" instead of guessing what was meant.
- **The backend is the validator.** `policy_validate` runs on a debounce (`useDebouncedPreview`) with the parser that applies the policy. Its error is shown above whichever pane is open, and Save is disabled while there is one.
  - The frontend does not re-implement the rules. The only mirrors are `normaliseUser` and `expandDbUser`, used for the live `dbUser` example and the duplicate-account flag, and they are small enough to test side by side.
  - The save refuses invalid text in any case (ADR #99).
- **Removing and renaming keep the policy valid.**
  - `renameRole` moves the users and `defaultRole` along with the role.
  - `removeRole` refuses the default role and any role someone is in. The button is disabled with the reason, rather than producing a draft the parser would reject.
  - AI permissions the person lacks cannot be ticked. Unticking a person's permission also removes it from their AI, because `ai ∩ human` is what applies (D1). Offering it would only produce a warning.
- **The editor opens for everyone. There is no locked entry button.**
  - Deciding up front whether the share is writable would mean probing it, which creates and deletes a file, every time someone opens Settings.
  - Instead, "Edit policy" (or "Create policy" when unmanaged) always opens. The editor's header then says read-only, with Windows' reason from the probe `policy_open_for_edit` already ran, and the form is locked.
  - The plan had a locked button. This replaces it on purpose.
- **Create and export are one mode.** When the anchor is not a `file`, the dialog creates instead of saving:
  - `none` starts from `templatePolicy(currentUser)`: `defaultRole: "none"` with nothing in it, the author in an `admin` role with every permission, and `unmanagedConnections: "deny"`. The first policy an organization writes therefore cannot lock its author out.
  - `registry` or `systemFile` starts from the inline text, to be moved to a file.

  Both ask for a path, with a native picker as an option. `CreatedView` then shows the `reg add` command, the registry key, value and data for GPO or Intune, and the backend's warnings, such as a path that is not UNC.
- **The confirmation says what changes.** `summarizeChanges(saved, draft)` lists:
  - roles added and removed, and roles whose rules changed;
  - accounts added, removed and moved between roles;
  - the default role and unmanaged changes.

  It warns in amber when a `dbUser` appears for the first time (older versions read it as Broken) and when the editing account's own role changes. It always says that the policy applies here at once and elsewhere within five minutes.
- **A conflict keeps what was typed.** A `conflict` outcome means someone else saved first. The user's text goes to the clipboard, the header turns stale with "Load their version", and the form becomes read-only until the user reloads, so nothing is written over their save.
- **Names are picked, not typed.** A rule naming a server or a table that does not exist grants nothing and says nothing, so the first version's free-text boxes were the dangerous path. (Alex caught it in review.)
  - The server is picked from this computer's saved connections (`EndpointField`, mode "a saved connection"). Typing it is the second path ("by hand"), kept for a server this computer has no connection to.
  - **Switching mode never writes an incomplete endpoint.** The first version wrote `{ host: "" }` the moment "a server" was chosen. The parser rejects that, so the editor flashed "the policy is not valid" at a user who had done nothing wrong. The rule now keeps its previous server until a connection is picked or a host is typed, and says so.
  - Databases and tables are a `NamePicker`: chips for what the rule names, plus a searchable checklist of the server's catalog. The databases come from `list_databases`, and the tables from `list_tables` on each named database's `::db::` view (the first four named). The catalog is read only when the rule's saved connection is **open**, and the rule offers to connect it (`connectAndWarm`).
  - Both reads use the guarded commands, so the names offered are what the editing person's own role can see. That is the right source for someone writing rules about data they can reach.
  - A pattern (`v_factura_*`) is still added by typing, because the catalog cannot offer one. The field says which real names it matches before it is added.
  - A chip the loaded catalog does not contain is amber, with a tooltip. It is a warning, not a refusal: a table that does not exist yet is a legitimate rule.
  - `matchesOf` mirrors `glob_matches`: `*` is the only wildcard, and matching ignores case.
  - The two server pickers (the saved connection, and the driver when typing by hand) are the connection form's Radix `Select` with `DriverBadge`, logos included, not a `NativeSelect`. "Any driver" is the value `any`, because Radix reserves `""`.
- **Removing a role or a rule asks first** (`confirmDestructive`, so `ui.confirmDestructive` still governs it). The removal only touches the draft and "Discard changes" undoes it, but the buttons are small and sit next to the row they act on, and one slip used to take a rule with it silently. The message names the role, its rule count, or what the rule granted.
- **The rail is `ui/nav-rail.tsx`.** The first version drew it with `Button`, and it drifted from the Settings and origin-editor rails (rounded corners, an inset, a hover that did not line up). `NavRailItem` is now what all three render, which also takes two raw `<button>`s off the adoption budget.
