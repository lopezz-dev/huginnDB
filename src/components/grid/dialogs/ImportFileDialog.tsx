/**
 * Import a CSV, JSON or Excel file into a SQL table (ADR #139).
 *
 * Opened by the table grid's Insert menu and by the table's node in the
 * schema tree, both after the person has picked the file (`pickImportFile`),
 * so a cancelled picker opens nothing and `path` is never a placeholder.
 *
 * **The file is never read here.** `preview_import_file` reads it in Rust and
 * hands back its columns and first rows; this dialog only proposes a mapping
 * (`defaultMapping`: by name, ignoring case) and lets the person change it.
 * What a value means for a column — `NULL`, a boolean, a decimal comma — is
 * decided by the backend, which has the catalogue (`commands::import`).
 *
 * The policy's column limits are shown, not enforced (ADR #96): a column the
 * person may not insert into starts unmapped and says why; the backend is
 * what refuses it.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileUp, Lock } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DialogActions } from "@/components/ui/dialog-actions";
import { NativeSelect } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { pickImportFile } from "@/lib/dialogs";
import { notify } from "@/lib/notify";
import { usePolicyColumns } from "@/lib/policy/access";
import { api } from "@/lib/tauri";
import {
  carryMapping,
  defaultMapping,
  previewCell,
  toColumnSources,
  type ImportMapping,
} from "@/lib/transfer/importMapping";
import { useAsyncSubmit } from "@/lib/useAsyncSubmit";
import type {
  ColumnInfo,
  ImportPreview,
  ImportReadOptions,
  InsertRowsSummary,
} from "@/types";

/** Sample values shown next to each mapped column. */
const SAMPLE_VALUES = 3;

/** The delimiters a CSV can be read with; `""` is "detect". */
const DELIMITERS = ["", ",", ";", "\t"] as const;

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function ImportFileDialog({
  open,
  onOpenChange,
  connectionId,
  schema,
  table,
  path: initialPath,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connectionId: string;
  schema?: string;
  /** Table to import into, named in the title. */
  table: string;
  /** The file the caller had the person pick. */
  path: string;
  /** Called after the rows are committed — refresh what shows them. */
  onImported: (summary: InsertRowsSummary) => void;
}) {
  const { t } = useTranslation();
  const [path, setPath] = useState(initialPath);
  const [delimiter, setDelimiter] = useState("");
  const [sheet, setSheet] = useState<string | undefined>(undefined);
  const [hasHeader, setHasHeader] = useState(true);
  const [emptyAsNull, setEmptyAsNull] = useState(true);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [columns, setColumns] = useState<ColumnInfo[] | null>(null);
  const [mapping, setMapping] = useState<ImportMapping | null>(null);
  const { submitting, error, run, clearError } = useAsyncSubmit();
  const relation = useMemo(() => ({ schema, name: table }), [schema, table]);
  const policy = usePolicyColumns(connectionId, relation);

  // A new file from the caller starts the dialog over.
  useEffect(() => {
    setPath(initialPath);
  }, [initialPath]);

  useEffect(() => {
    if (!open) return;
    let live = true;
    api
      .listColumns(connectionId, schema, table)
      .then((cols) => live && setColumns(cols))
      .catch((e: unknown) => live && setPreviewError(String(e)));
    return () => {
      live = false;
    };
  }, [open, connectionId, schema, table]);

  // `delimiter` "" means "let the backend detect it"; it is sent as absent.
  const options: ImportReadOptions = useMemo(
    () => ({
      delimiter: delimiter || undefined,
      sheet,
      hasHeader,
    }),
    [delimiter, sheet, hasHeader],
  );

  useEffect(() => {
    if (!open) return;
    let live = true;
    setPreviewError(null);
    clearError();
    api
      .previewImportFile(path, options)
      .then((p) => {
        if (!live) return;
        setPreview(p);
      })
      .catch((e: unknown) => {
        if (!live) return;
        setPreview(null);
        setPreviewError(String(e));
      });
    return () => {
      live = false;
    };
  }, [open, path, options, clearError]);

  const tableColumns = useMemo(
    () => (columns ?? []).map((c) => c.name),
    [columns],
  );

  // Re-proposed whenever the file's columns change, keeping what the person
  // already chose where it still fits.
  useEffect(() => {
    if (!preview || !columns) return;
    const fresh = defaultMapping(tableColumns, preview.columns, policy.insert);
    setMapping((prev) => carryMapping(prev, fresh, preview.columns.length));
  }, [preview, columns, tableColumns, policy.insert]);

  const sources = useMemo(
    () => (mapping ? toColumnSources(tableColumns, mapping) : []),
    [tableColumns, mapping],
  );

  const changeFile = useCallback(async () => {
    const picked = await pickImportFile(t("dataGrid.importFile.pickTitle"));
    if (!picked) return;
    setDelimiter("");
    setSheet(undefined);
    setMapping(null);
    setPath(picked);
  }, [t]);

  const submit = useCallback(() => {
    if (!preview || sources.length === 0) return;
    run(async () => {
      const summary = await api.importTableFile({
        connectionId,
        schema,
        table,
        path,
        options,
        mapping: sources,
        emptyAsNull,
      });
      notify.success(
        t("dataGrid.importFile.done", { count: summary.inserted, table }),
      );
      onImported(summary);
      onOpenChange(false);
    });
  }, [
    preview,
    sources,
    run,
    connectionId,
    schema,
    table,
    path,
    options,
    emptyAsNull,
    t,
    onImported,
    onOpenChange,
  ]);

  const sampleOf = (source: number | null | undefined): string =>
    source === null || source === undefined || !preview
      ? ""
      : preview.sample
          .slice(0, SAMPLE_VALUES)
          .map((row) => previewCell(row[source]))
          .join(" · ");

  const loading = !previewError && (!preview || !columns || !mapping);
  const isCsv = preview?.format === "csv";
  const isXlsx = preview?.format === "xlsx";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent tier="panel" className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("dataGrid.importFile.title", { table })}</DialogTitle>
          <DialogDescription>{t("dataGrid.importFile.hint")}</DialogDescription>
        </DialogHeader>

        <DialogBody>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
            <span className="flex min-w-0 items-center gap-1.5">
              <FileUp className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <SimpleTooltip label={path}>
                <span className="truncate font-medium">{fileName(path)}</span>
              </SimpleTooltip>
            </span>
            {preview && (
              <span className="text-muted-foreground">
                {t("dataGrid.importFile.summary", {
                  format: preview.format.toUpperCase(),
                  count: preview.totalRows,
                })}
                {preview.encoding ? ` · ${preview.encoding}` : ""}
              </span>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto"
              onClick={() => void changeFile()}
            >
              {t("dataGrid.importFile.changeFile")}
            </Button>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
            {isCsv && (
              <label className="flex items-center gap-2">
                {t("dataGrid.importFile.delimiter")}
                <NativeSelect
                  size="xs"
                  value={delimiter}
                  onChange={(e) => setDelimiter(e.target.value)}
                >
                  {DELIMITERS.map((d) => (
                    <option key={d} value={d}>
                      {d === ""
                        ? t("dataGrid.importFile.delimiterAuto", {
                            detected: delimiterLabel(preview?.delimiter, t),
                          })
                        : delimiterLabel(d, t)}
                    </option>
                  ))}
                </NativeSelect>
              </label>
            )}
            {isXlsx && preview.sheets.length > 1 && (
              <label className="flex items-center gap-2">
                {t("dataGrid.importFile.sheet")}
                <NativeSelect
                  size="xs"
                  value={preview.sheet ?? ""}
                  onChange={(e) => setSheet(e.target.value)}
                >
                  {preview.sheets.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </NativeSelect>
              </label>
            )}
            {(isCsv || isXlsx) && (
              <Checkbox
                checked={hasHeader}
                onChange={(e) => setHasHeader(e.target.checked)}
                label={t("dataGrid.importFile.hasHeader")}
              />
            )}
            <Checkbox
              checked={emptyAsNull}
              onChange={(e) => setEmptyAsNull(e.target.checked)}
              label={t("dataGrid.importFile.emptyAsNull")}
            />
          </div>

          {loading && (
            <div className="mt-6 flex justify-center">
              <Spinner />
            </div>
          )}

          {previewError && (
            <div className="mt-3 whitespace-pre-wrap break-words text-xs text-destructive">
              {t("dataGrid.importFile.unreadable", { message: previewError })}
            </div>
          )}

          {!loading && !previewError && preview && mapping && (
            <div className="mt-3 max-h-[50vh] overflow-auto rounded-md border border-border">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-muted text-left text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1.5 font-medium">
                      {t("dataGrid.importFile.tableColumn")}
                    </th>
                    <th className="px-2 py-1.5 font-medium">
                      {t("dataGrid.importFile.fileColumn")}
                    </th>
                    <th className="px-2 py-1.5 font-medium">
                      {t("dataGrid.importFile.sample")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {(columns ?? []).map((c) => {
                    const lock = policy.lock("insert", c.name);
                    const source = mapping[c.name];
                    return (
                      <tr key={c.name} className="border-t border-border">
                        <td className="px-2 py-1">
                          <span className="font-mono">{c.name}</span>{" "}
                          <span className="text-muted-foreground">
                            {c.data_type}
                          </span>
                        </td>
                        <td className="px-2 py-1">
                          <span className="flex items-center gap-1.5">
                            <NativeSelect
                              size="xs"
                              aria-label={t("dataGrid.importFile.fileColumnFor", {
                                column: c.name,
                              })}
                              value={source === null ? "" : String(source)}
                              onChange={(e) =>
                                setMapping((m) => ({
                                  ...(m ?? {}),
                                  [c.name]:
                                    e.target.value === ""
                                      ? null
                                      : Number(e.target.value),
                                }))
                              }
                            >
                              <option value="">
                                {t("dataGrid.importFile.notImported")}
                              </option>
                              {preview.columns.map((name, i) => (
                                <option key={i} value={String(i)}>
                                  {name}
                                </option>
                              ))}
                            </NativeSelect>
                            {lock && (
                              <SimpleTooltip label={lock}>
                                <span tabIndex={0} aria-label={lock}>
                                  <Lock className="h-3 w-3 text-muted-foreground" />
                                </span>
                              </SimpleTooltip>
                            )}
                          </span>
                        </td>
                        <td className="max-w-[16rem] px-2 py-1 font-mono text-muted-foreground">
                          <SimpleTooltip label={sampleOf(source)}>
                            <span className="block truncate">
                              {sampleOf(source)}
                            </span>
                          </SimpleTooltip>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Above the footer, like the paste dialog: a refused import names
              a row of the file, and it is read next to the mapping that
              produced it. */}
          {error && (
            <div className="mt-3 max-h-24 overflow-y-auto whitespace-pre-wrap break-words text-xs text-destructive">
              {t("dataGrid.importFile.failed", { message: error })}
            </div>
          )}
        </DialogBody>
        <DialogActions
          onCancel={() => onOpenChange(false)}
          cancelLabel={t("common.cancel")}
          onConfirm={submit}
          confirming={submitting}
          confirmingLabel={t("dataGrid.importFile.importing")}
          confirmLabel={t("dataGrid.importFile.confirm", {
            count: preview?.totalRows ?? 0,
          })}
          confirmDisabled={loading || !!previewError || sources.length === 0}
        />
      </DialogContent>
    </Dialog>
  );
}

function delimiterLabel(
  d: string | null | undefined,
  t: (key: string) => string,
): string {
  switch (d) {
    case "\t":
      return t("dataGrid.importFile.tab");
    case ",":
    case ";":
      return d;
    default:
      return "?";
  }
}
