/**
 * Console panel — in-app SQL log, HeidiSQL-style.
 *
 * Mounts a virtualized list of [`LogEntry`] (driven by `useLogs`) plus a
 * detail pane that renders the currently-selected entry's SQL in a
 * Monaco read-only viewer. The list captures every backend command that
 * crossed the Tauri bridge: SQL execution, connection open/close, and
 * test_connection. Failed entries get a red border + error message.
 *
 * Filtering is intentionally derived inside the component (via
 * `useMemo`) and not from a Zustand selector — selectors that return
 * fresh arrays would re-render the panel on every push and break the
 * reference-stability rule called out in CLAUDE.md.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import Editor from "@monaco-editor/react";
import {
  ChevronsDown,
  ChevronsUp,
  MessageSquarePlus,
  Pause,
  Play,
  SearchX,
  TerminalSquare,
  Trash2,
  X,
} from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";
import { SearchField } from "@/components/ui/search-field";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/components/common/EmptyState";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { useLogs, type LogKindFilter } from "@/stores/query/logs";
import { useFeedbackDialog } from "@/stores/dialogs/feedbackDialog";
import {
  usePreferences,
  selectEditorPrefs,
} from "@/stores/preferences/preferences";
import { useMonacoTheme } from "@/lib/monaco/useMonacoTheme";
import type { LogEntry } from "@/types";
import { readOnlyEditorOptions } from "@/lib/monaco/editorOptions";
import { useEditorOptions } from "@/lib/monaco/useEditorOptions";

/** `HH:MM:SS.mmm` — fixed-width clock used by every console row so the
 *  column stays vertically aligned. */
function formatTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** Build a bug-report prefill from a failed console entry, so "Report this
 *  error" opens the FeedbackDialog with the driver / SQL / error already
 *  filled in. The user can edit before submitting. */
function errorReportPrefill(entry: LogEntry) {
  const lines = [
    "While using HuginnDB I hit this error:",
    "",
    "```",
    entry.error ?? "",
    "```",
  ];
  if (entry.sql) {
    lines.push("", "Statement:", "```sql", entry.sql, "```");
  }
  if (entry.driver) lines.push("", `Driver: ${entry.driver}`);
  return {
    kind: "bug" as const,
    title: (entry.error ?? "Error").slice(0, 80),
    description: lines.join("\n"),
  };
}

/** Collapse whitespace so a multi-line SQL statement renders on a single
 *  row in the list. The full statement still shows up in the detail
 *  pane / tooltip — this is purely cosmetic for the preview. */
function previewSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

/** Visual "tag" used both by the list rows and the detail header. */
function Chip({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-sm px-1 py-0.5 text-3xs uppercase",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Console() {
  const { t } = useTranslation();
  const entries = useLogs((s) => s.entries);
  const paused = useLogs((s) => s.paused);
  const query = useLogs((s) => s.query);
  const kinds = useLogs((s) => s.kinds);
  const clear = useLogs((s) => s.clear);
  const setPaused = useLogs((s) => s.setPaused);
  const setQuery = useLogs((s) => s.setQuery);
  const toggleKind = useLogs((s) => s.toggleKind);
  const editorPrefs = usePreferences(selectEditorPrefs);
  // Resolved through the hook, not the bare function: an imported
  // theme's definition arrives after first paint, and only a store
  // subscription repaints this editor when it does.
  const monacoTheme = useMonacoTheme(editorPrefs.theme);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const listRef = useRef<VirtuosoHandle>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter((e) => {
      if (!kinds[e.kind as LogKindFilter]) return false;
      if (!q) return true;
      const haystack =
        (e.sql ?? "") +
        " " +
        (e.message ?? "") +
        " " +
        (e.driver ?? "") +
        " " +
        (e.error ?? "");
      return haystack.toLowerCase().includes(q);
    });
  }, [entries, query, kinds]);

  const selected: LogEntry | null = useMemo(() => {
    if (selectedId == null) return null;
    return entries.find((e) => e.id === selectedId) ?? null;
  }, [entries, selectedId]);

  const selectedDetailValue =
    selected?.sql ?? selected?.message ?? selected?.error ?? "";

  const detailEditorOptions = useEditorOptions(
    () => ({
      ...readOnlyEditorOptions(editorPrefs),
      // A log entry is a single value, not a document: nothing to fold, and
      // a highlighted "current line" implies a caret.
      renderLineHighlight: "none" as const,
      folding: false,
    }),
    [editorPrefs],
  );

  // Esc closes the detail pane and returns to the full list — so inspecting a
  // record no longer requires clearing the console to get back (1.1.1 fix).
  useEffect(() => {
    if (selectedId == null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelectedId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId]);

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      {/* Toolbar */}
      <div className="flex items-center gap-1 border-b border-border px-2 py-1">
        <IconButton
          icon={paused ? Play : Pause}
          label={paused ? t("console.resume") : t("console.pause")}
          onClick={() => setPaused(!paused)}
        />
        <IconButton
          icon={Trash2}
          label={t("console.clear")}
          onClick={() => {
            clear();
            setSelectedId(null);
          }}
        />
        <IconButton
          icon={ChevronsUp}
          label={t("console.scrollTop")}
          disabled={filtered.length === 0}
          onClick={() =>
            listRef.current?.scrollToIndex({ index: 0, behavior: "smooth" })
          }
        />
        <IconButton
          icon={ChevronsDown}
          label={t("console.scrollBottom")}
          disabled={filtered.length === 0}
          onClick={() =>
            listRef.current?.scrollToIndex({
              index: filtered.length - 1,
              behavior: "smooth",
            })
          }
        />
        <Separator className="mx-1" />
        <label className="flex items-center gap-1 text-2xs text-muted-foreground">
          <Checkbox
            size="xs"
            checked={kinds.sql}
            onChange={() => toggleKind("sql")}
          />
          {t("console.kindSql")}
        </label>
        <label className="flex items-center gap-1 text-2xs text-muted-foreground">
          <Checkbox
            size="xs"
            checked={kinds.connection}
            onChange={() => toggleKind("connection")}
          />
          {t("console.kindConnection")}
        </label>
        <label className="flex items-center gap-1 text-2xs text-muted-foreground">
          <Checkbox
            size="xs"
            checked={kinds.ai}
            onChange={() => toggleKind("ai")}
          />
          {t("console.kindAi")}
        </label>
        <Separator className="mx-1" />
        <SearchField
          size="sm"
          value={query}
          onValueChange={setQuery}
          placeholder={t("console.filterPlaceholder")}
          className="flex-1"
          inputClassName="font-mono"
        />
        <div className="px-1 text-3xs tabular-nums text-muted-foreground">
          {filtered.length}/{entries.length}
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-hidden">
        {filtered.length === 0 ? (
          <EmptyState
            size="sm"
            icon={entries.length === 0 ? TerminalSquare : SearchX}
            title={
              entries.length === 0
                ? t("console.emptyNoActivity")
                : t("console.emptyNoMatch")
            }
          />
        ) : (
          <Virtuoso
            ref={listRef}
            data={filtered}
            followOutput={paused ? false : "smooth"}
            itemContent={(_index, entry) => (
              <ConsoleRow
                entry={entry}
                selected={selectedId === entry.id}
                onClick={() => setSelectedId(entry.id)}
              />
            )}
          />
        )}
      </div>

      {/* Detail pane */}
      {selected && (
        <div className="flex h-48 flex-col border-t border-border">
          <div className="flex items-center gap-2 border-b border-border bg-card/40 px-2 py-1 font-mono text-3xs text-muted-foreground">
            <span>{formatTime(selected.timestamp_ms)}</span>
            {selected.driver && (
              <Chip className="bg-muted text-muted-foreground">
                {selected.driver}
              </Chip>
            )}
            <Chip className="bg-muted text-muted-foreground">
              {selected.kind}
            </Chip>
            {selected.duration_ms != null && (
              <span>{selected.duration_ms} ms</span>
            )}
            {selected.rows_affected != null && (
              <span>{selected.rows_affected} rows</span>
            )}
            {selected.connection_id && (
              <span className="truncate">conn {selected.connection_id}</span>
            )}
            {selected.error && (
              <Button
                flat
                size="sm"
                variant="ghost"
                className="ml-auto h-5 gap-1 px-1.5 text-2xs"
                onClick={() =>
                  useFeedbackDialog
                    .getState()
                    .openWith(errorReportPrefill(selected))
                }
                title={t("feedback.reportThisError")}
              >
                <MessageSquarePlus className="h-3 w-3" />
                {t("feedback.reportThisError")}
              </Button>
            )}
            <IconButton
              flat
              size="xs"
              icon={X}
              label={t("console.closeDetail")}
              className={cn("h-5 w-5 shrink-0", !selected.error && "ml-auto")}
              onClick={() => setSelectedId(null)}
            />
          </div>
          {selected.error && (
            <div className="border-b border-destructive/40 bg-destructive/10 px-2 py-1 font-mono text-2xs text-destructive">
              {selected.error}
            </div>
          )}
          <div className="flex-1">
            <Editor
              height="100%"
              language={selected.kind === "sql" ? "sql" : "plaintext"}
              theme={monacoTheme}
              value={selectedDetailValue}
              options={detailEditorOptions}
            />
          </div>
        </div>
      )}
    </div>
  );
}

interface ConsoleRowProps {
  entry: LogEntry;
  selected: boolean;
  onClick: () => void;
}

function ConsoleRow({ entry, selected, onClick }: ConsoleRowProps) {
  const preview = entry.sql ? previewSql(entry.sql) : (entry.message ?? "");
  const isError = entry.error != null;

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 border-b border-border/40 px-2 py-1 text-left font-mono text-2xs hover:bg-accent",
        selected && "bg-accent/40",
        isError && "border-l-2 border-l-destructive",
      )}
    >
      <span className="shrink-0 text-muted-foreground">
        {formatTime(entry.timestamp_ms)}
      </span>
      {entry.driver && (
        <Chip className="bg-muted text-muted-foreground">{entry.driver}</Chip>
      )}
      <Chip
        className={
          entry.kind === "sql"
            ? "bg-primary/10 text-primary"
            : "bg-muted text-muted-foreground"
        }
      >
        {entry.kind}
      </Chip>
      {entry.duration_ms != null && (
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {entry.duration_ms}ms
        </span>
      )}
      {entry.rows_affected != null && (
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {entry.rows_affected}r
        </span>
      )}
      <span
        className={cn("min-w-0 flex-1 truncate", isError && "text-destructive")}
        title={preview}
      >
        {preview}
      </span>
    </button>
  );
}
