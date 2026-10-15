/**
 * The backend's per-secret progress event while a shared-origin document is
 * being published.
 *
 * A separate event from `huginndb://import-progress` even though the payload is
 * identical, and for the reason the Rust side gives at
 * `ORIGIN_PUBLISH_PROGRESS_EVENT`: an event whose name says "import", emitted by
 * a publish, is a wire contract that lies — and a window doing both at once
 * could never tell the two apart.
 *
 * The reason either exists is the same, though: encrypting a secret is
 * deliberately slow (PBKDF2 at 600 000 iterations), so a document publishing a
 * dozen passwords takes long enough that a determinate bar beats a spinner.
 * Nothing is emitted when every envelope travels verbatim — which is the common
 * case, and the one that is instant.
 */

import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** Mirrors `ORIGIN_PUBLISH_PROGRESS_EVENT` in
 *  `src-tauri/src/commands/origin_doc.rs`. */
const ORIGIN_PUBLISH_PROGRESS_EVENT = "huginndb://origin-publish-progress";

export interface PublishProgress {
  done: number;
  total: number;
}

/**
 * Run `task` with `onProgress` subscribed to the publish-progress event.
 *
 * Unsubscribes and clears the progress on the way out whatever happens — a
 * leaked listener would keep feeding a closed dialog's setState, and a bar left
 * at 8/12 after a failure is worse than none.
 *
 * Scoped to this window's label: the backend emits with `emit_to`, but a bare
 * `listen()` defaults to `EventTarget::Any` and would still receive a *different*
 * window's publish (gotcha #25) — the same pattern as
 * `import-progress-bridge.ts` and `log-bridge.ts`.
 */
export async function withPublishProgress<T>(
  onProgress: (p: PublishProgress | null) => void,
  task: () => Promise<T>,
): Promise<T> {
  const label = getCurrentWindow().label;
  const unlisten = await listen<PublishProgress>(
    ORIGIN_PUBLISH_PROGRESS_EVENT,
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
