/**
 * The documentation viewer's doc ids, in reading order — without the bodies.
 *
 * `docs.ts` is the registry, and it carries every guide's markdown in both
 * languages (hundreds of KB). It is only reached through the lazily loaded
 * Documentation viewer, so that text stays out of the startup bundle; the few
 * always-mounted places that only need to *name* a doc (the command palette's
 * "open this guide" entries) read this list instead. `docs.test.ts` pins it
 * to the registry, so the two cannot drift.
 */
export const DOC_IDS = [
  "connections",
  "environments",
  "shortcuts",
  "appLock",
  "jsonSchemas",
  "mongodb",
  "sqlserver",
  "pulse",
  "mcp",
  "ai",
  "policy",
] as const;

export type DocId = (typeof DOC_IDS)[number];

/** i18n key of a doc's title — the registry's `titleKey`. */
export const docTitleKey = (id: string) => `docs.entries.${id}.title`;

/** i18n key of a doc's one-line description — the registry's `descriptionKey`. */
export const docDescriptionKey = (id: string) => `docs.entries.${id}.description`;
