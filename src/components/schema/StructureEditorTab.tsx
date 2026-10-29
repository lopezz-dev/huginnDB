/**
 * Visual table-structure editor (HeidiSQL-style). Edits columns, indexes and
 * foreign keys of an existing table, or designs a new one. The component never
 * builds SQL itself: it sends the desired `TableStructure` (plus the original
 * snapshot when editing) to the backend, which generates the DDL. A read-only
 * Monaco pane previews that DDL live; Apply executes it.
 *
 * State model: the working structure lives in local React state (ephemeral per
 * tab — dockview keeps the panel mounted). The loaded `original` is kept
 * separately so the backend can diff. Each column carries a stable `originalName`
 * so a rename is distinguishable from a drop+add (the Rust diff matches on it).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  ChevronUp,
  KeyRound,
  Lock,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { notify } from "@/lib/notify";
import { usePolicyLock } from "@/lib/policy/access";
import { useDebouncedPreview } from "@/lib/useDebouncedPreview";
import { IconButton } from "@/components/ui/icon-button";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn, formatBytes, formatCount } from "@/lib/utils";
import { api } from "@/lib/tauri";
import { SchemaBindingBadge } from "@/components/jsonSchema/SchemaBindingBadge";
import { useJsonSchemas } from "@/stores/jsonSchemas";
import { useSchema } from "@/stores/session/schema";
import { useTabs, retitleTabsForTableRename } from "@/stores/session/tabs";
import { useConnections } from "@/stores/session/connections";
import { useConnectionDriver } from "@/lib/connection/useConnectionDriver";
import {
  usePreferences,
  selectEditorPrefs,
} from "@/stores/preferences/preferences";
import { useReloadable } from "@/lib/useReloadable";
import { DdlPreviewPane } from "@/components/schema/DdlPreviewPane";
import { TableCreateDdlView } from "@/components/schema/TableCreateDdlView";
import { joinStatements } from "@/lib/sql/formatStatements";
import {
  columnCategoriesFor,
  composeColumnType,
  parseColumnType,
  type ColumnTypeCategory,
} from "@/lib/db/columnTypes";
import {
  supportsColumnReorder,
  supportsStructureEditing,
  supportsIndexManager,
  supportsNativeCreateDdl,
  supportsUnsignedIntegers,
} from "@/lib/db/driver";
import type {
  ColumnDef,
  Driver,
  StructureIndexDef,
  ForeignKeyDef,
  StructureMode,
  TableStructure,
} from "@/types";

interface Props {
  tabId: string;
  connectionId: string;
  schema?: string;
  table?: string;
  mode: StructureMode;
}

let keySeq = 0;
const nextKey = () => `c${keySeq++}`;

/** Working column = ColumnDef + a stable client key for React lists. */
type WorkingColumn = ColumnDef & { _key: string };

/** A sensible starting type for a freshly-added column: the catalog's own
 *  "varchar"-ish text entry, composed with its default length, so a new
 *  column always lands in the categorised picker instead of the "custom
 *  type" fallback (which a hardcoded literal like "varchar(255)" would hit
 *  on SQLite, where the catalog's text type is spelled "TEXT"). */
function defaultColumnType(categories: ColumnTypeCategory[]): string {
  const textTypes = categories.find((c) => c.key === "text")?.types ?? [];
  const candidate =
    textTypes.find((t) => /^varchar$/i.test(t.name)) ?? textTypes[0];
  if (!candidate) return "varchar(255)";
  return composeColumnType({
    baseType: candidate.name,
    length: candidate.defaultLength ?? "",
    unsigned: false,
    zerofill: false,
    custom: "",
  });
}

function blankColumn(dataType: string): WorkingColumn {
  return {
    _key: nextKey(),
    name: "",
    originalName: null,
    dataType,
    nullable: true,
    default: null,
    isPrimaryKey: false,
    autoIncrement: false,
  };
}

export function StructureEditorTab({
  tabId,
  connectionId,
  schema,
  table,
  mode,
}: Props) {
  const { t } = useTranslation();
  const editorPrefs = usePreferences(selectEditorPrefs);
  const refreshSchema = useSchema((s) => s.refresh);
  const closeTab = useTabs((s) => s.close);
  // Drives the type suggestions. Synthetic multi-DB ids inherit the parent
  // profile's driver — the hook handles that fold.
  const driver = useConnectionDriver(connectionId);
  const typeCategories = useMemo(() => columnCategoriesFor(driver), [driver]);

  // Read-only on MongoDB, which has no SQL DDL at all — the tab shows inferred
  // fields and real indexes, and the backend rejects preview/apply — so the
  // Apply action is replaced by a badge instead of failing on click.
  const isReadOnly = !supportsStructureEditing(driver);
  // Whether the managed policy lets the person change this table's structure
  // (or, for a new one, create tables here). The tab opens either way: reading
  // a structure is `select`, and only Apply needs `ddl`.
  const ddlLock = usePolicyLock(
    connectionId,
    "ddl",
    mode === "edit" && table ? { schema, name: table } : null,
  );

  /**
   * `4.3 MB · 12.1k rows` beside the table name, in edit mode.
   *
   * Costs nothing: the numbers are already on the `TableInfo` the schema tree
   * fetched, so this reads the store rather than adding a call. Both halves
   * are best-effort per driver (SQLite reports no row count, a view reports no
   * size), so each is rendered only when present and the chip disappears when
   * neither is — an empty pill would say less than nothing.
   *
   * `!= null` rather than truthiness: a genuine `row_count` of 0 is a fact
   * worth showing, and this is the guard `tableMetricLabel` documents.
   */
  const tableStats = useSchema((s) =>
    mode === "edit" && table
      ? s.byConnection[connectionId]?.tables.find(
          (t) => t.name === table && (schema === undefined || t.schema === schema),
        )
      : undefined,
  );
  const statsChip = useMemo(() => {
    if (!tableStats) return null;
    const parts: string[] = [];
    if (tableStats.size_bytes != null) parts.push(formatBytes(tableStats.size_bytes));
    if (tableStats.row_count != null) {
      parts.push(t("structure.rowCount", { count: formatCount(tableStats.row_count) }));
    }
    return parts.length > 0 ? parts.join(" · ") : null;
  }, [tableStats, t]);

  const [original, setOriginal] = useState<TableStructure | null>(null);
  const [name, setName] = useState(table ?? "");
  const [columns, setColumns] = useState<WorkingColumn[]>(
    mode === "new" ? [blankColumn(defaultColumnType(typeCategories))] : [],
  );
  const [indexes, setIndexes] = useState<StructureIndexDef[]>([]);
  const [foreignKeys, setForeignKeys] = useState<ForeignKeyDef[]>([]);
  const [section, setSection] = useState<
    "columns" | "indexes" | "fks" | "ddl"
  >("columns");
  // The server's own CREATE statement, next to the sections that edit it.
  // Edit mode only — a table being created has no server text yet.
  const showCreateDdl = mode === "edit" && supportsNativeCreateDdl(driver);

  const [ddl, setDdl] = useState<string>("");
  const [rebuild, setRebuild] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [confirmRebuild, setConfirmRebuild] = useState(false);

  // The table's current name, tracked outside React state: the `table` prop
  // is whatever the tab was opened/panel-created with and never updates on
  // its own (dockview panel params are fixed at creation), so a rename via
  // Apply would otherwise leave `reload` re-fetching a name that no longer
  // exists. A ref (not state) so updating it never re-triggers the mount
  // effect below.
  const currentTableNameRef = useRef(table);

  // (Re)load the existing structure from the server. Runs on mount and from
  // the manual refresh button (issue #25) so external changes made while the
  // tab is open can be pulled in; a refresh resets the working state to the
  // server's current definition.
  const load = useCallback(async () => {
    const currentName = currentTableNameRef.current;
    if (!currentName) return;
    const s = await api.getTableStructure(connectionId, schema, currentName);
    currentTableNameRef.current = s.name;
    setOriginal(s);
    setName(s.name);
    setColumns(s.columns.map((c) => ({ ...c, _key: nextKey() })));
    setIndexes(s.indexes);
    setForeignKeys(s.foreignKeys);
  }, [connectionId, schema]);
  const {
    loading,
    error: loadError,
    reload,
  } = useReloadable(mode === "edit" ? load : null);

  // JSON Schema bindings for this table.
  //
  // Deliberately in their own state, NOT on `WorkingColumn`: a binding is local
  // editor metadata, not DDL. `desired` below is built with
  // `columns.map(({ _key, ...c }) => c)`, so a field added to `WorkingColumn`
  // would ride into the `preview_structure_change` payload unless someone
  // remembered to strip it — and would re-trigger the debounced DDL preview on
  // every pick. Keeping it in a separate map makes that impossible by
  // construction (ADR #16).
  // Only the warm-up call lives here; each badge reads the cache itself.
  const ensureResolvedSchemas = useJsonSchemas((s) => s.ensureResolved);
  const schemaRevision = useJsonSchemas((s) => s.revision);
  const columnNames = useMemo(
    () => columns.map((c) => c.name).filter(Boolean),
    [columns],
  );
  useEffect(() => {
    if (mode !== "edit" || columnNames.length === 0) return;
    void ensureResolvedSchemas(connectionId, schema, name, columnNames);
  }, [
    mode,
    connectionId,
    schema,
    name,
    columnNames,
    ensureResolvedSchemas,
    schemaRevision,
  ]);

  /** Assemble the desired structure from the working state. */
  const desired = useMemo<TableStructure>(
    () => ({
      schema: schema ?? null,
      name: name.trim(),
      columns: columns.map(({ _key, ...c }) => c),
      indexes,
      foreignKeys,
    }),
    [schema, name, columns, indexes, foreignKeys],
  );

  // Debounced DDL preview. Re-runs whenever the desired structure changes.
  const desiredRef = useRef(desired);
  desiredRef.current = desired;
  const runPreview = useCallback(() => {
    // MongoDB has no DDL preview; structure is read-only here.
    if (isReadOnly) {
      setDdl("");
      setPreviewError(null);
      return;
    }
    if (!desiredRef.current.name || desiredRef.current.columns.length === 0) {
      setDdl("");
      setPreviewError(null);
      return;
    }
    api
      .previewStructureChange({
        connectionId,
        original,
        desired: desiredRef.current,
      })
      .then((p) => {
        setDdl(joinStatements(p.statements));
        setRebuild(p.rebuild);
        setPreviewError(null);
      })
      .catch((e) => {
        setDdl("");
        setPreviewError(String(e));
      });
  }, [connectionId, original, isReadOnly]);

  useDebouncedPreview(desired, runPreview);

  async function doApply() {
    setApplying(true);
    setPreviewError(null);
    // Captured before `applyStructureChange` — `original` (React state)
    // still reflects the pre-apply snapshot at this point in the closure.
    const priorName = original?.name;
    try {
      await api.applyStructureChange({ connectionId, original, desired });
      // Follow column renames so a binding does not silently stop matching.
      // Best-effort on purpose: the DDL has already run, so a failure here is a
      // toast, never a rollback.
      for (const c of columns) {
        if (c.originalName && c.originalName !== c.name) {
          try {
            await api.renameJsonSchemaBindingColumn({
              connectionId,
              dbSchema: schema ?? null,
              table: desired.name,
              from: c.originalName,
              to: c.name,
            });
          } catch (e) {
            notify.error(
              t("structure.jsonSchemaRenameFailed", { message: String(e) }),
            );
          }
        }
      }
      // Refresh the explorer so the new/edited table shows immediately.
      await refreshSchema(connectionId);
      // The apply is a batch of DDL against a remote server, and "it came back
      // without complaining" is not something the editor can show: it reloads
      // to the applied state, which looks the same as never having been
      // touched. `mode === "new"` closes the tab outright, so there is even
      // less to read it off.
      notify.success(
        t(mode === "new" ? "structure.created" : "structure.applied", {
          name: desired.name,
        }),
      );
      if (mode === "new") {
        closeTab(tabId);
      } else {
        // Reload the structure so the editor reflects the applied state and
        // future diffs start from the new baseline.
        const s = await api.getTableStructure(
          connectionId,
          schema,
          desired.name,
        );
        currentTableNameRef.current = s.name;
        setOriginal(s);
        setColumns(s.columns.map((c) => ({ ...c, _key: nextKey() })));
        setIndexes(s.indexes);
        setForeignKeys(s.foreignKeys);
        // The table was renamed — update this tab's title (and every open
        // table-data tab for the same table) so nothing keeps showing or
        // re-fetching the old name.
        if (priorName && priorName !== s.name) {
          retitleTabsForTableRename(
            useConnections.getState().profiles,
            connectionId,
            schema,
            priorName,
            s.name,
            t("tabs.structureSuffix"),
          );
        }
      }
    } catch (e) {
      // Surface the failure both in the DDL pane and as a toast. The pane
      // alone was easy to miss (small, bottom of the tab), so a rejected DDL
      // apply — e.g. MySQL "key too long" on an oversized PK — looked like it
      // silently did nothing (issue #26).
      const message = String(e);
      setPreviewError(message);
      notify.error(t("structure.applyFailed", { message }));
    } finally {
      setApplying(false);
      setConfirmRebuild(false);
    }
  }

  function onApplyClick() {
    if (rebuild) setConfirmRebuild(true);
    else void doApply();
  }

  // ----- column row mutation helpers -----
  function patchColumn(key: string, patch: Partial<WorkingColumn>) {
    setColumns((cs) =>
      cs.map((c) => (c._key === key ? { ...c, ...patch } : c)),
    );
  }
  function addColumn() {
    setColumns((cs) => [...cs, blankColumn(defaultColumnType(typeCategories))]);
  }
  function removeColumn(key: string) {
    setColumns((cs) => cs.filter((c) => c._key !== key));
  }
  function moveColumn(key: string, direction: -1 | 1) {
    setColumns((cs) => {
      const i = cs.findIndex((c) => c._key === key);
      const j = i + direction;
      if (i < 0 || j < 0 || j >= cs.length) return cs;
      const next = [...cs];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  if (loading) {
    return (
      <div className="p-4 text-xs text-muted-foreground">
        {t("structure.loading")}
      </div>
    );
  }
  if (loadError) {
    return <div className="p-4 text-xs text-destructive">{loadError}</div>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-xs text-muted-foreground">
          {t("structure.tableName")}
        </span>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("structure.tableNamePlaceholder")}
          className="h-7 w-64 text-xs"
          disabled={isReadOnly}
        />
        <div className="ml-auto flex items-center gap-2">
          {statsChip && (
            <span className="rounded-sm bg-muted px-2 py-1 text-2xs tabular-nums text-muted-foreground">
              {statsChip}
            </span>
          )}
          {mode === "edit" && (
            <IconButton
              icon={RefreshCw}
              onClick={() => void reload()}
              loading={loading}
              disabled={applying}
              label={t("structure.refresh")}
            />
          )}
          {isReadOnly ? (
            <span className="rounded-sm bg-muted px-2 py-1 text-2xs text-muted-foreground">
              {t("structure.readOnlyMongo")}
            </span>
          ) : ddlLock ? (
            <span className="flex items-center gap-1 rounded-sm bg-muted px-2 py-1 text-2xs text-muted-foreground">
              <Lock aria-hidden className="h-3 w-3 shrink-0" />
              {ddlLock}
            </span>
          ) : (
            <Button
              size="sm"
              onClick={onApplyClick}
              disabled={applying || !name.trim() || columns.length === 0}
            >
              {applying ? t("structure.applying") : t("structure.apply")}
            </Button>
          )}
        </div>
      </div>

      {/* Section tabs */}
      <div className="border-b border-border px-3 py-1.5">
        <Segmented
          value={section}
          onValueChange={setSection}
          aria-label={t("structure.sectionsLabel")}
          options={(showCreateDdl
            ? (["columns", "indexes", "fks", "ddl"] as const)
            : (["columns", "indexes", "fks"] as const)
          ).map((s) => ({
            value: s,
            label: t(`structure.section.${s}`),
          }))}
        />
      </div>

      {/* Body: editor grids on top, DDL preview at the bottom — or, in the
          CREATE section, the server's statement on its own (the preview is a
          diff and would read as a second, contradicting definition). */}
      {section === "ddl" && showCreateDdl && original ? (
        <TableCreateDdlView
          connectionId={connectionId}
          schema={schema}
          table={original.name}
          // `original` is replaced on every reload and every successful
          // Apply, which are exactly the moments the server text can change.
          revision={original}
          prefs={editorPrefs}
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-auto p-2">
            {section === "columns" && (
              <ColumnsEditor
                columns={columns}
                driver={driver}
                typeCategories={typeCategories}
                // Reordering a not-yet-created table is just column array
                // order feeding one CREATE TABLE statement — every dialect
                // supports that for free. Editing a *live* table needs an
                // actual ALTER to reposition a column, which only MySQL's
                // MODIFY/ADD COLUMN … FIRST|AFTER can express.
                canReorder={mode === "new" || supportsColumnReorder(driver)}
                onPatch={patchColumn}
                onRemove={removeColumn}
                onMove={moveColumn}
                onAdd={addColumn}
                bindingContext={
                  mode === "edit"
                    ? { connectionId, dbSchema: schema, table: name }
                    : undefined
                }
              />
            )}
            {section === "indexes" && (
              <>
                {/* MongoDB indexes are editable — just not here. This editor
                    diffs a `TableStructure` into DDL, and its `IndexDef` (name +
                    column names + unique) can't carry a per-key direction, a
                    TTL or a partial filter. The index manager is that surface;
                    pointing at it beats leaving the section looking inert. */}
                {supportsIndexManager(driver) && table && (
                  <div className="mb-3 flex items-center justify-between gap-3 rounded-sm border border-border/50 bg-muted/30 px-3 py-2 text-xs">
                    <span className="text-muted-foreground">
                      {t("structure.indexManagerHint")}
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        useTabs.getState().open({
                          kind: "indexes",
                          title: `${table} (${t("tabs.indexesSuffix")})`,
                          connectionId,
                          schema,
                          table,
                        })
                      }
                    >
                      <KeyRound className="mr-1 h-3.5 w-3.5" />
                      {t("structure.openIndexManager")}
                    </Button>
                  </div>
                )}
                <IndexesEditor
                  indexes={indexes}
                  columns={columns}
                  onChange={setIndexes}
                />
              </>
            )}
            {section === "fks" && (
              <ForeignKeysEditor
                fks={foreignKeys}
                columns={columns}
                onChange={setForeignKeys}
              />
            )}
          </div>

          <DdlPreviewPane
            title={t("structure.ddlPreview")}
            ddl={ddl}
            error={previewError}
            warning={rebuild ? t("structure.rebuildWarning") : null}
            prefs={editorPrefs}
          />
        </div>
      )}

      {/* SQLite rebuild confirmation */}
      <Dialog open={confirmRebuild} onOpenChange={setConfirmRebuild}>
        <DialogContent tier="prompt">
          <DialogHeader>
            <DialogTitle className="text-sm">
              {t("structure.rebuildTitle")}
            </DialogTitle>
          </DialogHeader>
          <DialogBody>
            <p className="text-xs text-muted-foreground">
              {t("structure.rebuildBody")}
            </p>
          </DialogBody>
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirmRebuild(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={doApply}
              disabled={applying}
            >
              {t("structure.rebuildConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Columns editor
// ---------------------------------------------------------------------------

/**
 * Shared cell chrome: a compact input that reads flat in the table until it is
 * focused. It no longer overrides the focus treatment — it used to swap the
 * primitive's brand focus for a grey `border-input` + hairline ring, which was
 * the only field in the app that did, and left no clear signal of which cell
 * you were editing. `Input` supplies the field focus language now.
 */
const cellInputClass =
  "h-7 border-transparent bg-transparent px-1.5 text-xs shadow-none";

function ColumnsEditor({
  columns,
  driver,
  typeCategories,
  canReorder,
  onPatch,
  onRemove,
  onMove,
  onAdd,
  bindingContext,
}: {
  columns: WorkingColumn[];
  driver: Driver | undefined;
  typeCategories: ColumnTypeCategory[];
  canReorder: boolean;
  onPatch: (key: string, patch: Partial<WorkingColumn>) => void;
  onRemove: (key: string) => void;
  onMove: (key: string, direction: -1 | 1) => void;
  onAdd: () => void;
  /**
   * Coordinates for the per-column JSON Schema affordance, or `undefined` while
   * designing a table that does not exist yet — there is nothing to anchor a
   * binding to, and writing one for a table the apply might not create would
   * leave litter behind.
   *
   * Rendered as an icon in the trailing actions cell rather than as a new column:
   * this table already carries 8–11 of them, and a twelfth would crush it.
   */
  bindingContext?: {
    connectionId: string;
    dbSchema?: string;
    table: string;
  };
}) {
  const { t } = useTranslation();
  // MySQL is the only driver where UNSIGNED/ZEROFILL are meaningful — the
  // columns are omitted entirely for the others instead of rendering
  // permanently-disabled checkboxes.
  const showUnsignedCols = supportsUnsignedIntegers(driver);

  return (
    <div className="space-y-2">
      <div className="overflow-hidden rounded-md border border-border">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="bg-muted/40 text-left text-2xs uppercase tracking-wide text-muted-foreground">
              <th className="w-9 border-b border-border px-1.5 py-1.5 font-medium">
                #
              </th>
              <th className="border-b border-border px-1.5 py-1.5 font-medium">
                {t("structure.col.name")}
              </th>
              <th className="w-36 border-b border-border px-1.5 py-1.5 font-medium">
                {t("structure.col.type")}
              </th>
              <th className="w-28 border-b border-border px-1.5 py-1.5 font-medium">
                {t("structure.col.length")}
              </th>
              {showUnsignedCols && (
                <>
                  <th className="w-14 border-b border-border px-1 py-1.5 text-center font-medium">
                    {t("structure.col.unsigned")}
                  </th>
                  <th className="w-14 border-b border-border px-1 py-1.5 text-center font-medium">
                    {t("structure.col.zerofill")}
                  </th>
                </>
              )}
              <th className="w-14 border-b border-border px-1 py-1.5 text-center font-medium">
                {t("structure.col.nullable")}
              </th>
              <th className="w-12 border-b border-border px-1 py-1.5 text-center font-medium">
                {t("structure.col.pk")}
              </th>
              <th className="w-14 border-b border-border px-1 py-1.5 text-center font-medium">
                {t("structure.col.auto")}
              </th>
              <th className="w-32 border-b border-border px-1.5 py-1.5 font-medium">
                {t("structure.col.default")}
              </th>
              {bindingContext && (
                <th
                  className="w-10 border-b border-l-2 border-dashed border-border px-1 py-1.5 text-center font-medium"
                  title={t("structure.col.jsonSchemaHint")}
                >
                  {"{}"}
                </th>
              )}
              <th
                className={cn(
                  "border-b border-border",
                  canReorder ? "w-16" : "w-8",
                )}
              />
            </tr>
          </thead>
          <tbody>
            {columns.map((c, i) => (
              <tr
                key={c._key}
                className={cn(
                  "group/col border-b border-border/50 last:border-b-0 hover:bg-accent",
                  i % 2 === 1 && "bg-muted/15",
                )}
              >
                <td className="px-1.5 py-0.5 tabular-nums text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    {c.isPrimaryKey && (
                      <KeyRound
                        className="h-3 w-3 shrink-0 text-warning"
                        aria-label={t("structure.col.pk")}
                      />
                    )}
                    {i + 1}
                  </span>
                </td>
                <td className="px-0.5 py-0.5">
                  <Input
                    value={c.name}
                    onChange={(e) => onPatch(c._key, { name: e.target.value })}
                    placeholder={t("structure.col.namePlaceholder")}
                    className={cellInputClass}
                  />
                </td>
                <TypeCell
                  column={c}
                  categories={typeCategories}
                  onPatch={onPatch}
                />
                {showUnsignedCols && (
                  <>
                    <td className="px-1 py-0.5 text-center">
                      <UnsignedZerofillCheckbox
                        column={c}
                        categories={typeCategories}
                        field="unsigned"
                        onPatch={onPatch}
                      />
                    </td>
                    <td className="px-1 py-0.5 text-center">
                      <UnsignedZerofillCheckbox
                        column={c}
                        categories={typeCategories}
                        field="zerofill"
                        onPatch={onPatch}
                      />
                    </td>
                  </>
                )}
                <td className="px-1 py-0.5 text-center">
                  <Checkbox
                    checked={c.nullable}
                    onChange={(e) =>
                      onPatch(c._key, { nullable: e.target.checked })
                    }
                  />
                </td>
                <td className="px-1 py-0.5 text-center">
                  <Checkbox
                    checked={c.isPrimaryKey}
                    onChange={(e) =>
                      onPatch(c._key, { isPrimaryKey: e.target.checked })
                    }
                  />
                </td>
                <td className="px-1 py-0.5 text-center">
                  <Checkbox
                    checked={!!c.autoIncrement}
                    onChange={(e) =>
                      onPatch(c._key, { autoIncrement: e.target.checked })
                    }
                  />
                </td>
                <td className="px-0.5 py-0.5">
                  <Input
                    value={c.default ?? ""}
                    onChange={(e) =>
                      onPatch(c._key, { default: e.target.value || null })
                    }
                    placeholder="—"
                    className={cn(cellInputClass, "font-mono")}
                  />
                </td>
                {bindingContext && (
                  <td className="border-l-2 border-dashed border-border px-1 py-0.5 text-center">
                    {c.name ? (
                      // Saves the instant it is picked, out of band: it is local
                      // metadata and must never enter the DDL diff below.
                      <SchemaBindingBadge
                        variant="compact"
                        language="json"
                        value=""
                        binding={{
                          connectionId: bindingContext.connectionId,
                          dbSchema: bindingContext.dbSchema,
                          table: bindingContext.table,
                          column: c.name,
                        }}
                      />
                    ) : (
                      <span
                        className="text-muted-foreground/30"
                        title={t("structure.col.jsonSchemaNewHint")}
                      >
                        —
                      </span>
                    )}
                  </td>
                )}
                <td className="px-1 py-0.5 text-center">
                  <div className="flex items-center justify-center gap-0.5 opacity-0 group-hover/col:opacity-100">
                    {canReorder && (
                      <>
                        <IconButton
                          icon={ChevronUp}
                          label={t("structure.col.moveUp")}
                          onClick={() => onMove(c._key, -1)}
                          disabled={i === 0}
                        />
                        <IconButton
                          icon={ChevronDown}
                          label={t("structure.col.moveDown")}
                          onClick={() => onMove(c._key, 1)}
                          disabled={i === columns.length - 1}
                        />
                      </>
                    )}
                    <IconButton
                      icon={Trash2}
                      tone="destructive"
                      label={t("structure.col.remove")}
                      onClick={() => onRemove(c._key)}
                    />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Button size="sm" variant="outline" onClick={onAdd} icon={Plus}>
        {t("structure.col.add")}
      </Button>
    </div>
  );
}

/**
 * Type + length/set cell. Splits `column.dataType` into a categorised base
 * type (a native `<NativeSelect>` grouped by `<optgroup>` — HeidiSQL-style, and
 * keyboard-navigable for free) and a separate length/precision field, so
 * picking "VARCHAR" then typing "255" reads the same way the catalog
 * presents it. A `dataType` that doesn't match any catalog entry (a custom
 * or exotic type carried over from an existing table) falls back to a
 * single raw text field instead of forcing it into the picker.
 */
function TypeCell({
  column,
  categories,
  onPatch,
}: {
  column: WorkingColumn;
  categories: ColumnTypeCategory[];
  onPatch: (key: string, patch: Partial<WorkingColumn>) => void;
}) {
  const { t } = useTranslation();
  const parsed = useMemo(
    () => parseColumnType(column.dataType, categories),
    [column.dataType, categories],
  );
  const selected = categories
    .flatMap((cat) => cat.types)
    .find((ty) => ty.name === parsed.baseType);

  function applyBaseType(name: string) {
    if (name === CUSTOM_TYPE_VALUE) {
      onPatch(column._key, { dataType: parsed.custom || column.dataType });
      return;
    }
    const next = categories
      .flatMap((cat) => cat.types)
      .find((ty) => ty.name === name);
    onPatch(column._key, {
      dataType: composeColumnType({
        ...parsed,
        baseType: name,
        length: next?.defaultLength ?? "",
        unsigned: false,
        zerofill: false,
      }),
    });
  }

  if (!parsed.baseType) {
    // Custom/unrecognised type: one raw field, plus the picker so the user
    // can jump back into the catalog at any time.
    return (
      <>
        <td className="px-0.5 py-0.5">
          <NativeSelect
            value={CUSTOM_TYPE_VALUE}
            onChange={(e) => applyBaseType(e.target.value)}
            size="xs"
            mono
            className="w-full"
          >
            <TypeOptions categories={categories} />
          </NativeSelect>
        </td>
        <td className="px-0.5 py-0.5">
          <Input
            value={column.dataType}
            onChange={(e) => onPatch(column._key, { dataType: e.target.value })}
            placeholder={t("structure.col.customTypePlaceholder")}
            className={cn(cellInputClass, "font-mono")}
          />
        </td>
      </>
    );
  }

  return (
    <>
      <td className="px-0.5 py-0.5">
        <NativeSelect
          value={parsed.baseType}
          onChange={(e) => applyBaseType(e.target.value)}
          size="xs"
          mono
          className="w-full"
        >
          <TypeOptions categories={categories} />
        </NativeSelect>
      </td>
      <td className="px-0.5 py-0.5">
        <Input
          value={parsed.length}
          disabled={!selected?.hasLength}
          onChange={(e) =>
            onPatch(column._key, {
              dataType: composeColumnType({
                ...parsed,
                length: e.target.value,
              }),
            })
          }
          placeholder={
            selected?.hasLength ? (selected.defaultLength ?? "") : "—"
          }
          className={cn(cellInputClass, "font-mono disabled:opacity-30")}
        />
      </td>
    </>
  );
}

const CUSTOM_TYPE_VALUE = "__custom__";

function TypeOptions({ categories }: { categories: ColumnTypeCategory[] }) {
  const { t } = useTranslation();
  return (
    <>
      {categories.map((cat) => (
        <optgroup key={cat.key} label={t(`structure.typeCategory.${cat.key}`)}>
          {cat.types.map((ty) => (
            <option key={ty.name} value={ty.name}>
              {ty.name}
            </option>
          ))}
        </optgroup>
      ))}
      <option value={CUSTOM_TYPE_VALUE}>{t("structure.col.customType")}</option>
    </>
  );
}

/** UNSIGNED/ZEROFILL checkbox, disabled when the selected base type doesn't
 *  carry a numeric width (e.g. TEXT, DATE) — MySQL rejects those combinations
 *  server-side, so the editor never offers them in the first place. */
function UnsignedZerofillCheckbox({
  column,
  categories,
  field,
  onPatch,
}: {
  column: WorkingColumn;
  categories: ColumnTypeCategory[];
  field: "unsigned" | "zerofill";
  onPatch: (key: string, patch: Partial<WorkingColumn>) => void;
}) {
  const parsed = useMemo(
    () => parseColumnType(column.dataType, categories),
    [column.dataType, categories],
  );
  const selected = categories
    .flatMap((cat) => cat.types)
    .find((ty) => ty.name === parsed.baseType);
  const capable = !!selected?.unsignedCapable;
  return (
    <Checkbox
      disabled={!capable}
      checked={capable && parsed[field]}
      onChange={(e) =>
        onPatch(column._key, {
          dataType: composeColumnType({ ...parsed, [field]: e.target.checked }),
        })
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Indexes editor
// ---------------------------------------------------------------------------

function IndexesEditor({
  indexes,
  columns,
  onChange,
}: {
  indexes: StructureIndexDef[];
  columns: WorkingColumn[];
  onChange: (next: StructureIndexDef[]) => void;
}) {
  const { t } = useTranslation();
  const colNames = columns.map((c) => c.name).filter(Boolean);
  function patch(i: number, p: Partial<StructureIndexDef>) {
    onChange(indexes.map((x, idx) => (idx === i ? { ...x, ...p } : x)));
  }
  return (
    <div className="space-y-2">
      {indexes.map((idx, i) => (
        <div
          key={i}
          className="flex items-center gap-2 rounded-sm border border-border/50 p-2 text-xs"
        >
          <Input
            value={idx.name ?? ""}
            onChange={(e) => patch(i, { name: e.target.value || null })}
            placeholder={t("structure.idx.namePlaceholder")}
            className="h-6 w-40 text-xs"
          />
          <Input
            value={idx.columns.join(", ")}
            onChange={(e) =>
              patch(i, {
                columns: e.target.value
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
            placeholder={colNames.join(", ")}
            className="h-6 flex-1 font-mono text-xs"
          />
          <label className="flex items-center gap-1">
            <Checkbox
              checked={idx.unique}
              onChange={(e) => patch(i, { unique: e.target.checked })}
            />
            {t("structure.idx.unique")}
          </label>
          <IconButton
            size="xs"
            icon={Trash2}
            tone="destructive"
            label={t("common.delete")}
            onClick={() => onChange(indexes.filter((_, idx2) => idx2 !== i))}
          />
        </div>
      ))}
      <Button
        size="sm"
        variant="outline"
        onClick={() =>
          onChange([...indexes, { name: null, columns: [], unique: false }])
        }
      >
        <Plus className="mr-1 h-3.5 w-3.5" />
        {t("structure.idx.add")}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Foreign keys editor
// ---------------------------------------------------------------------------

function ForeignKeysEditor({
  fks,
  columns,
  onChange,
}: {
  fks: ForeignKeyDef[];
  columns: WorkingColumn[];
  onChange: (next: ForeignKeyDef[]) => void;
}) {
  const { t } = useTranslation();
  const colNames = columns.map((c) => c.name).filter(Boolean);
  function patch(i: number, p: Partial<ForeignKeyDef>) {
    onChange(fks.map((x, idx) => (idx === i ? { ...x, ...p } : x)));
  }
  const csv = (s: string) =>
    s
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  return (
    <div className="space-y-2">
      {fks.map((fk, i) => (
        <div
          key={i}
          className="space-y-1 rounded-sm border border-border/50 p-2 text-xs"
        >
          <div className="flex items-center gap-2">
            <Input
              value={fk.name ?? ""}
              onChange={(e) => patch(i, { name: e.target.value || null })}
              placeholder={t("structure.fk.namePlaceholder")}
              className="h-6 w-40 text-xs"
            />
            <IconButton
              size="xs"
              icon={Trash2}
              tone="destructive"
              label={t("common.delete")}
              className="ml-auto"
              onClick={() => onChange(fks.filter((_, idx) => idx !== i))}
            />
          </div>
          <div className="flex items-center gap-2">
            <Input
              value={fk.columns.join(", ")}
              onChange={(e) => patch(i, { columns: csv(e.target.value) })}
              placeholder={colNames.join(", ")}
              className="h-6 flex-1 font-mono text-xs"
            />
            <span className="text-muted-foreground">→</span>
            <Input
              value={fk.refTable}
              onChange={(e) => patch(i, { refTable: e.target.value })}
              placeholder={t("structure.fk.refTable")}
              className="h-6 w-40 font-mono text-xs"
            />
            <Input
              value={fk.refColumns.join(", ")}
              onChange={(e) => patch(i, { refColumns: csv(e.target.value) })}
              placeholder={t("structure.fk.refColumns")}
              className="h-6 w-40 font-mono text-xs"
            />
          </div>
        </div>
      ))}
      <Button
        size="sm"
        variant="outline"
        onClick={() =>
          onChange([
            ...fks,
            {
              name: null,
              columns: [],
              refTable: "",
              refColumns: [],
              refSchema: null,
              onDelete: null,
              onUpdate: null,
            },
          ])
        }
      >
        <Plus className="mr-1 h-3.5 w-3.5" />
        {t("structure.fk.add")}
      </Button>
    </div>
  );
}
