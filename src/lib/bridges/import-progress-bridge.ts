/**
 * The backend's per-item import progress event.
 *
 * Seven of the eight `huginndb://…` events already had a module here; this one
 * did not, so both import dialogs declared the name and the payload shape
 * themselves — two copies of a wire contract, in components.
 *
 * Decrypting a secret is deliberately slow (PBKDF2 at 600k iterations), so a
 * bundle of any size takes long enough that a determinate bar beats a spinner.
 * That is the only reason the event exists.
 */

import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** Mirrors `IMPORT_PROGRESS_EVENT` in `src-tauri/src/commands/connection.rs`. */
const IMPORT_PROGRESS_EVENT = "huginndb://import-progress";

export interface ImportProgress {
  done: number;
  total: number;
}

/**
 * Run `task` with `onProgress` subscribed to the import-progress event.
 *
 * Unsubscribes and clears the progress on the way out whatever happens —
 * a leaked listener would keep feeding a closed dialog's setState, and a
 * progress bar left at 8/12 after a failure is worse than none.
 *
 * Scoped to this window's label: the backend now emits with `emit_to`, but a
 * bare `listen()` defaults to `EventTarget::Any` and would still receive a
 * *different* window's import (gotcha #25) — see `log-bridge.ts`
 * for the identical pattern.
 */
export async function withImportProgress<T>(
  onProgress: (p: ImportProgress | null) => void,
  task: () => Promise<T>,
): Promise<T> {
  const label = getCurrentWindow().label;
  const unlisten = await listen<ImportProgress>(
    IMPORT_PROGRESS_EVENT,
    (e) => onProgress(e.payload),
    { target: label },
  );
  try {
    return await task();
  } finally {
    unlisten();
    onProgress(null);
  }
}
