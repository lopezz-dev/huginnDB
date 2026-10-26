/**
 * The managed policy's one wildcard, `*`, matched the way the backend matches
 * it (`policy::resolve::glob_matches`): any run of characters, ignoring case.
 * The interface uses it to say ahead of time what the backend will decide —
 * which catalog names a pattern picks, and which columns a person may write
 * (ADR #113). The backend still decides on its own either way (ADR #96).
 */

/** Whether a name is a pattern rather than a literal name. */
export const isPattern = (s: string) => s.includes("*");

function globRegex(pattern: string): RegExp {
  const body = pattern
    .split("")
    .map((c) => (c === "*" ? ".*" : c.replace(/[.+?^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${body}$`, "i");
}

/** Whether `text` matches `glob`. */
export function globMatches(glob: string, text: string): boolean {
  return globRegex(glob.trim()).test(text);
}

/** Which of `names` a pattern (or a plain name) lets through. */
export function matchesOf(pattern: string, names: string[]): string[] {
  const re = globRegex(pattern.trim());
  return names.filter((n) => re.test(n));
}

/** The top-level field of a MongoDB field path: `address.zip` → `address`. */
export function topLevelField(path: string): string {
  const dot = path.indexOf(".");
  return dot < 0 ? path : path.slice(0, dot);
}

/**
 * Whether a column limit lets a verb write `column`. `null` (or absent) means
 * the verb is not limited to some columns; an empty list means it reaches
 * none. Whether the verb is granted at all is a separate question.
 */
export function columnAllowed(limit: string[] | null | undefined, column: string): boolean {
  if (!limit) return true;
  return limit.some((g) => globMatches(g, column));
}
