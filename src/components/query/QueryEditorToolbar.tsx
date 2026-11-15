/**
 * The query tab's action row: Run, the timer, Save, History and — on a
 * multi-database server — the database selector. Extracted from
 * `QueryEditorTab` (ADR #137, step 2) with no change of behaviour.
 *
 * Chrome only: every action is a callback the tab owns, and the selector
 * shows `useDatabaseSelector`'s state without deciding anything.
 */

import { forwardRef } from "react";
import { useTranslation } from "react-i18next";
import { Bookmark, ChevronDown, Database, History, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown";
import { ShortcutHint } from "@/components/menus/ShortcutHint";
import { Spinner } from "@/components/ui/spinner";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { QueryTimer } from "@/components/query/QueryTimer";
import { DEFAULT_DB, type DatabaseSelector } from "@/lib/query/useDatabaseSelector";
import type { QueryTimerHandle } from "@/lib/query/useQueryRun";
import type { RunScope } from "@/lib/query/runTarget";

interface Props {
  /** Statements in the buffer, for the menu's "Run all (N)". */
  statementCount: number;
  /** Whether the editor holds a non-empty selection. */
  hasSelection: boolean;
  /** Nothing to run or save. */
  empty: boolean;
  running: boolean;
  /** The Run shortcut, formatted for display; `undefined` when unbound. */
  runShortcut: string | undefined;
  /** Run what `scope` names. The button is `cursor`; the ▾ offers the rest. */
  onRun: (scope: RunScope) => void;
  onSave: () => void;
  historyOpen: boolean;
  onToggleHistory: () => void;
  /** The selector, or `null` where the driver has one database. */
  databases: Pick<DatabaseSelector, "databases" | "selectedDb" | "switchDatabase"> | null;
}

/** `ref` is the timer's handle, which `useQueryRun` drives. */
export const QueryEditorToolbar = forwardRef<QueryTimerHandle, Props>(
  function QueryEditorToolbar(
    {
      statementCount,
      hasSelection,
      empty,
      running,
      runShortcut,
      onRun,
      onSave,
      historyOpen,
      onToggleHistory,
      databases,
    },
    timerRef,
  ) {
    const { t } = useTranslation();
    return (
      <div className="flex items-center gap-1 border-b border-border bg-background px-2 py-1">
        {/* Run is the `runQuery` gesture: the selection, else the statement
            under the cursor (ADR #137). The ▾ names each scope explicitly,
            the whole buffer included — which used to be what Run did. */}
        <div className="flex items-center">
          <Button
            size="sm"
            onClick={() => onRun("cursor")}
            disabled={empty || running}
            title={
              runShortcut
                ? t("query.runTitle", { shortcut: runShortcut })
                : t("query.runTitleUnbound")
            }
            className="gap-1.5 rounded-r-none"
          >
            {running ? <Spinner size="sm" /> : <Play className="h-3.5 w-3.5" />}
            {running ? t("query.running") : t("query.run")}
            {!running && runShortcut && (
              <kbd className="ml-0.5 rounded-sm border border-brand-foreground/30 bg-brand-foreground/10 px-1 py-px text-3xs font-medium leading-none">
                {runShortcut}
              </kbd>
            )}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                disabled={empty || running}
                aria-label={t("query.runMenu")}
                className="rounded-l-none border-l border-brand-foreground/20 px-1"
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem
                className="text-xs"
                onSelect={() => onRun("statement")}
              >
                {t("query.runStatementItem")}
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-xs"
                disabled={!hasSelection}
                onSelect={() => onRun("selection")}
              >
                {t("query.runSelectionItem")}
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-xs"
                title={t("query.runAllTitle")}
                onSelect={() => onRun("all")}
              >
                {t("query.runAllItem", { count: statementCount })}
                <ShortcutHint action="runAll" />
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <QueryTimer ref={timerRef} running={running} />
        <Separator className="mx-1" />
        <Button
          size="sm"
          variant="ghost"
          onClick={onSave}
          disabled={empty}
          title={t("query.saveQuery")}
        >
          <Bookmark className="h-3.5 w-3.5" />
        </Button>
        <Button
          size="sm"
          variant={historyOpen ? "secondary" : "ghost"}
          aria-pressed={historyOpen}
          onClick={onToggleHistory}
          title={t("query.history")}
        >
          <History className="h-3.5 w-3.5" />
        </Button>

        {databases && databases.databases.length > 0 && (
          <div className="ml-auto flex items-center gap-1">
            <Database className="h-3.5 w-3.5 text-muted-foreground" />
            <Select
              value={databases.selectedDb ?? DEFAULT_DB}
              onValueChange={(v) => void databases.switchDatabase(v)}
            >
              <SelectTrigger
                className="h-6 w-44 text-xs"
                title={t("query.database")}
              >
                <SelectValue placeholder={t("query.defaultDatabase")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DEFAULT_DB} className="text-xs">
                  {t("query.defaultDatabase")}
                </SelectItem>
                {databases.databases.map((db) => (
                  <SelectItem key={db.name} value={db.name} className="text-xs">
                    {db.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>
    );
  },
);
