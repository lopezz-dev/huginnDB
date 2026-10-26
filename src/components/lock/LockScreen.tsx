/**
 * The wall: what a locked HuginnDB shows, full screen, in every window kind.
 *
 * It is the face of the lock, not the lock. Nothing behind it is mounted —
 * `LockGate` renders this *instead of* the app — and the backend refuses
 * every command but the three this screen calls (`app_lock::OPEN_WHILE_LOCKED`),
 * so a page that skipped it would still find nothing to read (ADR #118).
 *
 * Two views: the password, and the honest way out of a forgotten one — a
 * reset that loses the secrets and keeps the connections. A broken vault
 * (missing or unreadable `vault.json`) only offers the second.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { LockKeyhole, TriangleAlert } from "lucide-react";

import { ConfirmHost } from "@/components/common/ConfirmHost";
import { PasswordInput } from "@/components/common/PasswordInput";
import { TitleBar, WindowCaption } from "@/components/shell/TitleBar";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { confirmIrreversible } from "@/lib/confirmDestructive";
import { secondsLeft } from "@/lib/lock/status";
import { api } from "@/lib/tauri";
import type { LockStatus } from "@/types";
import { MasterPasswordFields } from "./MasterPasswordFields";

/** Re-render while a wait is owed, and say how much of it is left. */
function useCountdown(deadline: number): number {
  // The state only schedules re-renders; the time is read fresh each render,
  // so a new deadline is counted from now rather than from the last tick.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (deadline <= Date.now()) return;
    const timer = window.setInterval(() => setTick((n) => n + 1), 250);
    return () => window.clearInterval(timer);
  }, [deadline]);
  return secondsLeft(deadline - Date.now());
}

function UnlockForm({ status, onOpened }: { status: LockStatus; onOpened: () => void }) {
  const { t } = useTranslation();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [failures, setFailures] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [deadline, setDeadline] = useState(() => Date.now() + status.retryAfterMs);
  const wait = useCountdown(deadline);

  const submit = async () => {
    if (!password || busy || wait > 0) return;
    setBusy(true);
    setError(null);
    try {
      const answer = await api.vaultUnlock(password);
      if (answer.opened) {
        setPassword("");
        onOpened();
        return;
      }
      if (answer.failures > 0) setFailures(answer.failures);
      setDeadline(Date.now() + answer.retryAfterMs);
      setPassword("");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <PasswordInput
        autoFocus
        aria-label={t("lock.wall.password")}
        placeholder={t("lock.wall.password")}
        autoComplete="current-password"
        value={password}
        disabled={busy}
        onChange={(e) => setPassword(e.target.value)}
      />
      <Button type="submit" className="w-full" loading={busy} disabled={!password || wait > 0}>
        {wait > 0 ? t("lock.wall.wait", { count: wait }) : t("lock.wall.unlock")}
      </Button>
      <p role="status" className="min-h-4 text-center text-2xs text-muted-foreground">
        {error ??
          (failures > 0
            ? t("lock.wall.wrong", { count: failures })
            : "")}
      </p>
    </form>
  );
}

function ResetForm({
  status,
  onDone,
  onBack,
}: {
  status: LockStatus;
  onDone: () => void;
  onBack?: () => void;
}) {
  const { t } = useTranslation();
  const [password, setPassword] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!password) return;
    if (!(await confirmIrreversible(t("lock.reset.confirm")))) return;
    setBusy(true);
    setError(null);
    try {
      await api.vaultReset(password);
      onDone();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-xs leading-relaxed text-muted-foreground">{t("lock.reset.explain")}</p>
      <MasterPasswordFields minChars={status.minPasswordChars} onChange={setPassword} autoFocus />
      {error && <p className="text-2xs text-destructive">{error}</p>}
      <Button
        variant="destructive"
        className="w-full"
        loading={busy}
        disabled={!password}
        onClick={() => void submit()}
      >
        {t("lock.reset.action")}
      </Button>
      {onBack && (
        <Button variant="ghost" size="xs" className="w-full" onClick={onBack}>
          {t("lock.reset.back")}
        </Button>
      )}
    </div>
  );
}

export function LockScreen({
  status,
  onChanged,
}: {
  status: LockStatus;
  /** Ask the backend again: the vault opened, or was reset. */
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const broken = status.mode === "broken";
  const [resetting, setResetting] = useState(false);

  return (
    <TooltipProvider>
      <div className="flex h-screen flex-col bg-background text-foreground">
        <TitleBar>
          <WindowCaption />
        </TitleBar>
        <main className="flex flex-1 items-center justify-center overflow-auto p-6">
          <div className="w-full max-w-xs space-y-5">
            <div className="space-y-2 text-center">
              <LockKeyhole aria-hidden className="mx-auto h-8 w-8 text-muted-foreground" />
              <h1 className="text-base font-semibold">{t("lock.wall.title")}</h1>
              <p className="text-xs text-muted-foreground">
                {broken
                  ? t("lock.wall.brokenSubtitle")
                  : resetting
                    ? t("lock.reset.title")
                    : t("lock.wall.subtitle")}
              </p>
            </div>
            {broken && status.problem && (
              <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs">
                <TriangleAlert aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
                <span className="min-w-0 break-words">{status.problem}</span>
              </div>
            )}
            {broken || resetting ? (
              <ResetForm
                status={status}
                onDone={onChanged}
                onBack={broken ? undefined : () => setResetting(false)}
              />
            ) : (
              <>
                <UnlockForm status={status} onOpened={onChanged} />
                <Button
                  variant="link"
                  size="xs"
                  className="w-full text-muted-foreground"
                  onClick={() => setResetting(true)}
                >
                  {t("lock.wall.forgot")}
                </Button>
              </>
            )}
          </div>
        </main>
        <ConfirmHost />
      </div>
    </TooltipProvider>
  );
}
