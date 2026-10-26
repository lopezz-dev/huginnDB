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
import { KeyRound, Lock, TriangleAlert } from "lucide-react";

import { LOCK_CHANGED_EVENT } from "@/components/lock/LockGate";
import {
  MasterPasswordDialog,
  type MasterPasswordMode,
} from "@/components/lock/dialogs/MasterPasswordDialog";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { useShortcutLabel } from "@/lib/keybindings/useShortcutLabel";
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

  return (
    <div className="space-y-5 text-sm">
      <p className="text-xs text-muted-foreground">{t("settings.security.intro")}</p>

      <PrefGroup title={t("settings.security.groups.appLock")}>
        <PrefRow
          label={t("settings.security.lock.label")}
          description={on ? t("settings.security.lock.descOn") : t("settings.security.lock.descOff")}
          footer={
            !on && (
              <p className="flex items-start gap-2 text-2xs leading-relaxed text-muted-foreground">
                <TriangleAlert aria-hidden className="mt-px h-3.5 w-3.5 shrink-0 text-warning" />
                {t("settings.security.lock.forgetting")}
              </p>
            )
          }
        >
          <Switch
            checked={on}
            disabled={!status}
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
        >
          <NativeSelect
            id="prefs-lock-idle"
            value={String(lock.idleMinutes)}
            onChange={(e) => updateLock({ idleMinutes: Number(e.target.value) })}
            className="w-40"
          >
            {IDLE_CHOICES.map((m) => (
              <option key={m} value={m}>
                {m === 0
                  ? t("settings.security.idleMinutes.never")
                  : t("settings.security.idleMinutes.minutes", { count: m })}
              </option>
            ))}
          </NativeSelect>
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
