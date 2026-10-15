/**
 * Where a connection profile came from: the user, or a shared origin (#108).
 *
 * A profile carrying an `origin_id` is a local mirror of an entry some shared
 * file publishes. That makes it read-only in the editor, and — the reason this
 * module exists rather than the predicate being re-inlined a fourth time —
 * pointless to delete: `merge_profiles_bundle` matches and inserts by the
 * *published* id (`src-tauri/src/commands/origins.rs`), so a locally deleted
 * mirror comes back identical on the next sync. Removing one for real means
 * removing the origin, which is a different flow with its own notices.
 *
 * Deliberately NOT the same predicate as the `p.origin_id === origin.id`
 * comparisons in `originSync.ts` / `OriginsSection.tsx`: those ask "does *this*
 * origin own it", which is ownership, not provenance. Don't unify them.
 *
 * The field is snake_case because `ConnectionProfile` mirrors a Rust struct with
 * no `rename_all`, while `Origin` and `Environment` do carry one (`originId`).
 * Both conventions coexist on purpose (gotcha #14's neighbourhood).
 */

/** Anything that carries a profile's provenance field. */
export type HasOrigin = { origin_id?: string | null };

/** Is this profile a mirror published by a shared origin? */
export function isFromOrigin(p: HasOrigin | null | undefined): boolean {
  return !!p?.origin_id;
}

/**
 * Id of the origin that owns this profile, or `null` when it is local.
 *
 * Normalises the empty string to `null` so a blank field — which serde will
 * happily round-trip — can never be mistaken for an origin nobody can look up.
 */
export function originIdOf(p: HasOrigin | null | undefined): string | null {
  return p?.origin_id ? p.origin_id : null;
}

/** Which provenance the connection list is showing. */
export type ProfileScope = "all" | "local" | "shared";

/**
 * Narrow a profile list to one provenance.
 *
 * `all` returns the very array it was handed — not a copy — so the caller's
 * `useMemo` chain downstream of it doesn't invalidate on every render for the
 * scope that changes nothing (gotcha #1's cousin: a fresh array is a fresh
 * dependency).
 */
export function filterByScope<T extends HasOrigin>(
  items: T[],
  scope: ProfileScope,
): T[] {
  if (scope === "all") return items;
  if (scope === "local") return items.filter((p) => !isFromOrigin(p));
  return items.filter((p) => isFromOrigin(p));
}
