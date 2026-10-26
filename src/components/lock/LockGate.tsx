/**
 * Decides what a window may render before anything else in it mounts.
 *
 * Wraps every window kind in `main.tsx` — the main app, a second window, a
 * floating tab, Pulse — so none of them reaches a store, a bridge or a
 * command before the lock has answered. Until it has, the window is an empty
 * background: showing the app for one frame and then the wall would be the
 * flash of everything the wall exists to hide.
 *
 * Locking is a reload. The backend closes every other window and the pools
 * with them; the main window reloads into this gate, which drops every byte
 * of JavaScript state at once — tabs, the schema tree, the AI panel's
 * conversation — rather than trusting a list of stores to reset.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";

import { setLanguage, SUPPORTED_LANGUAGES } from "@/lib/i18n";
import { createActivityReporter } from "@/lib/lock/status";
import { api } from "@/lib/tauri";
import type { AppLanguage, LockStatus } from "@/types";
import { LockScreen } from "./LockScreen";

/** `app_lock::CHANGED_EVENT`. */
export const LOCK_CHANGED_EVENT = "huginndb://lock-changed";

const ACTIVITY_EVENTS = ["keydown", "pointerdown", "pointermove", "wheel"] as const;

function behindTheWall(status: LockStatus | null): boolean {
  return status?.mode === "locked" || status?.mode === "broken";
}

export function LockGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<LockStatus | null>(null);
  const showing = useRef<LockStatus | null>(null);

  const apply = useCallback((next: LockStatus) => {
    // Locked while the app was mounted: start again from nothing.
    if (behindTheWall(next) && showing.current && !behindTheWall(showing.current)) {
      window.location.reload();
      return;
    }
    if (SUPPORTED_LANGUAGES.includes(next.language as AppLanguage)) {
      setLanguage(next.language as AppLanguage);
    }
    showing.current = next;
    setStatus(next);
  }, []);

  const refresh = useCallback(() => {
    void api.vaultStatus().then(apply, (e) =>
      apply({
        mode: "broken",
        problem: String(e),
        retryAfterMs: 0,
        idleMinutes: 0,
        language: "en",
        minPasswordChars: 12,
      }),
    );
  }, [apply]);

  useEffect(refresh, [refresh]);

  useEffect(() => {
    const unlisten = listen<LockStatus>(LOCK_CHANGED_EVENT, (e) => apply(e.payload));
    return () => void unlisten.then((fn) => fn());
  }, [apply]);

  // Activity in any window keeps the idle timeout away; the backend decides.
  const unlocked = status?.mode === "unlocked";
  useEffect(() => {
    if (!unlocked) return;
    const report = createActivityReporter(() => void api.vaultActivity().catch(() => {}));
    for (const type of ACTIVITY_EVENTS) window.addEventListener(type, report, { passive: true });
    return () => {
      for (const type of ACTIVITY_EVENTS) window.removeEventListener(type, report);
    };
  }, [unlocked]);

  if (!status) return <div className="h-screen bg-background" />;
  if (behindTheWall(status)) return <LockScreen status={status} onChanged={refresh} />;
  return <>{children}</>;
}
