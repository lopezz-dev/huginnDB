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
import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

  const mongoshStatus = !env
    ? t("terminal.detecting")
    : env.mongoshError
      ? env.mongoshError
      : t("settings.terminal.found", {
          version: env.mongoshVersion ?? "?",
          path: env.mongoshPath,
        });
  const shellStatus = !env
    ? t("terminal.detecting")
    : (env.shellError ?? t("settings.terminal.shellFound", { path: env.shellPath }));

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

      <PrefGroup title={t("settings.rowGroups.programs")}>
        <PrefRow
          label={t("settings.terminal.mongoshPath.label")}
          prefId="terminal.mongoshPath"
          description={t("settings.terminal.mongoshPath.desc")}
          htmlFor="prefs-terminal-mongosh"
        >
          <PathInput
            id="prefs-terminal-mongosh"
            value={terminal.mongoshPath}
            placeholder={t("settings.terminal.auto")}
            onCommit={(v) => updateTerminal({ mongoshPath: v })}
          />
        </PrefRow>
        <p
          className={
            env?.mongoshError
              ? "text-xs text-warning"
              : "break-all text-xs text-muted-foreground"
          }
        >
          {mongoshStatus}
        </p>

        <PrefRow
          label={t("settings.terminal.shellPath.label")}
          prefId="terminal.shellPath"
          description={t("settings.terminal.shellPath.desc")}
          htmlFor="prefs-terminal-shell"
        >
          <PathInput
            id="prefs-terminal-shell"
            value={terminal.shellPath}
            placeholder={t("settings.terminal.auto")}
            onCommit={(v) => updateTerminal({ shellPath: v })}
          />
        </PrefRow>
        <p
          className={
            env?.shellError ? "text-xs text-warning" : "break-all text-xs text-muted-foreground"
          }
        >
          {shellStatus}
        </p>

        <div>
          <Button
            size="xs"
            variant="outline"
            icon={RefreshCw}
            loading={detecting}
            onClick={detect}
          >
            {t("settings.terminal.detect")}
          </Button>
        </div>
      </PrefGroup>

      <p className="text-xs text-muted-foreground">{t("settings.terminal.security")}</p>
    </div>
  );
}
