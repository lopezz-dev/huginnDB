/**
 * Gate a destructive action behind the user's `ui.confirmDestructive`
 * preference.
 *
 * When the preference is enabled (the default) this awaits the app's own
 * `ConfirmHost` dialog (via `useConfirmRequest`) and resolves with the
 * user's answer. When the user has turned confirmations off, it resolves
 * `true` immediately so the caller proceeds without prompting.
 *
 * Async now, where this used to block on `window.confirm` synchronously —
 * every call site already `await`s it (or checked its old boolean return
 * the same turn), so the shape at each call site barely changed. What did
 * change: nothing else on screen was blocked while the native dialog was
 * up, so a call site that reads state after the `await` must re-read it
 * rather than trust what a closure captured before — see
 * `DocumentListView.tsx`'s `deleteField` for the one place that mattered.
 *
 * Read from the store imperatively (not via a hook) so it can be called from
 * event handlers and non-component code paths alike.
 *
 * NOTE: `DROP TABLE` (the schema tree's `DropObjectDialog`) uses its own dedicated, always-on
 * confirmation dialog rather than this preference-gated helper — dropping a
 * table is a higher safety tier, so it is confirmed regardless of this toggle.
 */

import { usePreferences } from "@/stores/preferences/preferences";
import { useConfirmRequest } from "@/stores/dialogs/confirmRequest";

export async function confirmDestructive(message: string): Promise<boolean> {
  const enabled = usePreferences.getState().prefs.ui.confirmDestructive;
  if (!enabled) return true;
  return useConfirmRequest
    .getState()
    .request({ tone: "destructive", message });
}

/**
 * Confirm an **irreversible** action, ignoring `ui.confirmDestructive`.
 *
 * The preference exists so a user who knows what they are doing isn't nagged
 * about actions they can undo or redo — deleting a row they can re-insert,
 * emptying a table they can repopulate. It was never meant to be a blanket
 * "never ask me anything", and reading it that way turns one stale toggle into
 * silent data loss.
 *
 * Use this instead whenever the thing being destroyed exists nowhere else and
 * cannot be reconstructed from the database: an environment's tabs and pane
 * layout, a registered origin's stored passphrase. `DROP TABLE` already had its
 * own always-on dialog for the same reason; this is that rule made shared
 * instead of re-implemented per call site.
 *
 * If in doubt about which helper an action wants, ask: *could the user get this
 * back?* If the answer is no, it belongs here.
 */
export async function confirmIrreversible(message: string): Promise<boolean> {
  return useConfirmRequest
    .getState()
    .request({ tone: "irreversible", message });
}
