/**
 * Comparing `mongosh` versions, for "is there something newer than the copy
 * HuginnDB downloaded".
 *
 * Only plain `major.minor.patch` is understood — the backend offers stable
 * releases and names its version directories that way — and anything else
 * compares as "not newer", so a malformed answer never raises an Update button.
 */

function parts(v: string): [number, number, number] | null {
  const m = /^\s*(\d+)\.(\d+)\.(\d+)\s*$/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Whether `candidate` is a newer release than `installed`. */
export function isNewerVersion(candidate: string, installed: string): boolean {
  const a = parts(candidate);
  const b = parts(installed);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}
