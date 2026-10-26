/**
 * Curated registry for the in-app Documentation viewer (Help → Documentation,
 * {@link ../components/shell/dialogs/DocsDialog}).
 *
 * Each entry bundles a user-facing markdown file from the repo `docs/` folder
 * at build time via Vite's `?raw` import — no network, works offline, mirroring
 * `lib/changelog.ts`. Only files listed here are shown; internal roadmaps in
 * `docs/` are deliberately left out. To surface a new doc: add its `?raw`
 * import + an entry here, and add its path to `DOC_FILES` in `vite.config.ts`
 * so its last-updated date is injected.
 *
 * Titles/descriptions are i18n keys (`docs.entries.<id>.*`). The body is
 * per-language, same idea as `getReleases` in `lib/changelog.ts`: English is
 * authoritative and always present; a translation (`docs/<Name>.<lang>.md`)
 * is optional and may lag behind — `getDocBody` falls back to English for any
 * language without one, so a missing translation never surfaces a blank
 * panel. `updated` reflects the English file's last git-commit date for both.
 */

import type { AppLanguage } from "@/types";
import { locate, parseDoc, slugify } from "./docOutline";
import connectionsRaw from "../../../docs/CONNECTIONS.md?raw";
import connectionsEsRaw from "../../../docs/CONNECTIONS.es.md?raw";
import environmentsRaw from "../../../docs/ENVIRONMENTS.md?raw";
import environmentsEsRaw from "../../../docs/ENVIRONMENTS.es.md?raw";
import jsonSchemasRaw from "../../../docs/JSON_SCHEMAS.md?raw";
import jsonSchemasEsRaw from "../../../docs/JSON_SCHEMAS.es.md?raw";
import mongodbRaw from "../../../docs/MONGODB.md?raw";
import mongodbEsRaw from "../../../docs/MONGODB.es.md?raw";
import sqlServerRaw from "../../../docs/SQL_SERVER.md?raw";
import sqlServerEsRaw from "../../../docs/SQL_SERVER.es.md?raw";
import pulseRaw from "../../../docs/PULSE.md?raw";
import pulseEsRaw from "../../../docs/PULSE.es.md?raw";
import mcpRaw from "../../../docs/MCP.md?raw";
import mcpEsRaw from "../../../docs/MCP.es.md?raw";
import shortcutsRaw from "../../../docs/SHORTCUTS.md?raw";
import shortcutsEsRaw from "../../../docs/SHORTCUTS.es.md?raw";
import aiRaw from "../../../docs/AI.md?raw";
import aiEsRaw from "../../../docs/AI.es.md?raw";
import policyRaw from "../../../docs/POLICY.md?raw";
import policyEsRaw from "../../../docs/POLICY.es.md?raw";
import appLockRaw from "../../../docs/APP_LOCK.md?raw";
import appLockEsRaw from "../../../docs/APP_LOCK.es.md?raw";

/**
 * Which rail heading a doc sits under. Ordered as the viewer draws them, and
 * deliberately the same four questions Preferences' rail asks ("what do I set
 * up first", "what is specific to my database", "what else can it do", "who
 * governs it") so a user moving between the two dialogs finds the same shape.
 */
export const DOC_GROUPS = ["start", "databases", "integrations", "organization"] as const;
export type DocGroup = (typeof DOC_GROUPS)[number];

export interface DocEntry {
  /** Stable id (used as the selected-doc key and React key). */
  id: string;
  /** The rail heading it is listed under (`docs.groups.<group>`). */
  group: DocGroup;
  /** i18n key for the sidebar title. */
  titleKey: string;
  /** i18n key for the one-line description under the title. */
  descriptionKey: string;
  /** Repo-relative path — the key into `__DOC_UPDATED__`. */
  path: string;
  /** Raw markdown body per UI language. `en` is always present. */
  bodies: Partial<Record<AppLanguage, string>> & { en: string };
  /** ISO last-updated date, or null when unavailable. */
  updated: string | null;
}

const dates: Record<string, string | undefined> =
  typeof __DOC_UPDATED__ !== "undefined" ? __DOC_UPDATED__ : {};

// Reading order, not alphabetical: a connection is the first thing anyone needs,
// the per-driver guides only matter once you have one, and MCP is the optional
// extra. Entries of one `group` must stay adjacent — the viewer's rail draws a
// heading each time the group changes, so a stray entry would split it in two
// (a test pins this). `DocsDialog` opens on its home page, which lists them all.
export const DOCS: DocEntry[] = [
  {
    id: "connections",
    group: "start",
    titleKey: "docs.entries.connections.title",
    descriptionKey: "docs.entries.connections.description",
    path: "docs/CONNECTIONS.md",
    bodies: { en: connectionsRaw, es: connectionsEsRaw },
    updated: dates["docs/CONNECTIONS.md"] ?? null,
  },
  {
    id: "environments",
    group: "start",
    titleKey: "docs.entries.environments.title",
    descriptionKey: "docs.entries.environments.description",
    path: "docs/ENVIRONMENTS.md",
    bodies: { en: environmentsRaw, es: environmentsEsRaw },
    updated: dates["docs/ENVIRONMENTS.md"] ?? null,
  },
  {
    // A keyboard-first tool's key map is part of getting set up, and it applies
    // to every driver, so it sits with the two "how do I get going" guides
    // rather than among the per-engine ones.
    id: "shortcuts",
    group: "start",
    titleKey: "docs.entries.shortcuts.title",
    descriptionKey: "docs.entries.shortcuts.description",
    path: "docs/SHORTCUTS.md",
    bodies: { en: shortcutsRaw, es: shortcutsEsRaw },
    updated: dates["docs/SHORTCUTS.md"] ?? null,
  },
  {
    // Setting up the machine, like the three above, and for every driver:
    // whether HuginnDB asks for a master password before it shows anything.
    id: "appLock",
    group: "start",
    titleKey: "docs.entries.appLock.title",
    descriptionKey: "docs.entries.appLock.description",
    path: "docs/APP_LOCK.md",
    bodies: { en: appLockRaw, es: appLockEsRaw },
    updated: dates["docs/APP_LOCK.md"] ?? null,
  },
  {
    // Cross-driver rather than per-driver, so it sits before the per-engine
    // guides: it applies to any column holding JSON, and `jsonb` on Postgres is
    // where it pays off as much as anywhere.
    id: "jsonSchemas",
    group: "databases",
    titleKey: "docs.entries.jsonSchemas.title",
    descriptionKey: "docs.entries.jsonSchemas.description",
    path: "docs/JSON_SCHEMAS.md",
    bodies: { en: jsonSchemasRaw, es: jsonSchemasEsRaw },
    updated: dates["docs/JSON_SCHEMAS.md"] ?? null,
  },
  {
    id: "mongodb",
    group: "databases",
    titleKey: "docs.entries.mongodb.title",
    descriptionKey: "docs.entries.mongodb.description",
    path: "docs/MONGODB.md",
    bodies: { en: mongodbRaw, es: mongodbEsRaw },
    updated: dates["docs/MONGODB.md"] ?? null,
  },
  {
    id: "sqlserver",
    group: "databases",
    titleKey: "docs.entries.sqlserver.title",
    descriptionKey: "docs.entries.sqlserver.description",
    path: "docs/SQL_SERVER.md",
    bodies: { en: sqlServerRaw, es: sqlServerEsRaw },
    updated: dates["docs/SQL_SERVER.md"] ?? null,
  },
  {
    // Right before MCP: MCP's own tools table sends the reader here for what
    // `pulse_metrics` and friends actually answer, so the feature guide
    // belongs immediately ahead of the connector that also exposes it.
    id: "pulse",
    group: "integrations",
    titleKey: "docs.entries.pulse.title",
    descriptionKey: "docs.entries.pulse.description",
    path: "docs/PULSE.md",
    bodies: { en: pulseRaw, es: pulseEsRaw },
    updated: dates["docs/PULSE.md"] ?? null,
  },
  {
    id: "mcp",
    group: "integrations",
    titleKey: "docs.entries.mcp.title",
    descriptionKey: "docs.entries.mcp.description",
    path: "docs/MCP.md",
    bodies: { en: mcpRaw, es: mcpEsRaw },
    updated: dates["docs/MCP.md"] ?? null,
  },
  {
    // Last, and immediately after MCP on purpose: the two answer the same
    // question from opposite ends ("I want an AI to see my database"), and the
    // AI guide's own closing section sends anyone with an existing Claude or
    // Codex licence back to the connector. A reader who arrives at one should
    // find the other next to it.
    id: "ai",
    group: "integrations",
    titleKey: "docs.entries.ai.title",
    descriptionKey: "docs.entries.ai.description",
    path: "docs/AI.md",
    bodies: { en: aiRaw, es: aiEsRaw },
    updated: dates["docs/AI.md"] ?? null,
  },
  {
    // After the AI guide: it is what an organization uses to bound everything
    // the two entries above let an AI do, and it is written for the
    // administrator rather than for the person using the panel.
    id: "policy",
    group: "organization",
    titleKey: "docs.entries.policy.title",
    descriptionKey: "docs.entries.policy.description",
    path: "docs/POLICY.md",
    bodies: { en: policyRaw, es: policyEsRaw },
    updated: dates["docs/POLICY.md"] ?? null,
  },
];

/** Look up a doc entry by id. */
export function getDoc(id: string): DocEntry | undefined {
  return DOCS.find((d) => d.id === id);
}

/** Markdown body for the given UI language, falling back to English. */
export function getDocBody(doc: DocEntry, lang: string): string {
  return doc.bodies[lang as AppLanguage] ?? doc.bodies.en;
}

/**
 * Where a heading lives in a doc, in the given language — what
 * `useDocsDialog.openTo` needs to land on it.
 *
 * By heading **text** rather than slug because slugs are per language: the
 * same section is `connection-limits` in English and `límites-de-conexiones` in
 * Spanish. A link from the UI carries the heading through i18n and resolves
 * it here against the body the viewer will actually show. `null` when the
 * heading is not there (renamed), which the caller treats as "open the doc's
 * cover" rather than navigating somewhere arbitrary.
 */
export function docLocation(
  id: string,
  heading: string,
  lang: string,
): { section: string | null; anchor: string | null } | null {
  const doc = getDoc(id);
  if (!doc) return null;
  return locate(parseDoc(getDocBody(doc, lang)), slugify(heading));
}

/** The docs of one group, in reading order. */
export function docsInGroup(group: DocGroup): DocEntry[] {
  return DOCS.filter((d) => d.group === group);
}
