/**
 * The table browse's **query panel**: an inline section under the grid
 * toolbar, opened from its "Query" button, that edits what the browse asks the
 * server for.
 *
 * It replaced `AdvancedFilterDialog` and holds three rows:
 *
 * - **Filter** — the flat AND list of column → operator → value conditions the
 *   dialog held, plus an optional hand-written **expression** (a `WHERE`
 *   fragment on SQL, a filter document on MongoDB) ANDed with them. ANDed, not
 *   an alternative mode: the conditions stay a bijection with the chips, and
 *   nothing has to be translated between the two forms, which is lossy both
 *   ways;
 * - **Projection** — which fields come back (`lib/grid/projection.ts` adds the
 *   key columns on the way to the wire);
 * - **Advanced** — collation and an index hint, folded to one line until
 *   opened, because most browses never need them and the panel already
 *   competes with the rows for height;
 * - **Result** — the statement the draft would run, built by the backend with
 *   the code the browse uses, so it cannot drift from what executes. It is
 *   also where a bad expression shows up, before it is applied; and "Open in
 *   editor" is the way out for anything the panel cannot express.
 * It is a panel rather than a modal because it is meant to grow into the rest
 * of the query (projection, a raw filter, the query it produces) without
 * turning into a stack of dialogs, and because a modal hides the rows you are
 * filtering: here the page stays on screen under the conditions that shape it.
 * Keeping both would have meant two places editing the same `serverFilters`,
 * which is the one thing this surface must not have.
 *
 * **It is a bijection with `serverFilters`, as the dialog was.** Every filter
 * shape has a control in `FilterConditionRow`, so the panel edits the whole
 * array, in order, and a toolbar chip's index names the row seeded from it —
 * that is all `focusIndex` is. Hold a filter shape aside again and chip-editing
 * silently edits the wrong row.
 *
 * ## The draft and the applied filters
 *
 * Both rows are one draft: nothing reaches the server until **Apply** (or
 * Ctrl/⌘+Enter), which applies the conditions and the projection together.
 * The applied state also changes from outside while the panel
 * is open — a chip's ✕, a right-click "Filter by this value" — and the rule for
 * that is the one that loses nothing the user can see:
 *
 * - a draft that **says the same** as the applied state follows it, so the
 *   panel always shows what is in force;
 * - a draft that **differs** is kept, and says it has unapplied changes. It is
 *   on screen, so the user can see both it and the chips it would replace.
 *
 * "Differs" is a comparison, not a "was anything touched?" flag: the draft and
 * the applied state are both put through the same `filterFromDraft` and
 * compared as the wire would see them. A flag claimed unapplied changes after
 * any interaction at all — switching the projection mode and back, opening the
 * expression editor and closing it — which is a notice that stops being read.
 *
 * Closing the panel discards an edited draft, the way cancelling the dialog
 * did. A draft that outlives the panel showing it would be applied later by
 * someone who no longer remembers typing it.
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Code2,
  Copy,
  KeyRound,
  ListTree,
  Lock,
  Plus,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { NativeSelect } from "@/components/ui/native-select";
import { Segmented } from "@/components/ui/segmented";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/tauri";
import { copyToClipboard } from "@/lib/clipboard";
import { openQueryTab } from "@/lib/tabs/openQueryTab";
import { PolicyLockHint } from "@/components/common/PolicyLock";
import { usePolicyLock } from "@/lib/policy/access";
import { useDebouncedPreview } from "@/lib/useDebouncedPreview";
import { filterFieldsFor, type FilterField } from "@/lib/grid/fieldPaths";
import {
  DOCUMENT_ID,
  isLockedField,
  wireProjection,
} from "@/lib/grid/projection";
import { formatForDisplay } from "@/lib/keybindings/chord";
import type {
  ColumnFilter,
  ColumnInfo,
  Driver,
  Projection,
  QueryPreview,
  TableQuery,
} from "@/types";
import { FilterConditionRow } from "@/components/grid/dialogs/FilterConditionRow";
import {
  draftFromFilter,
  emptyDraft,
  filterFromDraft,
  overlongListRows,
  patchDraft,
  type FilterConditionDraft,
} from "@/components/grid/dialogs/filterConditions";

let nextKey = 1;

/** Rows seeded from `applied`, plus which row came from which filter — the
 *  map a chip's index is resolved through. */
function seed(applied: ColumnFilter[]): {
  rows: FilterConditionDraft[];
  seeded: number[];
} {
  const rows = applied.map((f) => draftFromFilter(f, nextKey++));
  return { rows, seeded: rows.map((r) => r.key) };
}

/** The projection row's draft. `all` is "no projection"; the other two keep
 *  their field list so switching modes does not throw the picks away. */
type ProjectionMode = "all" | "include" | "exclude";
interface ProjectionDraft {
  mode: ProjectionMode;
  fields: string[];
}

function seedProjection(p: Projection | undefined): ProjectionDraft {
  if (!p || p.fields.length === 0) return { mode: "all", fields: [] };
  return { mode: p.exclude ? "exclude" : "include", fields: [...p.fields] };
}

function projectionFromDraft(d: ProjectionDraft): Projection | undefined {
  if (d.mode === "all" || d.fields.length === 0) return undefined;
  return { fields: d.fields, exclude: d.mode === "exclude" };
}

/** What the panel applies: the conditions and the projection, together. */
export interface QueryPanelApply {
  filters: ColumnFilter[];
  projection: Projection | undefined;
  /** The expression as typed; `""` is none. */
  raw: string;
  /** Collation and index hint as typed; `""` is none. */
  collation: string;
  hint: string;
}

/**
 * Everything the *Result* line needs besides the draft: where the browse
 * points and how it is sorted, searched and paged. The panel fills in the
 * draft's conditions, expression and projection. Absent → no Result row
 * (a surface with nothing to ask).
 */
export type QueryPanelPreviewBase = Omit<
  TableQuery,
  "filters" | "raw" | "projection" | "collation" | "hint" | "withCount"
>;

/**
 * "Open the panel on this chip's row", as an event rather than a state: the
 * same chip clicked twice has to scroll and focus twice, which a plain index
 * would not (it would be equal the second time). Same reasoning as the list
 * view's `ExpandAllSignal`.
 */
export interface QueryPanelFocus {
  index: number;
  epoch: number;
}

export function QueryPanel({
  columns,
  nestedFields,
  customFields,
  applied,
  appliedProjection,
  appliedRaw = "",
  appliedCollation = "",
  appliedHint = "",
  driver,
  indexNames = null,
  document = false,
  keyColumns = NO_KEYS,
  rawLocked = null,
  preview,
  focus,
  onApply,
  onClose,
}: {
  columns: ColumnInfo[];
  /** Nested paths found in the page on screen (MongoDB) — see
   *  `lib/grid/fieldPaths.ts`. */
  nestedFields?: FilterField[];
  /** A field outside the lists may be typed (MongoDB). */
  customFields?: boolean;
  /** The filters in force — `serverFilters`. */
  applied: ColumnFilter[];
  /** The projection in force, as the user chose it (no key columns added). */
  appliedProjection?: Projection;
  /** The expression in force, as typed. */
  appliedRaw?: string;
  /** Collation and index hint in force, as typed. */
  appliedCollation?: string;
  appliedHint?: string;
  /** Which engine — the *Advanced* row's controls differ per dialect. */
  driver?: Driver;
  /** The table's index names, for the hint picker; `null` while unknown. */
  indexNames?: string[] | null;
  /** See {@link QueryPanelPreviewBase}. */
  preview?: QueryPanelPreviewBase;
  /** MongoDB: the projection can exclude, and `_id` is the locked key. */
  document?: boolean;
  /** SQL: the primary key's columns, shown locked in the projection. */
  keyColumns?: readonly string[];
  /**
   * Why the managed policy does not allow the expression here (it is free SQL
   * on a SQL driver). One already applied is shown read-only, so the person
   * can see and remove it, but it takes no part in the preview.
   */
  rawLocked?: string | null;
  /** The chip the user clicked to get here, if they did. */
  focus: QueryPanelFocus | null;
  onApply: (next: QueryPanelApply) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();

  const [draft, setDraft] = useState(() => seed(applied));
  const [projection, setProjection] = useState(() =>
    seedProjection(appliedProjection),
  );
  const [raw, setRaw] = useState(appliedRaw);
  const [collation, setCollation] = useState(appliedCollation);
  const [hint, setHint] = useState(appliedHint);
  /** The expression editor is shown: something typed, or asked for. */
  const [rawOpen, setRawOpen] = useState(() => appliedRaw.trim() !== "");
  /** Set by Apply: the next applied state is this draft, so re-seed from it
   *  (which is what keeps the chip → row map honest) even though the draft
   *  differs from the state it is replacing. */
  const [followNext, setFollowNext] = useState(false);

  const fields = useMemo(
    () => filterFieldsFor(columns, nestedFields ?? []),
    [columns, nestedFields],
  );
  const typeByColumn = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of fields) if (f.type) m.set(f.path, f.type);
    return m;
  }, [fields]);

  const rows = draft.rows;
  /** The draft's conditions as the wire takes them. */
  const draftFilters = useMemo(
    () =>
      rows
        .filter((r) => r.column)
        .map((r) => filterFromDraft(r, typeByColumn.get(r.column))),
    [rows, typeByColumn],
  );

  // What the draft is compared against: the applied state this panel last
  // saw, put through the very conversion the draft goes through.
  const [seenApplied, setSeenApplied] = useState(applied);
  const [seenProjection, setSeenProjection] = useState(appliedProjection);
  const [seenRaw, setSeenRaw] = useState(appliedRaw);
  const [seenCollation, setSeenCollation] = useState(appliedCollation);
  const [seenHint, setSeenHint] = useState(appliedHint);
  const baseline = useMemo(
    () => ({
      filters: JSON.stringify(
        seenApplied.map((f) =>
          filterFromDraft(draftFromFilter(f, 0), typeByColumn.get(f.column)),
        ),
      ),
      projection: JSON.stringify(
        projectionFromDraft(seedProjection(seenProjection)) ?? null,
      ),
      raw: seenRaw.trim(),
      collation: seenCollation.trim(),
      hint: seenHint.trim(),
    }),
    [seenApplied, seenProjection, seenRaw, seenCollation, seenHint, typeByColumn],
  );
  const dirty =
    JSON.stringify(draftFilters) !== baseline.filters ||
    JSON.stringify(projectionFromDraft(projection) ?? null) !==
      baseline.projection ||
    raw.trim() !== baseline.raw ||
    collation.trim() !== baseline.collation ||
    hint.trim() !== baseline.hint;

  // Follow the applied state while the draft says the same — see the module
  // header. React's "adjust state when a prop changes" pattern, set during
  // render and tracked in state (not a ref) so StrictMode's discarded first
  // pass cannot swallow the update; `DocumentCard` documents that trap.
  if (
    seenApplied !== applied ||
    seenProjection !== appliedProjection ||
    seenRaw !== appliedRaw ||
    seenCollation !== appliedCollation ||
    seenHint !== appliedHint
  ) {
    setSeenApplied(applied);
    setSeenProjection(appliedProjection);
    setSeenRaw(appliedRaw);
    setSeenCollation(appliedCollation);
    setSeenHint(appliedHint);
    if (!dirty || followNext) {
      setFollowNext(false);
      setDraft(seed(applied));
      setProjection(seedProjection(appliedProjection));
      setRaw(appliedRaw);
      setRawOpen(appliedRaw.trim() !== "");
      setCollation(appliedCollation);
      setHint(appliedHint);
    }
  }

  const [focusedKey, setFocusedKey] = useState<number | null>(null);
  const [seenFocus, setSeenFocus] = useState<QueryPanelFocus | null>(null);
  if (focus !== seenFocus) {
    setSeenFocus(focus);
    setFocusedKey(focus ? (draft.seeded[focus.index] ?? null) : null);
  }

  const focusedRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (focusedKey == null) return;
    const el = focusedRef.current;
    if (!el) return;
    el.scrollIntoView({ block: "nearest" });
    el.querySelector<HTMLElement>("input, textarea, button")?.focus();
    // `focus` in the deps: the same row asked for twice is focused twice.
  }, [focusedKey, focus]);

  /** Rows whose value list is over the backend's cap — Apply is blocked while
   *  any exists, rather than truncating or letting the call fail. */
  const overlong = useMemo(() => overlongListRows(rows), [rows]);

  function edit(next: (prev: FilterConditionDraft[]) => FilterConditionDraft[]) {
    setDraft((prev) => ({ ...prev, rows: next(prev.rows) }));
  }

  const addRow = () =>
    edit((prev) => [...prev, emptyDraft(fields[0]?.path ?? "", nextKey++)]);
  const removeRow = (key: number) =>
    edit((prev) => prev.filter((r) => r.key !== key));
  const patchRow = (key: number, patch: Partial<FilterConditionDraft>) =>
    edit((prev) => prev.map((r) => (r.key === key ? patchDraft(r, patch) : r)));

  function editProjection(next: ProjectionDraft) {
    setProjection(next);
  }

  function editRaw(next: string) {
    setRaw(next);
  }

  const result = useQueryPreview(preview, {
    filters: draftFilters,
    raw: rawLocked ? "" : raw,
    projection: wireProjection(projectionFromDraft(projection), {
      document,
      keyColumns,
    }),
    collation,
    hint,
  });

  function apply() {
    if (overlong.size > 0 || result.error) return;
    onApply({
      filters: draftFilters,
      projection: projectionFromDraft(projection),
      raw: raw.trim() ? raw : "",
      collation: collation.trim(),
      hint: hint.trim(),
    });
    // The applied filters are about to become exactly this draft; re-seeding
    // from them when the new array arrives keeps the chip → row map honest.
    setFollowNext(true);
    setFocusedKey(null);
  }

  function reset() {
    setDraft(seed(applied));
    setProjection(seedProjection(appliedProjection));
    setRaw(appliedRaw);
    setRawOpen(appliedRaw.trim() !== "");
    setCollation(appliedCollation);
    setHint(appliedHint);
    setFocusedKey(null);
  }

  function onKeyDown(e: ReactKeyboardEvent) {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      apply();
    }
  }

  return (
    <section
      aria-label={t("tableData.query.title")}
      className="flex max-h-[45vh] shrink-0 flex-col border-b border-border bg-muted/20 text-xs"
      onKeyDown={onKeyDown}
    >
      <div className="relative min-h-0 flex-1 overflow-auto px-3 pb-2 pt-2.5">
        <IconButton
          icon={X}
          label={t("tableData.query.close")}
          className="absolute right-2 top-1.5"
          onClick={onClose}
        />
        <div className="space-y-3 pr-8">
          <PanelRow label={t("tableData.query.filter")}>
            <p className="pt-1 text-2xs text-muted-foreground">
              {t("tableData.query.matchAll")}
            </p>
            {rows.length === 0 ? (
              <p className="text-2xs text-muted-foreground">
                {t("tableData.filter.empty")}
              </p>
            ) : (
              rows.map((r) => (
                <FilterConditionRow
                  key={r.key}
                  ref={r.key === focusedKey ? focusedRef : undefined}
                  highlighted={r.key === focusedKey}
                  fields={fields}
                  customFields={customFields}
                  row={r}
                  onPatch={(patch) => patchRow(r.key, patch)}
                  onRemove={() => removeRow(r.key)}
                />
              ))
            )}
            <Button
              type="button"
              variant="outline"
              size="xs"
              icon={Plus}
              // A field list that came back empty still leaves a condition
              // writable when the path can be typed — the MongoDB case.
              disabled={fields.length === 0 && !customFields}
              onClick={addRow}
            >
              {t("tableData.filter.addRow")}
            </Button>
            {rawOpen ? (
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-2xs text-muted-foreground">
                    {document
                      ? t("tableData.query.expressionMongoHint")
                      : t("tableData.query.expressionSqlHint")}
                  </span>
                  <IconButton
                    size="xs"
                    icon={X}
                    label={t("tableData.query.removeExpression")}
                    onClick={() => {
                      editRaw("");
                      setRawOpen(false);
                    }}
                  />
                </div>
                {rawLocked && (
                  <p className="flex items-center gap-1 text-2xs text-muted-foreground">
                    <Lock aria-hidden className="h-3 w-3 shrink-0" />
                    {rawLocked}
                  </p>
                )}
                <Textarea
                  autoFocus={raw === "" && !rawLocked}
                  readOnly={!!rawLocked}
                  aria-label={t("tableData.query.expression")}
                  spellCheck={false}
                  rows={Math.min(6, Math.max(2, raw.split("\n").length))}
                  className="font-mono text-xs"
                  placeholder={
                    document
                      ? "{ qty: { $gt: 3 }, code: /^IMPCR/ }"
                      : "qty > 3 OR notes IS NULL"
                  }
                  value={raw}
                  onChange={(e) => editRaw(e.target.value)}
                />
              </div>
            ) : (
              <PolicyLockHint reason={rawLocked}>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  icon={Plus}
                  disabled={!!rawLocked}
                  onClick={() => setRawOpen(true)}
                >
                  {document
                    ? t("tableData.query.addExpressionMongo")
                    : t("tableData.query.addExpressionSql")}
                </Button>
              </PolicyLockHint>
            )}
          </PanelRow>
          <PanelRow
            label={
              document
                ? t("tableData.query.projection")
                : t("tableData.query.columns")
            }
          >
            <ProjectionEditor
              value={projection}
              onChange={editProjection}
              choices={fields}
              document={document}
              keyColumns={keyColumns}
            />
          </PanelRow>
          <PanelRow label={t("tableData.query.advanced")}>
            <AdvancedOptions
              driver={driver}
              collation={collation}
              hint={hint}
              indexNames={indexNames}
              onCollation={setCollation}
              onHint={setHint}
            />
          </PanelRow>
          {preview && (
            <PanelRow label={t("tableData.query.result")}>
              <ResultLine
                connectionId={preview.connectionId}
                result={result}
              />
            </PanelRow>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2 border-t border-border/60 px-3 py-1.5">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={
            rows.length === 0 &&
            projection.mode === "all" &&
            raw === "" &&
            collation === "" &&
            hint === ""
          }
          onClick={() => {
            edit(() => []);
            editProjection({ mode: "all", fields: [] });
            editRaw("");
            setRawOpen(false);
            setCollation("");
            setHint("");
          }}
        >
          {t("tableData.filter.clearAll")}
        </Button>
        {dirty && (
          <span className="text-2xs text-warning">
            {t("tableData.query.unapplied")}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={!dirty}
            onClick={reset}
          >
            {t("tableData.query.reset")}
          </Button>
          {/* The shortcut sits beside the button, never inside it: a key cap
              is drawn on the neutral surfaces (`bg-muted`), and on a
              primary-filled button that box reads as a dark patch stuck on
              top of the theme's colour. A local key handler rather than a
              catalogue action: it only ever means "apply this panel", and
              only while focus is in it. */}
          <span className="text-2xs text-muted-foreground" aria-hidden>
            <Kbd>{formatForDisplay("Mod+Enter")}</Kbd>
          </span>
          <Button
            type="button"
            size="xs"
            disabled={overlong.size > 0 || !!result.error}
            aria-keyshortcuts="Control+Enter Meta+Enter"
            onClick={apply}
          >
            {t("tableData.filter.apply")}
          </Button>
        </div>
      </div>
    </section>
  );
}

const NO_KEYS: readonly string[] = [];

/** One labelled row of the panel: the label gutter, then its controls. */
function PanelRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <div className="w-24 shrink-0 pt-1.5">
        <span className="text-3xs font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
      </div>
      <div className="min-w-0 flex-1 space-y-2">{children}</div>
    </div>
  );
}

/** Two paths MongoDB refuses in one projection: the same one twice, or one
 *  inside the other (`meta` with `meta.plant` is a "path collision"). */
function collides(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);
}

/**
 * The projection row: which fields come back.
 *
 * The key is drawn **locked**, first, and is never in the pick list — the
 * primary key's columns on SQL, `_id` on MongoDB. The browse adds it on the
 * way to the wire whatever the user picks (`wireProjection`), because every
 * edit addresses a row by it. Showing it as picked-and-removable would offer
 * a choice that cannot be made.
 */
function ProjectionEditor({
  value,
  onChange,
  choices,
  document,
  keyColumns,
}: {
  value: ProjectionDraft;
  onChange: (next: ProjectionDraft) => void;
  choices: FilterField[];
  document: boolean;
  keyColumns: readonly string[];
}) {
  const { t } = useTranslation();
  const exclude = value.mode === "exclude";
  const lockOpts = { document, keyColumns, exclude };

  const locked =
    value.mode === "include" ? (document ? [DOCUMENT_ID] : [...keyColumns]) : [];
  const pickable = choices
    .map((c) => c.path)
    .filter(
      (path) =>
        !isLockedField(path, lockOpts) &&
        !value.fields.some((f) => collides(f, path)),
    );

  const modes = document
    ? [
        { value: "all" as const, label: t("tableData.query.projAllFields") },
        { value: "include" as const, label: t("tableData.query.projInclude") },
        { value: "exclude" as const, label: t("tableData.query.projExclude") },
      ]
    : [
        { value: "all" as const, label: t("tableData.query.projAll") },
        { value: "include" as const, label: t("tableData.query.projPick") },
      ];

  const hint =
    value.mode === "all"
      ? null
      : exclude
        ? t("tableData.query.idNotExcludable")
        : document
          ? t("tableData.query.idLocked")
          : keyColumns.length > 0
            ? t("tableData.query.keyLocked")
            : null;

  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5">
        <Segmented<ProjectionMode>
          size="sm"
          aria-label={t("tableData.query.projectionMode")}
          value={value.mode}
          onValueChange={(mode) => onChange({ ...value, mode })}
          options={modes}
        />
        {value.mode !== "all" && (
          <>
            {locked.map((f) => (
              <span
                key={`locked-${f}`}
                className="flex h-6 items-center gap-1 rounded-md border border-dashed border-border px-2 font-mono text-2xs text-muted-foreground"
              >
                {document ? (
                  <Lock className="h-3 w-3" />
                ) : (
                  <KeyRound className="h-3 w-3 text-pk" />
                )}
                {f}
              </span>
            ))}
            {value.fields
              .filter((f) => !isLockedField(f, lockOpts))
              .map((f) => (
                <span
                  key={f}
                  className="flex h-6 items-center gap-0.5 rounded-md border border-border bg-background pl-2 font-mono text-2xs"
                >
                  {f}
                  <IconButton
                    flat
                    size="xs"
                    icon={X}
                    label={t("tableData.query.removeField", { field: f })}
                    onClick={() =>
                      onChange({
                        ...value,
                        fields: value.fields.filter((x) => x !== f),
                      })
                    }
                  />
                </span>
              ))}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="xs" icon={Plus}>
                  {document
                    ? t("tableData.query.addField")
                    : t("tableData.query.addColumn")}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-w-[22rem]">
                {pickable.length === 0 ? (
                  <DropdownMenuItem disabled>
                    {t("tableData.query.noMoreFields")}
                  </DropdownMenuItem>
                ) : (
                  pickable.map((path) => (
                    <DropdownMenuItem
                      key={path}
                      className="font-mono"
                      onSelect={() =>
                        onChange({ ...value, fields: [...value.fields, path] })
                      }
                    >
                      {path}
                    </DropdownMenuItem>
                  ))
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
      </div>
      {hint && <p className="text-2xs text-muted-foreground">{hint}</p>}
      {value.mode !== "all" && value.fields.length === 0 && (
        <p className="text-2xs text-muted-foreground">
          {t("tableData.query.pickHint")}
        </p>
      )}
    </>
  );
}

/** What the *Result* line is showing: the statement, the error that stops
 *  it, or neither while the first answer is on its way — plus the draft query
 *  itself, which *Explain* sends as is. */
interface PreviewState {
  preview: QueryPreview | null;
  error: string | null;
  query: TableQuery | null;
  /** The draft's identity: a plan read for another key is stale. */
  key: string;
}

/**
 * Ask the backend for the statement the draft would run, a beat after the
 * draft last changed (`useDebouncedPreview`). A slower, older answer never
 * overwrites a newer one. `base` absent → nothing is asked.
 */
function useQueryPreview(
  base: QueryPanelPreviewBase | undefined,
  draft: Pick<TableQuery, "filters" | "raw" | "projection" | "collation" | "hint">,
): PreviewState {
  const [state, setState] = useState<Pick<PreviewState, "preview" | "error">>({
    preview: null,
    error: null,
  });
  const latest = useRef(0);
  const query: TableQuery | null = base
    ? {
        ...base,
        filters: draft.filters?.length ? draft.filters : undefined,
        raw: draft.raw?.trim() ? draft.raw : undefined,
        projection: draft.projection,
        collation: draft.collation?.trim() || undefined,
        hint: draft.hint?.trim() || undefined,
        withCount: false,
      }
    : null;
  const key = query ? JSON.stringify(query) : "";
  const queryRef = useRef(query);
  queryRef.current = query;
  const run = useCallback(() => {
    const q = queryRef.current;
    if (!q) return;
    const id = ++latest.current;
    api.describeTableQuery(q).then(
      (preview) => {
        if (id === latest.current) setState({ preview, error: null });
      },
      (e: unknown) => {
        if (id === latest.current) setState({ preview: null, error: String(e) });
      },
    );
  }, []);
  useDebouncedPreview(key, run);
  return { ...state, query, key };
}

/**
 * The *Result* row: the statement, and the two ways to take it elsewhere.
 *
 * **One line unless asked.** The statement is formatted for reading — MongoDB's
 * shell text puts every key on its own line — and drawn as-is it made the panel
 * half the height of the tab, pushing the rows it shapes out of view. The row
 * shows it collapsed onto one line, truncated, and the expand toggle opens the
 * formatted text in a bounded box. The collapsing is display-only: Copy and
 * Open in editor always take the statement exactly as the backend wrote it, so
 * a `-- comment` in a SQL expression still ends at its line break there.
 */
function ResultLine({
  connectionId,
  result,
}: {
  connectionId: string;
  result: PreviewState;
}) {
  const { t } = useTranslation();
  const editorLock = usePolicyLock(connectionId, "freeSql");
  const [expanded, setExpanded] = useState(false);
  const [plan, setPlan] = useState<PlanState | null>(null);
  // A plan read for an earlier draft describes a different query: drop it
  // rather than show it next to a statement it does not belong to.
  const current = plan && plan.key === result.key ? plan : null;

  function explain() {
    const q = result.query;
    if (!q) return;
    const key = result.key;
    setPlan({ key, loading: true });
    api.explainTableQuery(q).then(
      (p) => setPlan((s) => (s?.key === key ? { key, raw: p.raw } : s)),
      (e: unknown) =>
        setPlan((s) => (s?.key === key ? { key, error: String(e) } : s)),
    );
  }

  if (result.error) {
    return (
      <p
        role="alert"
        className="max-h-20 overflow-auto rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 font-mono text-2xs text-destructive"
      >
        {result.error}
      </p>
    );
  }
  const text = result.preview?.text ?? "";
  const oneLine = text.replace(/\s*\n\s*/g, " ");
  return (
    <div className="space-y-1.5">
      <div className="flex items-start gap-1 rounded-md border border-border bg-background py-0.5 pl-2 pr-0.5">
        {expanded ? (
          <pre className="max-h-32 min-w-0 flex-1 overflow-auto whitespace-pre-wrap break-all py-1 font-mono text-2xs">
            {text || "…"}
          </pre>
        ) : (
          <code className="min-w-0 flex-1 truncate py-1 font-mono text-2xs leading-4">
            {oneLine || "…"}
          </code>
        )}
        <div className="flex shrink-0 items-center">
          <IconButton
            size="xs"
            icon={expanded ? ChevronsDownUp : ChevronsUpDown}
            label={
              expanded
                ? t("tableData.query.collapseResult")
                : t("tableData.query.expandResult")
            }
            aria-expanded={expanded}
            disabled={!text}
            onClick={() => setExpanded((e) => !e)}
          />
          <IconButton
            size="xs"
            icon={Copy}
            label={t("tableData.query.copy")}
            disabled={!text}
            onClick={() => void copyToClipboard(text)}
          />
          <PolicyLockHint reason={editorLock}>
            <IconButton
              size="xs"
              icon={Code2}
              label={t("tableData.query.openInEditor")}
              disabled={!text || !!editorLock}
              onClick={() => openQueryTab(connectionId, { sql: text })}
            />
          </PolicyLockHint>
          <IconButton
            size="xs"
            icon={ListTree}
            label={t("tableData.query.explain")}
            disabled={!text || !result.query}
            loading={current?.loading}
            onClick={explain}
          />
        </div>
      </div>
      {current && <PlanBox plan={current} onClose={() => setPlan(null)} />}
    </div>
  );
}

/** A plan request for one draft (`key`): in flight, answered, or failed. */
interface PlanState {
  key: string;
  loading?: boolean;
  raw?: unknown;
  error?: string;
}

/**
 * The plan under the *Result* line — engine-native JSON, as Pulse shows it,
 * in a box of bounded height for the same reason the Result line folds: the
 * panel must not push the rows out of view.
 */
function PlanBox({ plan, onClose }: { plan: PlanState; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="rounded-md border border-border bg-background">
      <div className="flex items-center justify-between gap-2 border-b border-border/60 py-0.5 pl-2 pr-0.5">
        <span className="text-2xs font-medium text-muted-foreground">
          {t("tableData.query.plan")}
        </span>
        <IconButton
          size="xs"
          icon={X}
          label={t("tableData.query.closePlan")}
          onClick={onClose}
        />
      </div>
      {plan.loading ? (
        <p className="px-2 py-1.5 text-2xs text-muted-foreground">
          {t("pulse.explain.loading")}
        </p>
      ) : plan.error ? (
        <p role="alert" className="px-2 py-1.5 font-mono text-2xs text-destructive">
          {t("pulse.explain.error")} {plan.error}
        </p>
      ) : (
        <pre className="max-h-48 overflow-auto px-2 py-1.5 font-mono text-3xs leading-relaxed">
          {JSON.stringify(plan.raw, null, 2)}
        </pre>
      )}
    </div>
  );
}

/** Per-dialect example for the collation field — the spelling each engine
 *  names one with, so the placeholder doubles as the syntax hint. */
const COLLATION_PLACEHOLDER: Partial<Record<Driver, string>> = {
  postgres: "es-ES-x-icu",
  mysql: "utf8mb4_spanish_ci",
  sqlserver: "Latin1_General_CI_AS",
  mongodb: "{ locale: 'es', strength: 1 }",
};

/**
 * The *Advanced* row: collation and index hint.
 *
 * Folded to a one-line summary until opened, and opened already when either
 * is set, so a tab restored with a hint shows it. The controls are the
 * dialect's: SQLite has three collations and gets a picker; PostgreSQL has no
 * index hints and gets the picker disabled with that reason, rather than a
 * field that could only fail — the matrix the design settled on.
 */
function AdvancedOptions({
  driver,
  collation,
  hint,
  indexNames,
  onCollation,
  onHint,
}: {
  driver?: Driver;
  collation: string;
  hint: string;
  indexNames: string[] | null;
  onCollation: (v: string) => void;
  onHint: (v: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(() => collation !== "" || hint !== "");
  const id = useId();
  const isMongo = driver === "mongodb";
  const noHints = driver === "postgres";

  const summary =
    [
      collation.trim() &&
        t("tableData.query.collationSummary", { value: collation.trim() }),
      hint.trim() && t("tableData.query.hintSummary", { value: hint.trim() }),
    ]
      .filter(Boolean)
      .join(" · ") || t("tableData.query.advancedNone");

  if (!open) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="xs"
        icon={ChevronRight}
        aria-expanded={false}
        className="max-w-full"
        onClick={() => setOpen(true)}
      >
        <span className="truncate font-normal text-muted-foreground">
          {summary}
        </span>
      </Button>
    );
  }

  const options = indexNames ?? [];
  // A saved hint whose index is gone still shows, so it can be seen and
  // cleared rather than silently dropped from the picker.
  const hintChoices =
    hint && !options.includes(hint) ? [hint, ...options] : options;

  return (
    <div className="space-y-2">
      <Button
        type="button"
        variant="ghost"
        size="xs"
        icon={ChevronDown}
        aria-expanded
        onClick={() => setOpen(false)}
      >
        {t("tableData.query.advancedHide")}
      </Button>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {/* The name is the <label>; the explanation is a description. Wrapping
            both in the label made the control's accessible name the whole
            paragraph. */}
        <div className="flex min-w-0 flex-col gap-1">
          <label
            htmlFor={`${id}-collation`}
            className="text-2xs font-medium text-muted-foreground"
          >
            {t("tableData.query.collation")}
          </label>
          {driver === "sqlite" ? (
            <NativeSelect
              id={`${id}-collation`}
              aria-describedby={`${id}-collation-help`}
              size="xs"
              value={collation.toUpperCase()}
              onChange={(e) => onCollation(e.target.value)}
            >
              <option value="">{t("tableData.query.none")}</option>
              <option value="BINARY">BINARY</option>
              <option value="NOCASE">NOCASE</option>
              <option value="RTRIM">RTRIM</option>
            </NativeSelect>
          ) : (
            <Input
              id={`${id}-collation`}
              aria-describedby={`${id}-collation-help`}
              size="xs"
              spellCheck={false}
              className="font-mono"
              placeholder={driver ? COLLATION_PLACEHOLDER[driver] : undefined}
              value={collation}
              onChange={(e) => onCollation(e.target.value)}
            />
          )}
          <span
            id={`${id}-collation-help`}
            className="text-2xs text-muted-foreground"
          >
            {isMongo
              ? t("tableData.query.collationMongoHint")
              : t("tableData.query.collationSqlHint")}
          </span>
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <label
            htmlFor={`${id}-hint`}
            className="text-2xs font-medium text-muted-foreground"
          >
            {t("tableData.query.hint")}
          </label>
          <NativeSelect
            id={`${id}-hint`}
            aria-describedby={`${id}-hint-help`}
            size="xs"
            disabled={noHints || indexNames === null}
            value={noHints ? "" : hint}
            onChange={(e) => onHint(e.target.value)}
          >
            <option value="">
              {noHints
                ? t("tableData.query.hintUnavailable")
                : indexNames === null
                  ? t("tableData.query.hintLoading")
                  : t("tableData.query.none")}
            </option>
            {!noHints &&
              hintChoices.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
          </NativeSelect>
          <span id={`${id}-hint-help`} className="text-2xs text-muted-foreground">
            {noHints
              ? t("tableData.query.hintPostgres")
              : t("tableData.query.hintHelp")}
          </span>
        </div>
      </div>
    </div>
  );
}
