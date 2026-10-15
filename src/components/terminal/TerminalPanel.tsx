/**
 * The bottom dock's Terminal tab: a strip of sessions over the active one.
 *
 * Two kinds of session, chosen from the strip's "+" menu or the empty state:
 *
 * - **mongosh** on the workspace's current MongoDB connection, signed in by
 *   the backend with that connection's own credentials. This is what the
 *   panel exists for: the scripts AI tools write for MongoDB (variables,
 *   loops, `printjson`) run as written, which the query editor's bounded
 *   parser refuses by design.
 * - **a shell** — PowerShell on Windows, the user's `$SHELL` elsewhere.
 *
 * Every tab's `TerminalView` stays mounted while another shows, so switching
 * keeps each session and its scrollback; closing a tab ends its session.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Database, Plus, SquareTerminal, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown";
import { EmptyState } from "@/components/common/EmptyState";
import { useSettingsDialog } from "@/components/settings/useSettingsDialog";
import { api } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { usePolicyLocker } from "@/lib/policy/access";
import { mongoshTarget, type MongoshUnavailable } from "@/lib/terminal/target";
import type { TerminalEnvironment } from "@/lib/terminal/types";
import { usePreferences, selectTerminalPrefs } from "@/stores/preferences/preferences";
import { useConnections } from "@/stores/session/connections";
import { useTabs } from "@/stores/session/tabs";
import { useTerminals } from "@/stores/session/terminals";
import { useUi } from "@/stores/session/ui";
import { TerminalView } from "./TerminalView";

/** Free text with every verb is what `mongosh` asks of the policy
 *  (`guard::mongosh`); the first of these that is locked is the reason. */
const MONGOSH_NEEDS = ["freeSql", "insert", "update", "delete", "ddl"] as const;

const UNAVAILABLE_KEY: Record<MongoshUnavailable, string> = {
  noConnection: "terminal.mongosh.noConnection",
  notMongo: "terminal.mongosh.notMongo",
  notConnected: "terminal.mongosh.notConnected",
};

/**
 * What this machine can start, fetched when the panel first shows and again
 * when the paths in Settings change. `null` while the first answer is pending.
 */
function useTerminalEnvironment(): TerminalEnvironment | null {
  const prefs = usePreferences(selectTerminalPrefs);
  const [env, setEnv] = useState<TerminalEnvironment | null>(null);
  useEffect(() => {
    let cancelled = false;
    void api
      .terminalEnvironment()
      .then((e) => {
        if (!cancelled) setEnv(e);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [prefs.mongoshPath, prefs.shellPath]);
  return env;
}

/**
 * `visible` is whether the panel is on screen at all (the dock open on the
 * Terminal tab): a tab is focused when it becomes visible, not only when it
 * becomes the selected one.
 */
export function TerminalPanel({ visible }: { visible: boolean }) {
  const { t } = useTranslation();
  const tabs = useTerminals((s) => s.tabs);
  const activeKey = useTerminals((s) => s.activeKey);
  const open = useTerminals((s) => s.open);
  const close = useTerminals((s) => s.close);
  const select = useTerminals((s) => s.select);
  const openSettings = useSettingsDialog((s) => s.openAt);
  const env = useTerminalEnvironment();

  const selectedConnectionId = useUi((s) => s.selectedConnectionId);
  const profiles = useConnections((s) => s.profiles);
  const active = useConnections((s) => s.active);
  const focusedTabConnectionId = useTabs(
    (s) => s.tabs.find((tab) => tab.id === s.activeId)?.connectionId ?? null,
  );
  const resolved = mongoshTarget(selectedConnectionId, focusedTabConnectionId, profiles, active);
  const target = "target" in resolved ? resolved.target : null;
  const lockOf = usePolicyLocker(target?.connectionId ?? null);
  const policyLock = target
    ? (MONGOSH_NEEDS.map((need) => lockOf(need)).find((reason) => reason !== null) ?? null)
    : null;

  /** Why `mongosh` cannot be offered right now, in words; `null` if it can. */
  const mongoshBlocker: string | null = !env
    ? null
    : env.mongoshError
      ? env.mongoshError
      : "unavailable" in resolved
        ? t(UNAVAILABLE_KEY[resolved.unavailable])
        : policyLock;
  const canMongosh = env !== null && mongoshBlocker === null && target !== null;
  const canShell = env !== null && env.shellError === null;

  const openMongosh = () => {
    if (!target) return;
    open({
      kind: "mongosh",
      connectionId: target.connectionId,
      database: target.database,
      title: target.title,
    });
  };
  const openShell = () =>
    open({ kind: "shell", connectionId: null, database: null, title: env?.shell ?? "shell" });

  const mongoshLabel = target
    ? t("terminal.newMongoshOn", { name: target.title })
    : t("terminal.newMongosh");
  const shellLabel = t("terminal.newShell", { shell: env?.shell ?? "shell" });

  if (tabs.length === 0) {
    return (
      <EmptyState
        size="sm"
        icon={SquareTerminal}
        title={t("terminal.empty.title")}
        hint={
          env === null
            ? t("terminal.detecting")
            : (mongoshBlocker ?? t("terminal.empty.hint"))
        }
        action={
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button size="sm" icon={Database} disabled={!canMongosh} onClick={openMongosh}>
              {mongoshLabel}
            </Button>
            <Button
              size="sm"
              variant="outline"
              icon={SquareTerminal}
              disabled={!canShell}
              onClick={openShell}
            >
              {shellLabel}
            </Button>
            {env?.mongoshError && (
              <Button size="sm" variant="link" onClick={() => openSettings("terminal")}>
                {t("terminal.openSettings")}
              </Button>
            )}
          </div>
        }
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div
        role="tablist"
        aria-label={t("panels.terminal")}
        className="flex h-7 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border px-1"
      >
        {tabs.map((tab) => {
          const selected = tab.key === activeKey;
          return (
            <div
              key={tab.key}
              className={cn(
                "group/termtab flex h-6 shrink-0 items-center gap-1 rounded-sm pl-1 pr-0.5 text-xs",
                selected ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60",
              )}
            >
              <Button
                type="button"
                role="tab"
                aria-selected={selected}
                variant="quiet"
                flat
                size="xs"
                icon={tab.kind === "mongosh" ? Database : SquareTerminal}
                onClick={() => select(tab.key)}
                className={cn(
                  "h-6 max-w-[16rem] px-1 hover:bg-transparent",
                  selected && "text-foreground",
                  tab.exited && "opacity-60",
                )}
              >
                <span className="truncate">{tab.title}</span>
              </Button>
              <IconButton
                size="xs"
                flat
                icon={X}
                label={t("terminal.closeTab")}
                side="top"
                onClick={() => close(tab.key)}
              />
            </div>
          );
        })}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton size="xs" flat icon={Plus} label={t("terminal.newSession")} side="top" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem disabled={!canMongosh} onSelect={openMongosh}>
              <Database className="mr-2 h-4 w-4" />
              {mongoshLabel}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!canShell} onSelect={openShell}>
              <SquareTerminal className="mr-2 h-4 w-4" />
              {shellLabel}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {mongoshBlocker && (
          <span className="ml-2 truncate text-2xs text-muted-foreground">{mongoshBlocker}</span>
        )}
      </div>
      <div className="min-h-0 flex-1">
        {tabs.map((tab) => (
          <TerminalView key={tab.key} tab={tab} active={tab.key === activeKey} visible={visible} />
        ))}
      </div>
    </div>
  );
}
