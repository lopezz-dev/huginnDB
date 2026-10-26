/**
 * Settings → Security: who may open HuginnDB on this machine (ADR #118).
 *
 * The app lock lives here, and so will the next two phases of it — Windows
 * Hello as a second way to unlock, and locking with the Windows session — so
 * the section is named for the question rather than for one switch. It is
 * Settings' own section; the tab that lists a database server's users and
 * privileges is a different thing.
 *
 * Built like every other section — groups of rows, the control on the right —
 * so the lock is one more setting, not a page of its own. Its switch does not
 * flip a preference: turning it either way opens the master-password dialog,
 * because whether the lock is on is the existence of the vault
 * (`vault_status`), never a value in `prefs.json`. Only the idle timeout is a
 * preference.
 */

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { KeyRound, Lock, ShieldCheck, TriangleAlert } from "lucide-react";

import { LOCK_CHANGED_EVENT } from "@/components/lock/LockGate";
import {
  MasterPasswordDialog,
  type MasterPasswordMode,
} from "@/components/lock/dialogs/MasterPasswordDialog";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { useShortcutLabel } from "@/lib/keybindings/useShortcutLabel";
import { isWindows } from "@/lib/platform";
import { notify } from "@/lib/notify";
import { api } from "@/lib/tauri";
import { selectLockPrefs, usePreferences } from "@/stores/preferences/preferences";
import type { LockStatus } from "@/types";
import { PrefGroup } from "./PrefGroup";
import { PrefRow } from "./PrefRow";

const IDLE_CHOICES = [0, 5, 10, 15, 30, 60];

export function SecuritySection() {
  const { t } = useTranslation();
  const lock = usePreferences(selectLockPrefs);
  const updateLock = usePreferences((s) => s.updateLock);
  const lockShortcut = useShortcutLabel("lockNow");
  const [status, setStatus] = useState<LockStatus | null>(null);
  const [dialog, setDialog] = useState<MasterPasswordMode | null>(null);

  const refresh = useCallback(() => {
    void api.vaultStatus().then(setStatus, (e) => notify.error(String(e)));
  }, []);
  useEffect(refresh, [refresh]);
  useEffect(() => {
    const unlisten = listen<LockStatus>(LOCK_CHANGED_EVENT, (e) => setStatus(e.payload));
    return () => void unlisten.then((fn) => fn());
  }, []);

  const on = status?.mode === "unlocked";
  const policy = status?.policy;
  // The organization's demands (ADR #120). The backend enforces them; these
  // only show the controls as they will behave.
  const lockPinned = on && policy?.mayDisable === false;
  const maxIdle = policy?.maxIdleMinutes ?? null;
  const idleChoices = maxIdle
    ? [...new Set([...IDLE_CHOICES.filter((m) => m > 0 && m <= maxIdle), maxIdle])].sort(
        (a, b) => a - b,
      )
    : IDLE_CHOICES;
  const idleValue = status ? status.idleMinutes : lock.idleMinutes;
  const sessionPinned = policy?.lockWithSession ?? null;
  const managedNote = (key: string, values: Record<string, unknown> = {}) => (
    <p className="flex items-start gap-2 text-2xs leading-relaxed text-muted-foreground">
      <ShieldCheck aria-hidden className="mt-px h-3.5 w-3.5 shrink-0 text-brand" />
      {t(key, { role: policy?.role ?? "", ...values })}
    </p>
  );

  return (
    <div className="space-y-5 text-sm">
      <p className="text-xs text-muted-foreground">{t("settings.security.intro")}</p>

      <PrefGroup title={t("settings.security.groups.appLock")}>
        <PrefRow
          label={t("settings.security.lock.label")}
          description={on ? t("settings.security.lock.descOn") : t("settings.security.lock.descOff")}
          footer={
            !on ? (
              <p className="flex items-start gap-2 text-2xs leading-relaxed text-muted-foreground">
                <TriangleAlert aria-hidden className="mt-px h-3.5 w-3.5 shrink-0 text-warning" />
                {t("settings.security.lock.forgetting")}
              </p>
            ) : lockPinned ? (
              managedNote(
                policy?.role ? "settings.security.managed.required" : "settings.security.managed.unreadable",
              )
            ) : undefined
          }
        >
          <Switch
            checked={on}
            disabled={!status || lockPinned}
            onCheckedChange={(v) => setDialog(v ? "enable" : "disable")}
            aria-label={t("settings.security.lock.label")}
          />
        </PrefRow>
        {on && (
          <>
            <PrefRow
              label={t("settings.security.password.label")}
              description={t("settings.security.password.desc")}
            >
              <Button size="xs" variant="outline" icon={KeyRound} onClick={() => setDialog("change")}>
                {t("settings.security.password.change")}
              </Button>
            </PrefRow>
            <PrefRow
              label={t("settings.security.lockNow.label")}
              description={
                lockShortcut
                  ? t("settings.security.lockNow.desc", { shortcut: lockShortcut })
                  : t("settings.security.lockNow.descNoShortcut")
              }
            >
              <Button size="xs" variant="outline" icon={Lock} onClick={() => void api.vaultLock()}>
                {t("settings.security.lockNow.action")}
              </Button>
            </PrefRow>
          </>
        )}
      </PrefGroup>

      <PrefGroup title={t("settings.security.groups.autoLock")}>
        <PrefRow
          label={t("settings.security.idleMinutes.label")}
          prefId="lock.idleMinutes"
          description={t("settings.security.idleMinutes.desc")}
          htmlFor="prefs-lock-idle"
          footer={maxIdle ? managedNote("settings.security.managed.maxIdle", { count: maxIdle }) : undefined}
        >
          <NativeSelect
            id="prefs-lock-idle"
            value={String(idleValue)}
            onChange={(e) => updateLock({ idleMinutes: Number(e.target.value) })}
            className="w-40"
          >
            {idleChoices.map((m) => (
              <option key={m} value={m}>
                {m === 0
                  ? t("settings.security.idleMinutes.never")
                  : t("settings.security.idleMinutes.minutes", { count: m })}
              </option>
            ))}
          </NativeSelect>
        </PrefRow>
        <PrefRow
          label={t("settings.security.withSession.label")}
          prefId="lock.withSession"
          description={
            isWindows()
              ? t("settings.security.withSession.descWindows")
              : t("settings.security.withSession.desc")
          }
          footer={
            status && !status.sessionWatch ? (
              <p className="text-2xs text-muted-foreground">
                {t("settings.security.withSession.unavailable")}
              </p>
            ) : sessionPinned !== null ? (
              managedNote("settings.security.managed.withSession")
            ) : undefined
          }
        >
          <Switch
            checked={sessionPinned ?? lock.withSession}
            disabled={(!!status && !status.sessionWatch) || sessionPinned !== null}
            onCheckedChange={(v) => updateLock({ withSession: v })}
            aria-label={t("settings.security.withSession.label")}
          />
        </PrefRow>
      </PrefGroup>

      <MasterPasswordDialog
        mode={dialog}
        minChars={status?.minPasswordChars ?? 12}
        onClose={() => {
          setDialog(null);
          refresh();
        }}
      />
    </div>
  );
}
