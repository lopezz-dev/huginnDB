/**
 * The query tab's toolbar (ADR #137, layout A): Run with its ▾, the timer,
 * then Format, Save, History and Explain (AI) as icons, and the database
 * selector at the end. Every action is visible while there is room; as the
 * pane narrows they move into a "⋯" menu, through `useToolbarDensity` — the
 * grid toolbar's hook, with this bar's own widths:
 *
 * - `wide` — everything inline;
 * - `compact` — the icon actions go to "⋯", Run, the timer and the database
 *   selector stay;
 * - `narrow` — the database selector goes too, as a submenu of "⋯".
 *
 * Chrome only: every action is a callback the tab owns, and an action the tab
 * cannot take is passed as `undefined` and not offered (ADR #136) — Format on
 * MongoDB, Explain on a connection where the AI is off.
 */

import { forwardRef, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  Bookmark,
  ChevronDown,
  Database,
  History,
  MoreHorizontal,
  Play,
  Sparkles,
  WandSparkles,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
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
import type { ActionId } from "@/lib/keybindings";
import {
  useToolbarDensity,
  type DensityBreakpoints,
} from "@/lib/grid/toolbarDensity";

/**
 * Run with its ▾ and the timer (~190 px), four icons (~130 px) and the
 * database selector (~200 px) fit in a little over 520 px; below ~380 px the
 * selector no longer fits next to Run and "⋯".
 */
const QUERY_TOOLBAR_BREAKPOINTS: DensityBreakpoints = { wide: 560, compact: 380 };

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
  /** Format the selection or the buffer; `undefined` where the tab cannot
   *  (MongoDB). */
  onFormat: (() => void) | undefined;
  onSave: () => void;
  historyOpen: boolean;
  onToggleHistory: () => void;
  /** Ask the AI to explain the selection or the statement; `undefined` where
   *  the AI is off for this connection. */
  onExplain: (() => void) | undefined;
  /** The selector, or `null` where the driver has one database. */
  databases: Pick<DatabaseSelector, "databases" | "selectedDb" | "switchDatabase"> | null;
}

/** One icon action, drawn in the bar or in "⋯" from the same description. */
interface Action {
  id: string;
  icon: LucideIcon;
  label: string;
  run: () => void;
  disabled?: boolean;
  /** A toggle's state: `aria-pressed` in the bar, a check in the menu. */
  pressed?: boolean;
  shortcut?: ActionId;
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
      onFormat,
      onSave,
      historyOpen,
      onToggleHistory,
      onExplain,
      databases,
    },
    timerRef,
  ) {
    const { t } = useTranslation();
    const barRef = useRef<HTMLDivElement>(null);
    const density = useToolbarDensity(barRef, QUERY_TOOLBAR_BREAKPOINTS);
    const iconsInBar = density === "wide";
    const selectorInBar = density !== "narrow";

    const actions: Action[] = [
      ...(onFormat
        ? [
            {
              id: "format",
              icon: WandSparkles,
              label: t("query.format"),
              run: onFormat,
              disabled: empty,
              shortcut: "formatQuery" as const,
            },
          ]
        : []),
      {
        id: "save",
        icon: Bookmark,
        label: t("query.saveQuery"),
        run: onSave,
        disabled: empty,
      },
      {
        id: "history",
        icon: History,
        label: t("query.history"),
        run: onToggleHistory,
        pressed: historyOpen,
      },
      ...(onExplain
        ? [
            {
              id: "explain",
              icon: Sparkles,
              label: t("query.explain"),
              run: onExplain,
              disabled: empty,
            },
          ]
        : []),
    ];

    const showSelector = !!databases && databases.databases.length > 0;
    const overflow = !iconsInBar || (showSelector && !selectorInBar);

    return (
      <div
        ref={barRef}
        className="flex items-center gap-1 border-b border-border bg-background px-2 py-1"
      >
        {/* Run is the `runQuery` gesture: the selection, else the statement
            under the cursor. The ▾ names each scope explicitly, the whole
            buffer included — which used to be what Run did. */}
        <div className="flex shrink-0 items-center">
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
              <DropdownMenuItem className="text-xs" onSelect={() => onRun("statement")}>
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

        {iconsInBar && (
          <>
            <Separator className="mx-1" />
            {actions.map((a) => (
              <IconButton
                key={a.id}
                icon={a.icon}
                label={a.label}
                flat
                onClick={a.run}
                disabled={a.disabled}
                aria-pressed={a.pressed}
                className={a.pressed ? "bg-secondary" : undefined}
              />
            ))}
          </>
        )}

        <div className="ml-auto flex items-center gap-1">
          {showSelector && selectorInBar && (
            <>
              <Database className="h-3.5 w-3.5 text-muted-foreground" />
              <Select
                value={databases.selectedDb ?? DEFAULT_DB}
                onValueChange={(v) => void databases.switchDatabase(v)}
              >
                <SelectTrigger className="h-6 w-44 text-xs" title={t("query.database")}>
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
            </>
          )}
          {overflow && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton icon={MoreHorizontal} label={t("query.moreActions")} flat />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {!iconsInBar &&
                  actions.map((a) =>
                    a.pressed === undefined ? (
                      <DropdownMenuItem
                        key={a.id}
                        className="text-xs"
                        disabled={a.disabled}
                        onSelect={a.run}
                      >
                        <a.icon className="mr-2 h-3.5 w-3.5" />
                        {a.label}
                        {a.shortcut && <ShortcutHint action={a.shortcut} />}
                      </DropdownMenuItem>
                    ) : (
                      <DropdownMenuCheckboxItem
                        key={a.id}
                        className="text-xs"
                        checked={a.pressed}
                        onCheckedChange={a.run}
                      >
                        {a.label}
                      </DropdownMenuCheckboxItem>
                    ),
                  )}
                {showSelector && !selectorInBar && (
                  <>
                    {!iconsInBar && <DropdownMenuSeparator />}
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger className="text-xs">
                        <Database className="mr-2 h-3.5 w-3.5" />
                        {t("query.database")}
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent>
                        {[
                          { value: DEFAULT_DB, label: t("query.defaultDatabase") },
                          ...databases.databases.map((db) => ({
                            value: db.name,
                            label: db.name,
                          })),
                        ].map((o) => (
                          <DropdownMenuCheckboxItem
                            key={o.value}
                            className="text-xs"
                            checked={(databases.selectedDb ?? DEFAULT_DB) === o.value}
                            onCheckedChange={() => void databases.switchDatabase(o.value)}
                          >
                            {o.label}
                          </DropdownMenuCheckboxItem>
                        ))}
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>
    );
  },
);
