/**
 * Settings → Security: who may open HuginnDB on this machine (ADR #118).
 *
 * The app lock lives here, and so will the next two phases of it — Windows
 * Hello as a second way to unlock, and locking with the Windows session — so
 * the section is named for the question ("is this app safe if I walk away?")
 * rather than for one switch. It is Settings' own section; the tab that lists
 * a database server's users and privileges is a different thing.
 *
 * Whether the lock is on is read from the backend (`vault_status`), never
 * from preferences: it is the existence of the vault. Only the idle timeout
 * is a preference.
 */

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { Check, KeyRound, Lock, ShieldOff, TriangleAlert, X } from "lucide-react";

import { LOCK_CHANGED_EVENT } from "@/components/lock/LockGate";
import { Padlock } from "@/components/lock/Padlock";
import {
  MasterPasswordDialog,
  type MasterPasswordMode,
} from "@/components/lock/dialogs/MasterPasswordDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { notify } from "@/lib/notify";
import { api } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { selectLockPrefs, usePreferences } from "@/stores/preferences/preferences";
import type { LockStatus } from "@/types";
import { PrefGroup } from "./PrefGroup";
import { PrefRow } from "./PrefRow";

const IDLE_CHOICES = [0, 5, 10, 15, 30, 60];

/** One column of "what it covers": a heading and its items, each marked. */
function Coverage({ tone, items }: { tone: "yes" | "no"; items: string[] }) {
  const { t } = useTranslation();
  const Icon = tone === "yes" ? Check : X;
  return (
    <div
      className={cn(
        "rounded-lg border p-3",
        tone === "yes" ? "border-success/25 bg-success/5" : "border-border bg-muted/20",
      )}
    >
      <p
        className={cn(
          "mb-2 text-2xs font-semibold uppercase tracking-wider",
          tone === "yes" ? "text-success" : "text-muted-foreground",
        )}
      >
        {t(`settings.security.covers.${tone}.title`)}
      </p>
      <ul className="space-y-1.5">
        {items.map((item) => (
          <li key={item} className="flex items-start gap-2 text-xs leading-snug">
            <Icon
              aria-hidden
              className={cn(
                "mt-0.5 h-3.5 w-3.5 shrink-0",
                tone === "yes" ? "text-success" : "text-muted-foreground",
              )}
            />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SecuritySection() {
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
  const list = (key: string) => t(key, { returnObjects: true }) as string[];

  return (
    <div className="space-y-6 text-sm">
      {/* The lock itself: its state, what it means, what can be done. */}
      <section
        className={cn(
          "relative overflow-hidden rounded-xl border p-5",
          on ? "border-brand/30 bg-brand/[0.04]" : "border-border bg-muted/10",
        )}
      >
        <span
          aria-hidden
          className="halftone-spot pointer-events-none absolute -left-10 -top-10 h-56 w-56 opacity-60"
        />
        <div className="relative flex items-center gap-5">
          <Padlock
            phase={on ? "locked" : "open"}
            className="h-24 w-auto shrink-0 drop-shadow-[0_8px_20px_color-mix(in_srgb,var(--brand)_30%,transparent)]"
          />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                {t("settings.security.lock.eyebrow")}
              </span>
              {status && (
                <Badge tone={on ? "success" : "neutral"}>
                  {on ? t("settings.security.lock.on") : t("settings.security.lock.off")}
                </Badge>
              )}
            </div>
            <p className="text-base font-semibold leading-snug">
              {on ? t("settings.security.lock.titleOn") : t("settings.security.lock.titleOff")}
            </p>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {on ? t("settings.security.lock.descOn") : t("settings.security.lock.descOff")}
            </p>
            <div className="flex flex-wrap gap-2 pt-1">
              {on ? (
                <>
                  <Button size="sm" icon={Lock} onClick={() => void api.vaultLock()}>
                    {t("settings.security.lock.lockNow")}
                  </Button>
                  <Button size="sm" variant="outline" icon={KeyRound} onClick={() => setDialog("change")}>
                    {t("settings.security.lock.change")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={ShieldOff}
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => setDialog("disable")}
                  >
                    {t("settings.security.lock.turnOff")}
                  </Button>
                </>
              ) : (
                <Button size="sm" icon={Lock} disabled={!status} onClick={() => setDialog("enable")}>
                  {t("settings.security.lock.turnOn")}
                </Button>
              )}
            </div>
          </div>
        </div>
        {!on && (
          <p className="relative mt-4 flex items-start gap-2 border-t border-border/60 pt-3 text-2xs leading-relaxed text-muted-foreground">
            <TriangleAlert aria-hidden className="mt-px h-3.5 w-3.5 shrink-0 text-warning" />
            {t("settings.security.lock.forgetting")}
          </p>
        )}
      </section>

      <PrefGroup title={t("settings.security.autoLock")}>
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

      <PrefGroup
        title={t("settings.security.covers.title")}
        // The two columns are cards of their own; a frame around them would be
        // a box inside a box.
        bodyClassName="overflow-visible rounded-none border-0 bg-transparent"
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Coverage tone="yes" items={list("settings.security.covers.yes.items")} />
          <Coverage tone="no" items={list("settings.security.covers.no.items")} />
        </div>
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
