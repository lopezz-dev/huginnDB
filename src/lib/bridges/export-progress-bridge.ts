/**
 * The backend's per-table export progress event.
 *
 * `export_databases` (`src-tauri/src/commands/dump.rs`) writes with a
 * blocking `SELECT * FROM <table>` per table, so a determinate `done`/`total`
 * — real row counts, not tables, since a schema mixing a 3-row table with a
 * 3-million-row one makes per-table progress meaningless — only advances
 * once per table. Mirrors `import-progress-bridge.ts`'s shape.
 */

import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** Mirrors `EXPORT_PROGRESS_EVENT` in `src-tauri/src/commands/dump.rs`. */
const EXPORT_PROGRESS_EVENT = "huginndb://export-progress";

export interface ExportProgress {
  done: number;
  total: number;
}

/**
 * Run `task` with `onProgress` subscribed to the export-progress event.
 *
 * Scoped to this window's label — the backend emits with `emit_to`, and a
 * bare `listen()` would default to `EventTarget::Any` and still receive a
 * *different* window's export (gotcha #25).
 */
export async function withExportProgress<T>(
  onProgress: (p: ExportProgress) => void,
  task: () => Promise<T>,
): Promise<T> {
  const label = getCurrentWindow().label;
  const unlisten = await listen<ExportProgress>(
    EXPORT_PROGRESS_EVENT,
    (e) => onProgress(e.payload),
    { target: label },
  );
  try {
    return await task();
  } finally {
    unlisten();
  }
}
