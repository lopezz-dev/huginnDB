/**
 * Reading the app lock's answers.
 */

/**
 * Stable start of every `AppError::Locked` message — `LOCKED_TAG` in
 * `src-tauri/src/error.rs`. Errors cross IPC as strings, so this is all a
 * caller can match; keep the two in sync.
 */
export const LOCKED_TAG = "HuginnDB is locked";

/** Whether `error` is the backend refusing because the app is locked. */
export function isLockedError(error: unknown): boolean {
  return String(error).startsWith(LOCKED_TAG);
}

/** Whole seconds left of a wait, rounded up so "0" is never shown while one
 *  is still owed. */
export function secondsLeft(ms: number): number {
  return Math.max(0, Math.ceil(ms / 1000));
}

/**
 * A function that reports activity at most once per `everyMs`. Every key
 * press and mouse move calls it; the backend hears about a few of them,
 * which is all an idle timeout measured in minutes needs.
 */
export function createActivityReporter(
  report: () => void,
  everyMs = 30_000,
  now: () => number = Date.now,
): () => void {
  let last = Number.NEGATIVE_INFINITY;
  return () => {
    const at = now();
    if (at - last < everyMs) return;
    last = at;
    report();
  };
}
