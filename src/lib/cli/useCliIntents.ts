/**
 * Everything the app does with a connection intent from the command line.
 *
 * Three entry points, one code path: this window's own startup args
 * (`get_startup_args` in the main window, or the intent stashed for a
 * "New window" by `open_new_window`), and a *second* launch of the app
 * forwarded by the single-instance handler over `huginndb://cli-connect`.
 * All three arrive as the same `StartupArgs`, so `applyConnectionIntent` is the
 * single place that turns one into a live connection.
 *
 * Pulled out of `App.tsx`, where it was ~290 of 820 lines and had nothing to do
 * with the shell it shared a component with. It is a **hook, not a child
 * component**, and that is deliberate: a child's effects mount before its
 * parent's, which would move the CLI effects ahead of the launch-restore
 * sequence whose ordering ADRs #8 and #10 pin down. Called from the
 * same position `App` used to declare this code, the effect order is unchanged.
 *
 * The guards that are load-bearing here:
 *
 * - **Second-launch routing is main-window-only.** Both the shared
 *   `pending_cli_connect` buffer and the broadcast `cli-connect` event target
 *   the running instance's main window, which owns the routing decision. If a
 *   secondary window also ran it, a window spawned to satisfy a "new window"
 *   route would boot, re-drain the still-full buffer and route it *again*,
 *   opening a third window nobody asked for (issue #23).
 * - **The listener reads its handler through a ref.** It subscribes once on
 *   mount, so closing over the first render's `handleIncomingConnection` would
 *   freeze `cliConnectDefault` for the session — the same trap Monaco's
 *   `addCommand` has (gotcha #9).
 * - **The startup effect is not gated on `profiles` being non-empty.** An ad-hoc
 *   launch (`--host …`) has to work on a machine with zero saved profiles; the
 *   old guard silently skipped exactly that case.
 * - **A CLI `--password` never reaches the keychain.** It is passed straight to
 *   `connect`, and the ad-hoc profile it creates is `ephemeral`, so it is never
 *   written to `profiles.json`.
 * - **A CLI connect follows its connection into the right environment,
 *   instead of always landing wherever happens to be active.** `profiles.json`
 *   is global, so `--connect-profile`/`--connect-profile-id` can name a
 *   connection that belongs to any environment; `connectToProfile` asks the
 *   backend which environment(s) reference it (`findEnvironmentsForConnection`)
 *   and switches there first when the active one isn't among them. Same helper
 *   backs an ad-hoc launch that turns out to match an already-saved profile
 *   (see below), so both paths get the same environment-following behaviour.
 * - **An ad-hoc launch (`--host`/`--uri`) reuses an existing saved profile with
 *   the same driver/host/port/database/username (or, for a `--uri` launch,
 *   the same connection string) instead of always minting a new ephemeral
 *   one.** Otherwise every CLI launch against a server the user already has
 *   saved piles up a fresh throwaway profile alongside it. Only non-ephemeral
 *   profiles are candidates — matching against another launch's throwaway
 *   would only ever match within the same still-running session, and never
 *   after a restart.
 *
 * Failures surface as Console entries rather than toasts: a CLI launch is often
 * unattended, and the Console is where the user goes to find out what happened.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { startCliConnectBridge } from "@/lib/bridges/cli-connect-bridge";
import { DEFAULT_PORTS } from "@/lib/constants";
import { driverMismatchHint, effectivePort, normalizeDriver } from "@/lib/db/driver";
import { api } from "@/lib/tauri";
import { isMainWindow, MAIN_WINDOW_LABEL } from "@/lib/window";
import { usePreferences } from "@/stores/preferences/preferences";
import { useConnections } from "@/stores/session/connections";
import { useEnvironments } from "@/stores/session/environments";
import { useLogs } from "@/stores/query/logs";
import { useSchema } from "@/stores/session/schema";
import { useUi } from "@/stores/session/ui";
import type { ConnectionProfile, Driver, StartupArgs } from "@/types";

/** Ad-hoc connection params staged while we prompt the user for a driver
 *  (CLI launch without `--driver` and no configured default). */
interface PendingAdhoc {
  name: string;
  host: string;
  port?: number;
  database: string;
  username: string;
  ssl: boolean;
  password?: string;
  /** MongoDB connection URI from `--uri`/`--connection-string`, if any. */
  connectionString?: string;
  /** MongoDB authSource from `--auth-source`, if any. */
  authSource?: string;
}

/** Best-effort display name for a connection intent — used in the
 *  second-launch routing dialog's prompt copy.
 *
 *  `--connect-profile-id` carries a UUID, which is what the taskbar Jump List
 *  launches with, so the id is resolved to the profile's name through
 *  `profiles`. It only falls back to the raw value when no profile has it
 *  (a stale id), where the id is at least something to search for. */
export function intentDisplayName(
  args: StartupArgs,
  profiles: readonly ConnectionProfile[] = [],
): string {
  if (args.adhoc_name) return args.adhoc_name;
  if (args.connect_profile) {
    if (!args.connect_by_id) return args.connect_profile;
    return (
      profiles.find((p) => p.id === args.connect_profile)?.name ??
      args.connect_profile
    );
  }
  if (args.adhoc_host)
    return `${args.adhoc_host}/${args.adhoc_database ?? ""}`;
  if (args.adhoc_connection_string) return "MongoDB";
  return "connection";
}

export function useCliIntents() {
  const refreshConnections = useConnections((s) => s.refresh);
  const connectProfile = useConnections((s) => s.connect);
  const refreshSchema = useSchema((s) => s.refresh);
  const setSelected = useUi((s) => s.setSelectedConnectionId);
  const cliConnectDefault = usePreferences((s) => s.prefs.ui.cliConnectDefault);
  const updateUiPrefs = usePreferences((s) => s.updateUi);

  const cliArgsHandled = useRef(false);
  /** Set when a CLI ad-hoc launch has no `--driver` and no configured default
   *  — opens the driver picker; the params resume once the user chooses. */
  const [driverPrompt, setDriverPrompt] = useState<PendingAdhoc | null>(null);
  /** Set when a second launch forwards a connection; opens the routing dialog
   *  (this window vs. a new one). */
  const [cliChoice, setCliChoice] = useState<StartupArgs | null>(null);
  const [cliDontAskAgain, setCliDontAskAgain] = useState(false);

  /** Emit a visible Console entry for CLI diagnostics. */
  const cliLog = useCallback((message: string, error?: string) => {
    useLogs.getState().push({
      id: -Date.now(),
      timestamp_ms: Date.now(),
      kind: "connection",
      message: `[cli] ${message}`,
      error,
    });
  }, []);

  /** Connect an already-resolved profile — a saved one named via
   *  `--connect-profile[-id]`, or one an ad-hoc launch matched by parameters
   *  (see `findMatchingProfile`). Follows the connection into whichever
   *  environment(s) actually reference it when the active one doesn't,
   *  before connecting, so a CLI launch never silently lands in the wrong
   *  environment (see the header comment). */
  const connectToProfile = useCallback(
    async (target: ConnectionProfile, password?: string) => {
      try {
        const envIds = await api.findEnvironmentsForConnection(target.id);
        const { activeId, environments, switchTo } = useEnvironments.getState();
        if (envIds.length > 0 && !envIds.includes(activeId ?? "")) {
          const destination = environments
            .filter((e) => envIds.includes(e.id))
            .sort((a, b) => a.order - b.order)[0];
          if (destination) await switchTo(destination.id);
        }
        // `switchTo`'s reconnect may have already brought this connection up
        // (it can be live in the destination environment's own launch state);
        // only connect it ourselves if it isn't already.
        if (!useConnections.getState().active.has(target.id)) {
          await connectProfile(target.id, password);
        }
        await refreshSchema(target.id);
        setSelected(target.id);
      } catch (e) {
        const err = String(e);
        const hint = driverMismatchHint(err);
        cliLog(
          `failed to connect profile "${target.name}"${hint ? ` — ${hint}` : ""}`,
          err,
        );
      }
    },
    [cliLog, connectProfile, refreshSchema, setSelected],
  );

  /** Match an ad-hoc launch's parameters against an already-saved,
   *  non-ephemeral profile, so a repeat CLI launch against a known server
   *  reuses it instead of minting a fresh throwaway profile every time. A
   *  `--uri`/`--connection-string` launch matches on the connection string
   *  (the primary MongoDB identity); a discrete-fields launch matches on
   *  driver/host/port/database/username. */
  const findMatchingProfile = useCallback(
    (p: PendingAdhoc, driver: Driver): ConnectionProfile | undefined => {
      const candidates = useConnections
        .getState()
        .profiles.filter((c) => !c.ephemeral && c.driver === driver);
      if (p.connectionString) {
        const wanted = p.connectionString.trim();
        return candidates.find(
          (c) => (c.connection_string ?? "").trim() === wanted,
        );
      }
      const port = p.port ?? DEFAULT_PORTS[driver];
      return candidates.find(
        (c) =>
          c.host === p.host &&
          // Compared as resolved ports: a saved profile that left the field
          // blank is the same server as a `--port 5432` launch, and minting a
          // second throwaway profile for it is exactly what this match exists
          // to avoid.
          effectivePort(c.driver, c.port) === port &&
          c.database === p.database &&
          c.username === p.username,
      );
    },
    [],
  );

  /** Create the ad-hoc profile with a now-known driver, then connect when a
   *  password was supplied. Shared by the CLI path and the driver picker. */
  const createAndConnectAdhoc = useCallback(
    async (p: PendingAdhoc, driver: Driver) => {
      await refreshConnections();
      const existing = findMatchingProfile(p, driver);
      if (existing) {
        await connectToProfile(existing, p.password);
        return;
      }

      const profile: ConnectionProfile = {
        id: "",
        name: p.name,
        driver,
        host: p.host,
        port: p.port ?? DEFAULT_PORTS[driver],
        database: p.database,
        username: p.username,
        ssl: p.ssl,
        // Only meaningful for MongoDB; the backend ignores it for SQL drivers.
        connection_string: p.connectionString ?? null,
        auth_source: p.authSource ?? null,
        // Connections opened from the CLI are temporary by design: the backend
        // keeps them in memory for the session but never writes them to
        // profiles.json (see ConnectionProfile.ephemeral / store::save_profiles).
        ephemeral: true,
      };
      try {
        const saved = await useConnections.getState().save(profile);
        await refreshConnections();
        setSelected(saved.id);
        // Always attempt the connect, even without `--password`: SQLite has
        // no password concept at all, and some servers allow passwordless /
        // trust auth. A real auth failure still surfaces via the catch below
        // — same as the saved-profile path just above, which never gated on
        // whether a CLI password was supplied.
        await connectProfile(saved.id, p.password);
        await refreshSchema(saved.id);
      } catch (e) {
        const err = String(e);
        const hint = driverMismatchHint(err);
        cliLog(
          `failed to set up ad-hoc connection${hint ? ` — ${hint}` : ""}`,
          err,
        );
      }
    },
    [
      cliLog,
      connectProfile,
      connectToProfile,
      findMatchingProfile,
      refreshConnections,
      refreshSchema,
      setSelected,
    ],
  );

  // Apply one parsed connection intent: connect a saved profile, or stage an
  // ad-hoc connection (prompting for a driver when one can't be resolved).
  // Shared by the cold-start path and the second-launch routing dialog, which
  // both feed the exact same `StartupArgs`. Resolving *which* profile to
  // connect (a saved one, or an ad-hoc match) is this function's job; once
  // resolved, `connectToProfile` decides the destination environment on its
  // own (following the connection where it belongs — see the header comment),
  // so this function itself never needs to switch one. Failures surface in
  // the Console panel instead of being swallowed.
  const applyConnectionIntent = useCallback(
    async (args: StartupArgs) => {
      // A `--password` on the CLI is used in-memory only: passed straight to
      // `connect`, never written to the keychain. `undefined` keeps the
      // normal keychain / password-dialog flow.
      const cliPassword = args.adhoc_password ?? undefined;

      if (args.connect_profile) {
        // Ensure the profile list is loaded before matching; the boot-time
        // refresh may not have resolved yet on a cold start.
        await refreshConnections();
        const loaded = useConnections.getState().profiles;
        const target = args.connect_by_id
          ? loaded.find((p) => p.id === args.connect_profile)
          : loaded.find((p) => p.name === args.connect_profile);
        if (!target) {
          cliLog(
            `no profile matched ${
              args.connect_by_id ? "id" : "name"
            } "${args.connect_profile}"`,
            "profile not found",
          );
          return;
        }
        await connectToProfile(target, cliPassword);
        return;
      }

      // An ad-hoc launch is triggered by either `--host` or a `--uri`
      // connection string (the MongoDB-primary path, which needs no host).
      if (args.adhoc_host || args.adhoc_connection_string) {
        const pending: PendingAdhoc = {
          name:
            args.adhoc_name ??
            (args.adhoc_host
              ? `${args.adhoc_host}/${args.adhoc_database ?? ""}`
              : "MongoDB"),
          host: args.adhoc_host ?? "",
          port: args.adhoc_port ?? undefined,
          database: args.adhoc_database ?? "",
          username: args.adhoc_username ?? "",
          ssl: false,
          password: cliPassword,
          connectionString: args.adhoc_connection_string ?? undefined,
          authSource: args.adhoc_auth_source ?? undefined,
        };
        // Resolve the driver: an explicit `--driver` wins; a connection string
        // implies MongoDB; then the configured default; if none, prompt the
        // user rather than silently guessing Postgres.
        const explicit = normalizeDriver(args.adhoc_driver);
        if (args.adhoc_driver && !explicit) {
          cliLog(
            `unrecognized --driver "${args.adhoc_driver}"; asking which to use`,
          );
        }
        const configured = usePreferences.getState().prefs.ui.defaultDriver;
        const driver =
          explicit ??
          (args.adhoc_connection_string ? "mongodb" : null) ??
          configured ??
          null;
        if (driver) {
          await createAndConnectAdhoc(pending, driver);
        } else {
          setDriverPrompt(pending);
        }
      }
    },
    [cliLog, connectToProfile, createAndConnectAdhoc, refreshConnections],
  );

  /** Open `args` in a brand new, blank window (the new window's boot effect
   *  picks the intent back up via `takeWindowStartupIntent`). */
  const openInNewWindow = useCallback(
    async (args: StartupArgs) => {
      try {
        await api.openNewWindow(args);
      } catch (e) {
        cliLog("failed to open a new window for incoming connection", String(e));
      }
    },
    [cliLog],
  );

  // Route a second-launch connection intent to this window or a new one.
  // Only the main window ever runs this — it's the one the dialog opens in.
  const routeIncomingConnection = useCallback(
    (args: StartupArgs, target: "current" | "new") => {
      if (target === "new") void openInNewWindow(args);
      else void applyConnectionIntent(args);
    },
    [applyConnectionIntent, openInNewWindow],
  );

  /** Decide how to handle a second-launch intent: apply the remembered
   *  choice silently, or ask via the dialog when the preference is "ask". */
  const handleIncomingConnection = useCallback(
    (args: StartupArgs) => {
      if (cliConnectDefault === "ask") {
        setCliDontAskAgain(false);
        setCliChoice(args);
      } else {
        routeIncomingConnection(args, cliConnectDefault);
      }
    },
    [cliConnectDefault, routeIncomingConnection],
  );
  // The second-launch listener effect below subscribes once on mount, so it
  // would otherwise close over the first render's `handleIncomingConnection`
  // (and thus a stale `cliConnectDefault`) for the rest of the session — see
  // gotcha #9 for the same pattern with Monaco's Ctrl+Enter.
  const handleIncomingConnectionRef = useRef(handleIncomingConnection);
  handleIncomingConnectionRef.current = handleIncomingConnection;

  // Handle this window's own startup connection intent exactly once, on
  // mount. The main window reads the process's own CLI args
  // (`get_startup_args`); a secondary window opened via "New window" instead
  // drains the intent stashed for its label by `open_new_window`. Crucially
  // NOT gated on `profiles` being non-empty: ad-hoc launches (`--host …`)
  // must work on a machine with zero saved profiles, and the old guard
  // silently skipped them.
  useEffect(() => {
    if (cliArgsHandled.current) return;
    cliArgsHandled.current = true;
    void (async () => {
      let args: StartupArgs | null;
      try {
        const label = getCurrentWindow().label;
        args =
          label === MAIN_WINDOW_LABEL
            ? await api.getStartupArgs()
            : await api.takeWindowStartupIntent(label);
      } catch (e) {
        console.error("[cli] failed to read startup args", e);
        return;
      }
      if (args) await applyConnectionIntent(args);
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Listen for *second* launches forwarded by the single-instance handler.
  // The main window was already focused in Rust; we route the connection
  // there or to a new window (asking first, unless the user opted out).
  // Drain any intent buffered before this listener existed (a launch that
  // raced our boot) first, then subscribe to the live event.
  //
  // MAIN-WINDOW-ONLY. Both the shared `pending_cli_connect` buffer and the
  // broadcast `cli-connect` event are meant for the running instance's main
  // window, which owns the routing decision. A secondary window handles only
  // its own startup intent (via `window_startup_intents`, in the effect
  // above). If secondary windows also ran this, the intent would be processed
  // twice: a window spawned to satisfy a "new window" route would boot,
  // re-drain the still-full buffer, and route it AGAIN — opening a third
  // window nobody asked for (issue #23). Same guard rationale as ADR #8
  // (only the main window touches shared session state).
  useEffect(() => {
    if (!isMainWindow()) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const buffered = await api.takePendingCliConnect();
        if (!cancelled && buffered) handleIncomingConnectionRef.current(buffered);
      } catch (e) {
        console.error("[cli] failed to drain pending connect", e);
      }
      const fn = await startCliConnectBridge((args) =>
        handleIncomingConnectionRef.current(args),
      );
      if (cancelled) fn();
      else unlisten = fn;
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    /** Ad-hoc params waiting on a driver choice, or `null`. */
    driverPrompt,
    setDriverPrompt,
    /** Second-launch intent waiting on a this-window-or-new choice. */
    cliChoice,
    setCliChoice,
    cliDontAskAgain,
    setCliDontAskAgain,
    createAndConnectAdhoc,
    routeIncomingConnection,
    updateUiPrefs,
  };
}
