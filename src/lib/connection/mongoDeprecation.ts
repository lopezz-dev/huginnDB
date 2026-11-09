/**
 * MongoDB server versions on their way out, and the one check that decides
 * whether a connected server is one of them.
 *
 * mongodb 3.9 (the Rust driver) refuses any server below wire version 9,
 * i.e. MongoDB 4.4. The app holds the driver on 3.8 for now so that MongoDB
 * 4.2 servers still connect, and the first release cut on or after
 * {@link MONGO_LEGACY_CUTOFF} lifts that pin — from then on a 4.2 server does
 * not connect at all. Until then, everyone who opens one is told so, because
 * the changelog is not where a person connecting to a database looks.
 *
 * Pure on purpose: the parse is the part worth testing, and it must not need
 * a server.
 */

/** The date after which a release may stop connecting to MongoDB 4.2. ISO, so
 *  the notice can format it in the interface's locale. */
export const MONGO_LEGACY_CUTOFF = "2026-12-01";

/** Oldest MongoDB the current driver line supports without the pin. */
const MIN_SUPPORTED: readonly [number, number] = [4, 4];

/**
 * Whether `serverVersion` — the string the `server_version` command answers
 * for a MongoDB connection, `"mongodb 4.2.24"` — names a server older than
 * 4.4. Anything it cannot read (`"mongodb ?"`, another driver's string) is
 * `false`: a notice that might be wrong is worse than none.
 */
export function isLegacyMongoVersion(serverVersion: string): boolean {
  const m = /^mongodb\s+(\d+)\.(\d+)/i.exec(serverVersion.trim());
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const [minMajor, minMinor] = MIN_SUPPORTED;
  return major < minMajor || (major === minMajor && minor < minMinor);
}

/** The bare `X.Y.Z` of a `"mongodb X.Y.Z"` string, for the notice's text. */
export function mongoVersionNumber(serverVersion: string): string {
  return serverVersion.trim().replace(/^mongodb\s+/i, "");
}
