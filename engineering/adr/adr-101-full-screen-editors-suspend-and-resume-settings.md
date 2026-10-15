---
id: 101
type: adr
status: accepted
date: 2026-09-25
date_note: extended the same day to the connection manager
tags: [ui, ux]
triggered_by_external_trap: false
related: []
supersedes: []
superseded_by: null
amends: []
---

# ADR #101: A full-screen editor puts aside the workbench it was opened from, then gives it back

Settings is a `workbench` dialog, and so are the shared-origin editor (`OriginEditorOverlay`), the managed-policy editor (`PolicyEditorDialog`) and the connection manager (`ConnectionDialog`). Both editors are opened from a Settings section, and the origin editor is also opened from the connection manager. A workbench is never stacked on another one: Radix traps focus in whichever mounted last. The origin editor already followed that rule, but only halfway.

**Decision:** useSettingsDialog and useConnectionDialog expose suspend()/resume(); useOriginEditor records which surface it set aside (returnTo) and resumes only that one; editors are mounted as siblings of Settings in App.

**Alternatives rejected:**

- Rendering the policy editor inside Settings (stacked workbench) — replaced because closing Settings unmounted the editor and Radix traps focus in the last-mounted dialog.
- Closing Settings on entry without reopening it — the previous origin-editor behaviour, fixed.
- Calling resume() on every surface — rejected; recording the name makes 'only the one set aside' hold by construction.
- EmptyWatermark mounting its own ConnectionDialog instance — replaced by one store-reachable mount in FileMenu.

## What was wrong

- **The origin editor closed Settings on the way in and never reopened it.** Leaving the editor, saved or not, dropped the user on the main window, not back in Settings → Origins where they came from. Alex found it on 2026-09-25.
- **The policy editor broke the rule.** It was rendered inside Settings → Policy, a workbench stacked on a workbench. It looked fine because closing it revealed Settings underneath. But anything that closed Settings also unmounted the editor, since the editor was a child of it.
- **The connection manager's "edit at origin" link broke it too.** It opened the origin editor with the manager still open underneath. The first fix only knew how to put Settings aside, so this entry was left as it was.

## Detail

- **`useSettingsDialog` has `suspend()` and `resume()`.**
  - `suspend()` closes Settings and records `suspendedAt = section`. It does nothing if Settings is not open, and it returns whether it closed it.
  - `resume()` reopens Settings on `suspendedAt` and clears it. It does nothing if `suspend()` did not close Settings.
  - `openAt`, `openAtPref` and `setOpen` clear `suspendedAt`. An explicit open or close supersedes a pending return.
- **`useConnectionDialog` has the same pair, keyed on a profile instead of a section.**
  - `ConnectionDialog` reports the profile on screen with `focus(editingId)`. The user can move off the profile the manager was opened on by clicking another one in the rail, so `initialId` is not enough.
  - `suspend()` closes the manager and records `suspendedAt = { profileId: focusedId }`. It is wrapped because a new draft (`null`) is itself a place to return to.
  - `resume()` reopens the manager with `initialId = suspendedAt.profileId`. `FileMenu` resolves it against the live list, so a profile deleted in the meantime falls back to a new draft.
  - `openNew`, `openManage` and `setOpen` clear `suspendedAt`.
  - The unsaved form is not preserved. Reopening reloads the profile as it is saved, because the manager's load effect runs on `open`.
- **`useOriginEditor` remembers which surface it set aside (`returnTo: "settings" | "connections" | null`).** `open` asks each surface in turn to `suspend()` and records the first that did; `close` calls `resume()` on that one only. The surfaces are all workbenches, so at most one is open. Recording the name here, rather than calling `resume()` on everything, is what makes "only the one that was set aside" hold by construction.
- **`usePolicyEditor` still calls Settings directly.** It is only ever opened from Settings → Policy, so it needs no `returnTo`.
- **Each editor is a store plus a sibling of Settings in `App`.** `App` mounts `<OriginEditorOverlay />` and `<PolicyEditorHost />` next to `<SettingsDialog />`, never inside it.
- **"Return to where it came from" falls out of how the editor was opened, without a flag.**
  - From Settings → Origins, the editor returns to Settings → Origins.
  - From the manager's banner, it returns to the manager on that connection.
  - From the republish prompt's conflict hand-off, it returns to the manager when a save left the manager open. It stays closed when a connect had already closed it.
  - Opened with neither up, it reopens nothing.
- **There is one `ConnectionDialog` mount, `FileMenu`.** `EmptyWatermark` used to mount its own instance with local `useState`. No store could reach that instance, so the origin editor could not put it aside. It now calls `useConnectionDialog.openNew()`. A side effect: connecting from the empty workspace now selects the connection (`FileMenu`'s `onConnected`).
- **`usePolicyEditor` holds a snapshot of the `PolicyStatus`** that Settings → Policy was showing. The editor needs it only for the current account, which it uses as the template's author and for the "your own role changes" warning. `onSaved` is optional now, because Settings → Policy reads the status again when `resume()` remounts it.
- **Panel dialogs on top of a workbench are not affected.** `GrantScriptDialog`, `CaptureShortcutDialog`, `ImportVsCodeThemeDialog` and the republish prompt are `panel`/`prompt` tier. A small dialog over a workbench is the app's normal pattern (`ConfirmDialog` does the same). The rule is about one workbench on another.
- Tests: `stores/dialogs/settingsReturn.test.ts` and `stores/dialogs/connectionDialogReturn.test.ts`.
