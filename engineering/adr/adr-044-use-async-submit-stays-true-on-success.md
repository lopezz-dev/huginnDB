---
id: 44
type: adr
status: accepted
date: 2026-08-21
tags: [react, ui, ux]
triggered_by_external_trap: false
related: []
supersedes: []
superseded_by: null
amends: []
---

# ADR #44: useAsyncSubmit deliberately keeps submitting true after success

Every success closes or replaces the dialog, so clearing the flag first would re-enable buttons for the frames before unmount — a double-submit window on a destructive action. It shares one flag and error slot across a dialog's two actions.

**Decision:** Dialog submission goes through useAsyncSubmit, which keeps submitting true after success and shares one flag and error slot across a dialog's actions, with errors shown inside the dialog.

**Alternatives rejected:**

- Clearing submitting on success: re-enables buttons before unmount, a double-submit window on destructive actions.
- Hand-rolled submit state in each modal: replaced by the hook.
- A toast for a failed destructive action: the dialog stays open and must say why in place.

## Detail

**A dialog's submit half is `useAsyncSubmit`, and it keeps `submitting` true after a success.** Ten modals hand-rolled `setSubmitting(true); setError(null); try { … } catch { setError(String(e)); setSubmitting(false) }`, and the missing `setSubmitting(false)` on the success path is deliberate, not an oversight: every success closes or replaces the dialog, so clearing the flag first re-enables the buttons for the frames before the unmount lands — a double-submit window on a `DROP TABLE`. The hook takes no task at construction so a dialog with two actions (commit vs. clear an override) shares one flag and one error slot; validation (`if (!name.trim()) return;`) stays at the call site. Its natural partner is `ConfirmDialog`'s `error`/`children`/`confirmingLabel` slots — a failed destructive action has to say why *in* the dialog, which stays open, so a toast is the wrong surface there.
