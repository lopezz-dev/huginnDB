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
import { Database, Download, Plus, SquareTerminal, X } from "lucide-react";

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
import { mongoshTarget } from "@/lib/terminal/target";
import type { TerminalEnvironment } from "@/lib/terminal/types";
import { usePreferences, selectTerminalPrefs } from "@/stores/preferences/preferences";
import { useConnections } from "@/stores/session/connections";
import { useTabs } from "@/stores/session/tabs";
import { useMongoshDownload } from "@/stores/session/mongoshDownload";
import { useTerminals } from "@/stores/session/terminals";
import { useUi } from "@/stores/session/ui";
import { MongoshDownload } from "./MongoshDownload";
import { TerminalView } from "./TerminalView";

/** Free text with every verb is what `mongosh` asks of the policy
 *  (`guard::mongosh`); the first of these that is locked is the reason. */
const MONGOSH_NEEDS = ["freeSql", "insert", "update", "delete", "ddl"] as const;

/**
 * What this machine can start, fetched when the panel first shows and again
 * when the paths in Settings change or a `mongosh` download lands. `null`
 * while the first answer is pending.
 */
function useTerminalEnvironment(): TerminalEnvironment | null {
  const prefs = usePreferences(selectTerminalPrefs);
  const downloaded = useMongoshDownload((s) => s.revision);
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
  }, [prefs.mongoshPath, prefs.shellPath, downloaded]);
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

  /**
   * `mongosh` is offered at all only while the workspace is on a connected
   * MongoDB connection. With nothing selected, a SQL connection or a MongoDB
   * one that is closed, the button, the menu item and every word about
   * mongosh (a missing binary included) stay out of the way: they used to
   * show as a disabled button plus a reason, which on a SQL connection read
   * as an error about a tool the user never asked for.
   */
  const offerMongosh = target !== null;
  /** Why the offered `mongosh` cannot start, in words; `null` if it can. */
  const mongoshBlocker: string | null =
    !env || !offerMongosh ? null : (env.mongoshError ?? policyLock);
  const canMongosh = env !== null && offerMongosh && mongoshBlocker === null;
  const canShell = env !== null && env.shellError === null;
  /** No `mongosh` anywhere: the binary is the problem, so the way to fix it
   *  is the one action offered, not a disabled "mongosh on X" beside it. */
  const mongoshMissing = offerMongosh && env?.mongoshMissing === true;
  /** …and a build exists for this machine, the policy lets this person fetch
   *  it, and it could be used afterwards: offer to fetch it instead of only
   *  saying where to install it by hand. */
  const canDownload =
    mongoshMissing &&
    env.mongoshDownloadable &&
    env.mongoshDownloadBlocked === null &&
    policyLock === null;
  const downloading = useMongoshDownload((s) => s.status.phase === "running");
  const startDownload = useMongoshDownload((s) => s.start);
  const attachDownload = useMongoshDownload((s) => s.attach);
  // A download another window (or the page before a reload) started.
  const runningElsewhere = env?.mongoshDownloading === true;
  useEffect(() => {
    if (runningElsewhere) void attachDownload();
  }, [runningElsewhere, attachDownload]);
  /** What the empty state says about a missing `mongosh`: the same thing the
   *  button beside it does. Without a button, how to install it by hand. */
  const missingNotice = canDownload
    ? t("terminal.download.missing")
    : env?.mongoshDownloadBlocked
      ? `${env.mongoshError ?? ""} ${env.mongoshDownloadBlocked}`.trim()
      : mongoshBlocker;

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

  const mongoshLabel = target ? t("terminal.newMongoshOn", { name: target.title }) : null;
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
            : t(offerMongosh ? "terminal.empty.hint" : "terminal.empty.hintShell")
        }
        notice={mongoshMissing ? missingNotice : mongoshBlocker}
        noticeTone={env?.mongoshError ? "warning" : "info"}
        action={
          <div className="flex flex-wrap items-center justify-center gap-2">
            {offerMongosh && !mongoshMissing && (
              <Button size="sm" icon={Database} disabled={!canMongosh} onClick={openMongosh}>
                {mongoshLabel}
              </Button>
            )}
            <Button
              size="sm"
              variant={offerMongosh && !canDownload ? "outline" : "default"}
              icon={SquareTerminal}
              disabled={!canShell}
              onClick={openShell}
            >
              {shellLabel}
            </Button>
            {(canDownload || downloading) && <MongoshDownload />}
            {offerMongosh && env?.mongoshError && !downloading && (
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
            {offerMongosh && !mongoshMissing && (
              <DropdownMenuItem disabled={!canMongosh} onSelect={openMongosh}>
                <Database className="mr-2 h-4 w-4" />
                {mongoshLabel}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem disabled={!canShell} onSelect={openShell}>
              <SquareTerminal className="mr-2 h-4 w-4" />
              {shellLabel}
            </DropdownMenuItem>
            {canDownload && (
              <DropdownMenuItem disabled={downloading} onSelect={() => void startDownload()}>
                <Download className="mr-2 h-4 w-4" />
                {t(downloading ? "terminal.download.running" : "terminal.download.button")}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        {mongoshBlocker && !canDownload && (
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
