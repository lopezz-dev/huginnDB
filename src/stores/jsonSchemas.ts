/**
 * The user JSON Schema library, its bindings, and the per-relation resolution
 * cache.
 *
 * Global on-disk data rather than a preference, a session artifact or dialog
 * state, so it lives at the root of `stores/` next to `update.ts`.
 *
 * # This store never resolves anything itself
 *
 * The most-specific-wins cascade (four axes, globs, tie-breaks) exists only in
 * Rust — see `src-tauri/src/json_schemas/mod.rs`. Mirroring it here would be the
 * same one-grammar-two-implementations trap ADRs #30/#33 exist to prevent,
 * and the drift would be silent: a resolution bug is not an error, it is "the
 * autocompletion did not appear". What this store holds is a cache of
 * *results*, keyed per relation, filled by one call when a data tab opens.
 *
 * # Reference stability (gotcha #1)
 *
 * Everything here is raw state. Components subscribe to `schemas`, `bindings`,
 * `revision` or a single `resolved` bucket and derive with `useMemo`. There is
 * deliberately no selector that filters or maps — one would return a fresh array
 * on every call and cap React's update depth.
 *
 * `revision` is bumped on every mutation so a component can depend on "the
 * library changed" without diffing arrays or stringifying bodies.
 */

import { create } from "zustand";
import { api } from "@/lib/tauri";
import { parentConnectionId } from "@/lib/connectionLabel";
import {
  setSchemaLibrary,
  type PublishedSchema,
} from "@/lib/monaco/monacoJson";
import type {
  JsonSchemaBinding,
  JsonSchemaEntry,
  ResolvedJsonSchema,
} from "@/types";

/**
 * Cache key for one relation.
 *
 * The connection id is folded to its parent profile id first: a server-wide
 * connection browses each database under a synthetic `<parent>::db::<db>` id
 * (ADR #32), and the backend resolves against the parent, so keying on the
 * child would cache the same answer once per database and — worse — look like a
 * miss every time the user switched database.
 */
export function relationKey(
  connectionId?: string | null,
  dbSchema?: string | null,
  table?: string | null,
): string {
  const conn = connectionId ? parentConnectionId(connectionId) : "";
  return `${conn}|${dbSchema ?? ""}|${table ?? ""}`;
}

interface JsonSchemasState {
  schemas: JsonSchemaEntry[];
  bindings: JsonSchemaBinding[];
  /** Bumped on every mutation, so `useMemo` can depend on one primitive. */
  revision: number;
  loaded: boolean;
  /** Resolutions per relation key, then per column name. */
  resolved: Record<string, Record<string, ResolvedJsonSchema>>;
  /** `JSON.parse` failures per schema id, so Settings can flag a broken entry. */
  parseErrors: Record<string, string>;

  load: () => Promise<void>;
  /** Adopt a change made in another window (or by a profile import/delete). */
  reload: () => Promise<void>;
  /** Fetch and cache the resolutions for one relation, unless already cached. */
  ensureResolved: (
    connectionId?: string | null,
    dbSchema?: string | null,
    table?: string | null,
    columns?: string[],
  ) => Promise<void>;
  /** Resolve a single column that no batch call could have covered — a MongoDB
   *  nested field path, which is not known until the user expands it. */
  resolveColumn: (
    connectionId?: string | null,
    dbSchema?: string | null,
    table?: string | null,
    column?: string,
  ) => Promise<ResolvedJsonSchema | null>;

  saveSchema: (args: {
    id?: string;
    name: string;
    description?: string | null;
    body: string;
    source?: JsonSchemaEntry["source"];
  }) => Promise<JsonSchemaEntry>;
  deleteSchema: (id: string) => Promise<number>;
  saveBinding: (binding: JsonSchemaBinding) => Promise<JsonSchemaBinding>;
  deleteBinding: (id: string) => Promise<void>;
  reorderBindings: (ids: string[]) => Promise<void>;
}

/** A blank binding shaped for a column, ready for the badge to save. */
export function draftBinding(
  schemaId: string,
  connectionId?: string | null,
  dbSchema?: string | null,
  table?: string | null,
  column = "",
): JsonSchemaBinding {
  return {
    id: "",
    schemaId,
    // Always the profile id: a synthetic per-database id would never match.
    connectionId: connectionId ? parentConnectionId(connectionId) : null,
    dbSchema: dbSchema ?? null,
    table: table ?? null,
    column,
    enabled: true,
    order: 0,
    originId: null,
  };
}

/**
 * Publish the parsed library to Monaco, skipping entries whose body is not valid
 * JSON, and record why they were skipped.
 *
 * A half-parsed object must never reach Monaco: it would validate cells against
 * something the user never wrote. A broken entry simply stops applying, and the
 * Settings list flags it.
 */
function publish(schemas: JsonSchemaEntry[]) {
  const entries: PublishedSchema[] = [];
  const errors: Record<string, string> = {};
  for (const s of schemas) {
    try {
      entries.push({
        uri: schemaUri(s.id),
        body: s.body,
        schema: JSON.parse(s.body),
      });
    } catch (e) {
      errors[s.id] = e instanceof Error ? e.message : String(e);
    }
  }
  // Cheap when nothing actually changed: the Monaco side compares bodies, so a
  // rename does not restart the JSON worker.
  setSchemaLibrary(entries);
  return errors;
}

/** The in-memory URI a library entry is registered under, which is also what a
 *  `$ref` between two user schemas has to name. */
export function schemaUri(id: string): string {
  return `huginndb://schema/${id}`;
}

export const useJsonSchemas = create<JsonSchemasState>((set, get) => ({
  schemas: [],
  bindings: [],
  revision: 0,
  loaded: false,
  resolved: {},
  parseErrors: {},

  load: async () => {
    if (get().loaded) return;
    await get().reload();
  },

  reload: async () => {
    const lib = await api.listJsonSchemas();
    const parseErrors = publish(lib.schemas);
    set((s) => ({
      schemas: lib.schemas,
      bindings: lib.bindings,
      revision: s.revision + 1,
      loaded: true,
      parseErrors,
      // Any cached resolution may now name a different schema, or none. Safe to
      // drop wholesale: it is refilled by one call per data tab.
      resolved: {},
    }));
  },

  ensureResolved: async (connectionId, dbSchema, table, columns) => {
    if (!columns?.length) return;
    const key = relationKey(connectionId, dbSchema, table);
    if (get().resolved[key]) return;
    // Claim the key before awaiting so two grids mounting at once do not both
    // fire the same call.
    set((s) => ({ resolved: { ...s.resolved, [key]: {} } }));
    try {
      const hits = await api.resolveJsonSchemasForColumns({
        connectionId: connectionId ? parentConnectionId(connectionId) : null,
        dbSchema: dbSchema ?? null,
        table: table ?? null,
        columns,
      });
      const byColumn: Record<string, ResolvedJsonSchema> = {};
      for (const hit of hits) byColumn[hit.column] = hit;
      set((s) => ({ resolved: { ...s.resolved, [key]: byColumn } }));
    } catch {
      // A failure here costs autocompletion, never the grid. Drop the claim so
      // the next mount retries.
      set((s) => {
        const next = { ...s.resolved };
        delete next[key];
        return { resolved: next };
      });
    }
  },

  resolveColumn: async (connectionId, dbSchema, table, column) => {
    if (!column) return null;
    const key = relationKey(connectionId, dbSchema, table);
    const cached = get().resolved[key]?.[column];
    if (cached) return cached;
    try {
      const hit = await api.resolveJsonSchema({
        connectionId: connectionId ? parentConnectionId(connectionId) : null,
        dbSchema: dbSchema ?? null,
        table: table ?? null,
        column,
      });
      if (hit) {
        set((s) => ({
          resolved: {
            ...s.resolved,
            [key]: { ...(s.resolved[key] ?? {}), [column]: hit },
          },
        }));
      }
      return hit;
    } catch {
      return null;
    }
  },

  saveSchema: async (args) => {
    const saved = await api.saveJsonSchema(args);
    // Splice rather than refetch. Editing a schema cannot change *which* schema
    // wins for a column — only the bindings decide that — so the resolution cache
    // stays, and a name edit does not throw away every grid's warm lookup. The
    // body may have changed, so Monaco is republished; its own guard makes that a
    // no-op when the documents are identical.
    set((s) => {
      const schemas = s.schemas.some((x) => x.id === saved.id)
        ? s.schemas.map((x) => (x.id === saved.id ? saved : x))
        : [...s.schemas, saved];
      return {
        schemas,
        revision: s.revision + 1,
        parseErrors: publish(schemas),
      };
    });
    return saved;
  },

  // The rest change bindings (or remove a schema out from under them), so the
  // resolution cache genuinely has to go. A full reload is the honest way to do
  // that, and these are all one-off user actions rather than keystrokes.
  deleteSchema: async (id) => {
    const dropped = await api.deleteJsonSchema(id);
    await get().reload();
    return dropped;
  },

  saveBinding: async (binding) => {
    const saved = await api.saveJsonSchemaBinding(binding);
    await get().reload();
    return saved;
  },

  deleteBinding: async (id) => {
    await api.deleteJsonSchemaBinding(id);
    await get().reload();
  },

  reorderBindings: async (ids) => {
    await api.reorderJsonSchemaBindings(ids);
    await get().reload();
  },
}));
