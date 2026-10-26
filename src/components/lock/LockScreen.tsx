/**
 * The wall: what a locked HuginnDB shows, in every window kind.
 *
 * It is the face of the lock, not the lock. Nothing behind it is mounted —
 * `LockGate` renders this *instead of* the app — and the backend refuses
 * every command but the three this screen calls (`app_lock::OPEN_WHILE_LOCKED`),
 * so a page that skipped it would still find nothing to read (ADR #118).
 *
 * One of the few screens allowed to be brand, like the splash: the same
 * halftone wash and blue bloom, and the padlock as its single animated object.
 * The padlock's phase *is* the state of the attempt — it closes when the wall
 * appears, its LEDs chase while Argon2 runs, it shakes on a wrong password,
 * drains a ring through the wait the backend imposes, and swings open before
 * the stage lifts away to reveal the app.
 *
 * Two views: the password, and the honest way out of a forgotten one — a
 * reset that loses the secrets and keeps the connections. A broken vault
 * (missing or unreadable `vault.json`) only offers the second.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight, TriangleAlert } from "lucide-react";

import { ConfirmHost } from "@/components/common/ConfirmHost";
import { TitleBar, WindowCaption } from "@/components/shell/TitleBar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TooltipProvider } from "@/components/ui/tooltip";
import { confirmIrreversible } from "@/lib/confirmDestructive";
import { secondsLeft } from "@/lib/lock/status";
import { api } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import type { LockStatus } from "@/types";
import { MasterPasswordFields } from "./MasterPasswordFields";
import { Padlock, type PadlockPhase } from "./Padlock";
import "./lock.css";

/** How long the padlock's closing clunk plays before it rests. */
const CLOSE_MS = 650;
/** The shake after a wrong password. */
const WRONG_MS = 460;
/** The padlock swinging open, then the stage lifting away. */
const OPEN_MS = 560;
const EXIT_MS = 320;

function reducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

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

function UnlockForm({
  status,
  onPhase,
  onOpened,
}: {
  status: LockStatus;
  onPhase: (phase: PadlockPhase, waitMs?: number) => void;
  onOpened: () => void;
}) {
  const { t } = useTranslation();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [failures, setFailures] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [capsLock, setCapsLock] = useState(false);
  const [deadline, setDeadline] = useState(() => Date.now() + status.retryAfterMs);
  const wait = useCountdown(deadline);
  const input = useRef<HTMLInputElement>(null);

  // The padlock waits with the form, and comes back to rest when it is over.
  useEffect(() => {
    if (wait > 0) return;
    onPhase("locked");
    input.current?.focus();
  }, [wait, onPhase]);

  const submit = async () => {
    if (!password || busy || wait > 0) return;
    setBusy(true);
    setError(null);
    onPhase("checking");
    try {
      const answer = await api.vaultUnlock(password);
      if (answer.opened) {
        setPassword("");
        onOpened();
        return;
      }
      setPassword("");
      if (answer.failures > 0) setFailures(answer.failures);
      onPhase("wrong");
      window.setTimeout(() => {
        if (answer.retryAfterMs > 0) {
          setDeadline(Date.now() + answer.retryAfterMs);
          onPhase("waiting", answer.retryAfterMs);
        } else {
          onPhase("locked");
          input.current?.focus();
        }
      }, WRONG_MS);
    } catch (e) {
      setError(String(e));
      onPhase("locked");
    } finally {
      setBusy(false);
    }
  };

  const message =
    error ??
    (wait > 0
      ? t("lock.wall.wait", { count: wait })
      : failures > 0
        ? t("lock.wall.wrong", { count: failures })
        : capsLock
          ? t("lock.wall.capsLock")
          : "");

  return (
    <form
      className="w-full"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="flex items-center gap-2">
        <Input
          ref={input}
          type="password"
          autoFocus
          aria-label={t("lock.wall.password")}
          placeholder={t("lock.wall.password")}
          autoComplete="current-password"
          value={password}
          disabled={busy || wait > 0}
          onChange={(e) => setPassword(e.target.value)}
          onKeyUp={(e) => setCapsLock(e.getModifierState("CapsLock"))}
          onKeyDown={(e) => setCapsLock(e.getModifierState("CapsLock"))}
          className={cn(
            "h-9 flex-1 bg-background/80 backdrop-blur-md",
            wait > 0 && "border-warning/50",
          )}
        />
        <Button
          type="submit"
          size="icon"
          icon={ArrowRight}
          aria-label={t("lock.wall.unlock")}
          loading={busy}
          disabled={!password || wait > 0}
          className="h-9 w-9 shrink-0"
        />
      </div>
      <p
        role="status"
        className={cn(
          "mt-2.5 min-h-4 text-center text-2xs",
          wait > 0
            ? "text-warning"
            : error || failures > 0
              ? "text-destructive"
              : "text-muted-foreground",
        )}
      >
        {message}
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
    <div className="w-full space-y-4 rounded-xl border border-border/80 bg-background/75 p-4 backdrop-blur-md">
      <p className="text-xs leading-relaxed text-muted-foreground">{t("lock.reset.explain")}</p>
      <MasterPasswordFields minChars={status.minPasswordChars} onChange={setPassword} autoFocus />
      {error && <p className="text-2xs text-destructive">{error}</p>}
      <div className="flex items-center justify-between gap-2">
        {onBack ? (
          <Button variant="ghost" size="xs" onClick={onBack}>
            {t("lock.reset.back")}
          </Button>
        ) : (
          <span />
        )}
        <Button
          variant="destructive"
          size="sm"
          loading={busy}
          disabled={!password}
          onClick={() => void submit()}
        >
          {t("lock.reset.action")}
        </Button>
      </div>
    </div>
  );
}

/**
 * The wall an organization puts up when its policy requires the lock and this
 * machine has none yet (ADR #120): a master password is set here, before
 * anything else in the app can be reached.
 */
function SetupForm({ status, onDone }: { status: LockStatus; onDone: () => void }) {
  const { t } = useTranslation();
  const [password, setPassword] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!password) return;
    if (!(await confirmIrreversible(t("lock.enable.confirm")))) return;
    setBusy(true);
    setError(null);
    try {
      await api.vaultEnable(password);
      onDone();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <div className="w-full space-y-4 rounded-xl border border-border/80 bg-background/75 p-4 backdrop-blur-md">
      <p className="text-xs leading-relaxed text-muted-foreground">{t("lock.setup.explain")}</p>
      <MasterPasswordFields minChars={status.minPasswordChars} onChange={setPassword} autoFocus />
      {error && <p className="text-2xs text-destructive">{error}</p>}
      <div className="flex justify-end">
        <Button size="sm" loading={busy} disabled={!password} onClick={() => void submit()}>
          {t("lock.setup.action")}
        </Button>
      </div>
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
  const setup = status.mode === "setup";
  const [resetting, setResetting] = useState(false);
  const [phase, setPhase] = useState<PadlockPhase>(
    broken ? "broken" : setup ? "open" : "closing",
  );
  const [waitMs, setWaitMs] = useState(0);
  const [exiting, setExiting] = useState(false);
  const closing = phase === "closing";

  // The wall arrives with the padlock snapping shut, then rests.
  useEffect(() => {
    if (broken || setup) return;
    const timer = window.setTimeout(
      () => setPhase((p) => (p === "closing" ? "locked" : p)),
      reducedMotion() ? 0 : CLOSE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [broken, setup]);

  // Stable: the form's "back to rest" effect depends on it, and a new function
  // each render would fire that effect mid-attempt and drop the padlock out of
  // `checking`.
  const onPhase = useCallback((next: PadlockPhase, wait = 0) => {
    // Never cut the closing clunk short with the form's own "rest" state.
    setPhase((p) => (p === "closing" && next === "locked" ? p : next));
    setWaitMs(wait);
  }, []);

  /** Swing the padlock open and lift the stage away, then hand over. */
  const reveal = () => {
    if (reducedMotion()) {
      onChanged();
      return;
    }
    setPhase("opening");
    window.setTimeout(() => setExiting(true), OPEN_MS);
    window.setTimeout(onChanged, OPEN_MS + EXIT_MS);
  };

  /** The master password is set: the padlock snaps shut — the lock is on —
   *  and the stage lifts away. */
  const lockedIn = () => {
    if (reducedMotion()) {
      onChanged();
      return;
    }
    setPhase("closing");
    window.setTimeout(() => setExiting(true), CLOSE_MS);
    window.setTimeout(onChanged, CLOSE_MS + EXIT_MS);
  };

  const subtitle = setup
    ? status.policy.role
      ? t("lock.setup.subtitleRole", { role: status.policy.role })
      : t("lock.setup.subtitle")
    : broken
    ? t("lock.wall.brokenSubtitle")
    : resetting
      ? t("lock.reset.title")
      : t("lock.wall.subtitle");

  return (
    <TooltipProvider>
      <div
        className={cn(
          "lock-screen relative flex h-screen flex-col overflow-hidden bg-background text-foreground",
          exiting && "lock-screen-exit",
        )}
      >
        <TitleBar>
          <WindowCaption />
        </TitleBar>
        <main className="relative flex flex-1 items-center justify-center overflow-auto px-6 py-10">
          {/* The splash's atmosphere: a halftone wash and a blue bloom. */}
          <span
            aria-hidden
            className="halftone-centered pointer-events-none absolute inset-0 opacity-70 [--halftone-pitch:14px]"
          />
          <span
            aria-hidden
            className={cn(
              "lock-bloom pointer-events-none absolute left-1/2 top-[40%] h-[26rem] w-[26rem] -translate-x-1/2 -translate-y-1/2 rounded-full blur-[110px]",
              phase === "wrong" || broken
                ? "bg-destructive/15"
                : phase === "opening"
                  ? "bg-success/20"
                  : "bg-brand/20",
            )}
          />

          <div className="lock-stage relative z-10 flex w-full max-w-[22rem] flex-col items-center">
            <Padlock
              phase={phase}
              waitMs={waitMs}
              className="h-44 w-auto drop-shadow-[0_14px_36px_color-mix(in_srgb,var(--brand)_35%,transparent)]"
            />
            <h1 className="lock-reveal mt-7 text-center text-xl font-extrabold tracking-tight [animation-delay:120ms]">
              {setup ? t("lock.setup.title") : t("lock.wall.title")}
            </h1>
            <p className="lock-reveal mt-1.5 text-center text-xs text-muted-foreground [animation-delay:180ms]">
              {subtitle}
            </p>

            {broken && status.problem && (
              <div className="lock-reveal mt-5 flex w-full items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs [animation-delay:220ms]">
                <TriangleAlert aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
                <span className="min-w-0 break-words font-mono text-2xs">{status.problem}</span>
              </div>
            )}

            <div className="lock-reveal mt-6 w-full [animation-delay:240ms]" key={resetting ? "reset" : "unlock"}>
              {setup ? (
                <SetupForm status={status} onDone={lockedIn} />
              ) : broken || resetting ? (
                <ResetForm
                  status={status}
                  onDone={reveal}
                  onBack={broken ? undefined : () => setResetting(false)}
                />
              ) : (
                <UnlockForm status={status} onPhase={onPhase} onOpened={reveal} />
              )}
            </div>

            {!broken && !setup && !resetting && (
              <Button
                variant="link"
                size="xs"
                disabled={closing}
                className="lock-reveal mt-1 text-muted-foreground [animation-delay:300ms]"
                onClick={() => setResetting(true)}
              >
                {t("lock.wall.forgot")}
              </Button>
            )}
          </div>
        </main>
        <footer className="relative z-10 flex items-center justify-center gap-1.5 pb-4 text-3xs uppercase tracking-[0.18em] text-muted-foreground/70">
          <img src="/image/huginn-mark-128.png" alt="" aria-hidden draggable={false} className="h-3.5 w-3.5 opacity-80" />
          {t("lock.wall.footer")}
        </footer>
        <ConfirmHost />
      </div>
    </TooltipProvider>
  );
}
