/**
 * Terminal settings: whether the panel is offered, and which `mongosh` and
 * shell it starts.
 *
 * The two paths are overrides — empty means "find it" — so the section shows
 * what detection found right next to each field: a user who never touches
 * them should still be able to see which `mongosh` the panel will run, and
 * which version. Paths are committed on blur / Enter rather than per
 * keystroke: each commit re-runs detection, which starts `mongosh --version`.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, RefreshCw, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/tauri";
import type { TerminalEnvironment } from "@/lib/terminal/types";
import {
  usePreferences,
  selectTerminalPrefs,
} from "@/stores/preferences/preferences";
import { PrefGroup } from "./PrefGroup";
import { PrefRow } from "./PrefRow";

/** A path field that commits when the user is done with it. */
function PathInput({
  id,
  value,
  placeholder,
  onCommit,
}: {
  id: string;
  value: string;
  placeholder: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    const next = draft.trim();
    if (next !== value) onCommit(next);
  };
  return (
    <Input
      id={id}
      value={draft}
      spellCheck={false}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
      }}
      className="h-8 w-72 font-mono text-xs"
    />
  );
}

/**
 * What detection found for one program, under its row. A found program is a
 * quiet line — a check, the label and the path in mono, which is what a user
 * comparing it against their install reads; a missing one is a boxed warning,
 * the same treatment the Terminal panel's empty state gives it, since it is
 * the thing on this page the user has to act on.
 */
function ProgramStatus({
  state,
  path,
  children,
}: {
  state: "pending" | "found" | "error";
  path?: string | null;
  children: React.ReactNode;
}) {
  if (state === "error") {
    return (
      <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs leading-relaxed text-foreground/90">
        <TriangleAlert aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
        <span className="min-w-0 break-words">{children}</span>
      </div>
    );
  }
  return (
    <div className="flex min-w-0 items-start gap-1.5 text-xs text-muted-foreground">
      {state === "found" ? (
        <CheckCircle2 aria-hidden className="h-3.5 w-3.5 shrink-0 text-success" />
      ) : (
        <Spinner className="shrink-0" />
      )}
      <span className="shrink-0">{children}</span>
      {path && (
        <code className="min-w-0 break-all font-mono text-2xs text-foreground/80">{path}</code>
      )}
    </div>
  );
}

export function TerminalSection() {
  const { t } = useTranslation();
  const terminal = usePreferences(selectTerminalPrefs);
  const updateTerminal = usePreferences((s) => s.updateTerminal);
  const [env, setEnv] = useState<TerminalEnvironment | null>(null);
  const [detecting, setDetecting] = useState(false);

  const detect = () => {
    setDetecting(true);
    void api
      .terminalEnvironment()
      .then(setEnv)
      .catch(() => setEnv(null))
      .finally(() => setDetecting(false));
  };
  // Re-detect whenever a committed path changes — the answer depends on it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(detect, [terminal.mongoshPath, terminal.shellPath]);

  const mongoshStatus = !env ? (
    <ProgramStatus state="pending">{t("terminal.detecting")}</ProgramStatus>
  ) : env.mongoshError ? (
    <ProgramStatus state="error">{env.mongoshError}</ProgramStatus>
  ) : (
    <ProgramStatus state="found" path={env.mongoshPath}>
      {t("settings.terminal.found", { version: env.mongoshVersion ?? "?" })}
    </ProgramStatus>
  );
  const shellStatus = !env ? (
    <ProgramStatus state="pending">{t("terminal.detecting")}</ProgramStatus>
  ) : env.shellError ? (
    <ProgramStatus state="error">{env.shellError}</ProgramStatus>
  ) : (
    <ProgramStatus state="found" path={env.shellPath}>
      {t("settings.terminal.shellFound")}
    </ProgramStatus>
  );

  return (
    <div className="space-y-5 text-sm">
      <p className="text-xs text-muted-foreground">{t("settings.terminal.intro")}</p>

      <PrefGroup title={t("settings.rowGroups.module")}>
        <PrefRow
          label={t("settings.terminal.enabled.label")}
          prefId="terminal.enabled"
          description={t("settings.terminal.enabled.desc")}
        >
          <Switch
            checked={terminal.enabled}
            onCheckedChange={(v) => updateTerminal({ enabled: v })}
            aria-label={t("settings.terminal.enabled.label")}
          />
        </PrefRow>
      </PrefGroup>

      <PrefGroup
        title={t("settings.rowGroups.programs")}
        action={
          // Acts on both rows, so it sits on the group's title line rather than
          // under the last row, where it read as belonging to the shell alone.
          <Button
            size="xs"
            variant="outline"
            icon={RefreshCw}
            loading={detecting}
            onClick={detect}
          >
            {t("settings.terminal.detect")}
          </Button>
        }
      >
        <PrefRow
          label={t("settings.terminal.mongoshPath.label")}
          prefId="terminal.mongoshPath"
          description={t("settings.terminal.mongoshPath.desc")}
          htmlFor="prefs-terminal-mongosh"
          footer={mongoshStatus}
        >
          <PathInput
            id="prefs-terminal-mongosh"
            value={terminal.mongoshPath}
            placeholder={t("settings.terminal.auto")}
            onCommit={(v) => updateTerminal({ mongoshPath: v })}
          />
        </PrefRow>

        <PrefRow
          label={t("settings.terminal.shellPath.label")}
          prefId="terminal.shellPath"
          description={t("settings.terminal.shellPath.desc")}
          htmlFor="prefs-terminal-shell"
          footer={shellStatus}
        >
          <PathInput
            id="prefs-terminal-shell"
            value={terminal.shellPath}
            placeholder={t("settings.terminal.auto")}
            onCommit={(v) => updateTerminal({ shellPath: v })}
          />
        </PrefRow>
      </PrefGroup>

      <p className="text-xs text-muted-foreground">{t("settings.terminal.security")}</p>
    </div>
  );
}
