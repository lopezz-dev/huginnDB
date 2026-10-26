/**
 * Settings → App lock: the vault and the master password (ADR #118).
 *
 * Not "Security": that name already belongs to the panel that lists a
 * server's users and privileges. This one is about who may open HuginnDB on
 * this machine.
 *
 * Whether the lock is on is read from the backend (`vault_status`), never
 * from preferences: it is the existence of the vault. Only the idle timeout
 * is a preference.
 */

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { KeyRound, Lock, LockOpen, ShieldOff } from "lucide-react";

import { LOCK_CHANGED_EVENT } from "@/components/lock/LockGate";
import {
  MasterPasswordDialog,
  type MasterPasswordMode,
} from "@/components/lock/dialogs/MasterPasswordDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { notify } from "@/lib/notify";
import { api } from "@/lib/tauri";
import { selectLockPrefs, usePreferences } from "@/stores/preferences/preferences";
import type { LockStatus } from "@/types";
import { PrefGroup } from "./PrefGroup";
import { PrefRow } from "./PrefRow";

const IDLE_CHOICES = [0, 5, 10, 15, 30, 60];

export function AppLockSection() {
  const { t } = useTranslation();
  const lock = usePreferences(selectLockPrefs);
  const updateLock = usePreferences((s) => s.updateLock);
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
      <p className="text-xs text-muted-foreground">{t("settings.appLock.intro")}</p>

      <PrefGroup
        title={t("settings.appLock.status.title")}
        action={
          status && (
            <Badge tone={on ? "success" : "neutral"}>
              {on ? t("settings.appLock.status.on") : t("settings.appLock.status.off")}
            </Badge>
          )
        }
      >
        {on ? (
          <div className="flex flex-wrap gap-2 px-0.5">
            <Button size="sm" icon={Lock} onClick={() => void api.vaultLock()}>
              {t("settings.appLock.lockNow")}
            </Button>
            <Button size="sm" variant="outline" icon={KeyRound} onClick={() => setDialog("change")}>
              {t("settings.appLock.change")}
            </Button>
            <Button size="sm" variant="outline" icon={ShieldOff} onClick={() => setDialog("disable")}>
              {t("settings.appLock.turnOff")}
            </Button>
          </div>
        ) : (
          <div className="space-y-2 px-0.5">
            <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">
              <li>{t("settings.appLock.protects")}</li>
              <li>{t("settings.appLock.doesNot")}</li>
              <li>{t("settings.appLock.forgetting")}</li>
            </ul>
            <Button size="sm" icon={LockOpen} disabled={!status} onClick={() => setDialog("enable")}>
              {t("settings.appLock.turnOn")}
            </Button>
          </div>
        )}
      </PrefGroup>

      <PrefGroup title={t("settings.rowGroups.behaviour")}>
        <PrefRow
          label={t("settings.appLock.idleMinutes.label")}
          prefId="lock.idleMinutes"
          description={t("settings.appLock.idleMinutes.desc")}
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
                {m === 0 ? t("settings.appLock.idleMinutes.never") : t("settings.appLock.idleMinutes.minutes", { count: m })}
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
