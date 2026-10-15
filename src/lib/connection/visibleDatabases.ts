/**
 * The two-layer "databases to show" resolution, as one pure function.
 *
 * A connection's visible-database subset lives in two places on purpose (see
 * ADR #27): `LaunchState.databaseVisibility[connectionId]`, which
 * is per environment, overrides `ConnectionProfile.visible_databases`, which is
 * global and travels through export / shared origins. The override's value is
 * itself nullable — a stored `null` means "show all *here*", the only way an
 * environment can widen a subset the profile narrows — so `undefined` (no
 * override) and `null` (override to all) must never collapse into one thing.
 *
 * `useVisibleDatabases` (the hook every component uses) is a thin wrapper over
 * this; the command palette needs the same answer for many connections at once,
 * which a per-connection hook can't give inside a loop. Keeping the logic here
 * means there is still exactly one implementation to get right.
 */

/** `null` means "show everything"; an array is the allow-list. */
export function resolveVisibleDatabases(
  override: string[] | null | undefined,
  fromProfile: string[] | null | undefined,
): string[] | null {
  if (override !== undefined) return override;
  return fromProfile ?? null;
}
