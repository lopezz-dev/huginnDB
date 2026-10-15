/**
 * Root rendered instead of `<App />` in a Pulse window (see `main.tsx`) — a
 * bare native window measuring exactly one connection, with a rail of views
 * down the left.
 *
 * Deliberately not a detached *tab* window: Pulse is context, not a document,
 * so it has no `TabKind`, nothing in `useTabs`, and nothing in the persisted
 * tab state. What it needs carried across is one connection id, which
 * `open_pulse_window` stashes and this drains on boot — the pool it measures
 * is already open in the shared backend `AppState`, so nothing reconnects here.
 *
 * Ephemeral by design, the same secondary-window pattern ADR #8 describes:
 * nothing here writes shared state, and closing the window is the whole story.
 * The dock panel keeps working while this is open, and the two share one clock
 * because the live series lives in a store rather than in either component.
 */

import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTranslation } from "react-i18next";
import {
  Activity,
  AlertTriangle,
  ChevronRight,
  HardDrive,
  History,
  Link2,
  ListOrdered,
  ListTree,
  RefreshCw,
  ServerCog,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { IconButton } from "@/components/ui/icon-button";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ConnectionErrorBoundary } from "@/components/connection/ConnectionErrorBoundary";
import { SandboxRibbon } from "@/components/shell/SandboxRibbon";
import { WindowColorBadge } from "@/components/shell/WindowColorBadge";
import { TitleBar, WindowCaption } from "@/components/shell/TitleBar";
import { NotificationHosts } from "@/components/shell/NotificationHosts";
import { ConfirmHost } from "@/components/common/ConfirmHost";
import { useBridge } from "@/lib/bridges/useBridge";
import { PolicyLockedState } from "@/components/common/PolicyLock";
import { usePolicyLock } from "@/lib/policy/access";
import { startPolicyBridge } from "@/lib/bridges/policy-bridge";
import { startWindowListBridge } from "@/lib/bridges/window-list-bridge";
import { EmptyState } from "@/components/common/EmptyState";
import { AlertList } from "@/components/pulse/sections/AlertList";
import { Sparkline } from "@/components/pulse/charts/Sparkline";
import { StatusTiles } from "@/components/pulse/sections/StatusTiles";
import { StorageLegend } from "@/components/pulse/sections/StorageLegend";
import { slowestHint } from "@/lib/pulse/hints";
import { usePulseLive } from "@/lib/pulse/usePulseLive";
import { usePulseDetail } from "@/lib/pulse/usePulseDetail";
import {
  isUnsupported,
  usePulseView,
  type PulseView,
} from "@/lib/pulse/usePulseView";
import { setLanguage } from "@/lib/i18n";
import { api } from "@/lib/tauri";
import { cn, formatBytes, formatCount } from "@/lib/utils";
import { useConnections } from "@/stores/session/connections";
import { useAppFlavor } from "@/stores/preferences/appFlavor";
import {
  usePreferences,
} from "@/stores/preferences/preferences";
import { useOnDemandRead } from "@/lib/pulse/useOnDemandRead";
import { latestOf, seriesFromHistory } from "@/lib/pulse/rates";
import type {
  PulseHistorySeries,
  PulseIndexUsage,
  PulseSession,
  PulseTopQuery,
} from "@/types";

type ViewId =
  "status" | "queries" | "storage" | "sessions" | "indexes" | "retro";

const VIEWS: { id: ViewId; icon: LucideIcon; labelKey: string }[] = [
  { id: "status", icon: Activity, labelKey: "pulse.section.status" },
  { id: "queries", icon: ListOrdered, labelKey: "pulse.section.slowest" },
  { id: "storage", icon: HardDrive, labelKey: "pulse.section.storage" },
  { id: "sessions", icon: Users, labelKey: "pulse.section.sessions" },
  { id: "indexes", icon: ListTree, labelKey: "pulse.section.indexes" },
  { id: "retro", icon: History, labelKey: "pulse.section.retro" },
];

function Panel({
  title,
  hint,
  action,
  children,
}: {
  title: string;
  hint?: string;
  /** An interactive header control (a refresh button, say) — separate from
   *  `hint` so a view with both (a manual-refresh table showing its own row
   *  count) doesn't have to squeeze one string into the other. */
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-[var(--radius)] border border-border bg-card">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <h2 className="text-xs font-semibold">{title}</h2>
        {hint && (
          <span
            className={cn(
              "font-mono text-3xs text-muted-foreground",
              !action && "ml-auto",
            )}
          >
            {hint}
          </span>
        )}
        {action && (
          <span className="ml-auto flex items-center gap-1">{action}</span>
        )}
      </header>
      <div className="p-3">{children}</div>
    </section>
  );
}

function RefreshButton({
  onClick,
  loading,
}: {
  onClick: () => void;
  loading: boolean;
}) {
  const { t } = useTranslation();
  return (
    <IconButton
      size="xs"
      icon={RefreshCw}
      label={t("pulse.refresh")}
      loading={loading}
      onClick={onClick}
    />
  );
}

function StatusView({ view }: { view: PulseView }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-3">
      <StatusTiles view={view} columns={4} />
      <Panel
        title={t("pulse.section.alerts")}
        hint={
          view.alerts.length ? String(view.alerts.length) : t("pulse.noAlerts")
        }
      >
        <AlertList alerts={view.alerts} />
      </Panel>
    </div>
  );
}

/** One digest's fetched (or in-flight, or failed) plan, keyed by `sample` —
 *  the same string is what `pulseExplain` is called with, so it doubles as
 *  the cache key without needing a second identifier per row. */
interface ExplainState {
  loading: boolean;
  raw?: unknown;
  error?: string;
}

function ExplainPanel({ state }: { state: ExplainState }) {
  const { t } = useTranslation();
  if (state.loading) {
    return (
      <div className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
        <Spinner size="sm" />
        {t("pulse.explain.loading")}
      </div>
    );
  }
  if (state.error) {
    return (
      <p className="px-3 py-3 text-xs text-destructive">
        {t("pulse.explain.error")} {state.error}
      </p>
    );
  }
  return (
    <pre className="max-h-80 overflow-auto px-3 py-3 font-mono text-3xs leading-relaxed">
      {JSON.stringify(state.raw, null, 2)}
    </pre>
  );
}

function QueriesView({
  view,
  connectionId,
}: {
  view: PulseView;
  connectionId: string;
}) {
  const { t } = useTranslation();
  const items = view.topQueries?.items ?? [];

  const [openDigest, setOpenDigest] = useState<string | null>(null);
  const [explains, setExplains] = useState<Record<string, ExplainState>>({});

  const toggleExplain = useCallback(
    (query: PulseTopQuery) => {
      if (openDigest === query.digest) {
        setOpenDigest(null);
        return;
      }
      setOpenDigest(query.digest);
      if (!query.sample || explains[query.digest]) return;
      setExplains((s) => ({ ...s, [query.digest]: { loading: true } }));
      void api
        .pulseExplain(connectionId, query.sample)
        .then((plan) =>
          setExplains((s) => ({
            ...s,
            [query.digest]: { loading: false, raw: plan.raw },
          })),
        )
        .catch((e) =>
          setExplains((s) => ({
            ...s,
            [query.digest]: { loading: false, error: String(e) },
          })),
        );
    },
    [openDigest, explains, connectionId],
  );

  if (items.length === 0) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title={
          view.topQueries?.error
            ? t("pulse.slowest.unavailable")
            : view.topQueries
              ? t("pulse.slowest.empty")
              : t("pulse.loading")
        }
        hint={
          view.topQueries?.error && view.latest
            ? slowestHint(view.latest.driver, t)
            : undefined
        }
      />
    );
  }

  return (
    <Panel
      title={t("pulse.section.slowest")}
      hint={t("pulse.showingOf", { shown: items.length, total: items.length })}
    >
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-border text-3xs uppercase tracking-wider text-muted-foreground">
              <th className="px-2 py-1.5 text-left font-medium">
                {t("pulse.table.statement")}
              </th>
              <th className="px-2 py-1.5 text-right font-medium">
                {t("pulse.table.runs")}
              </th>
              <th className="px-2 py-1.5 text-right font-medium">
                {t("pulse.table.avg")}
              </th>
              <th className="px-2 py-1.5 text-right font-medium">
                {t("pulse.table.max")}
              </th>
              <th className="px-2 py-1.5 text-right font-medium">
                {t("pulse.table.examinedSent")}
              </th>
              <th className="px-2 py-1.5 text-left font-medium">
                {t("pulse.table.signal")}
              </th>
              <th className="px-2 py-1.5 text-left font-medium">
                {t("pulse.table.plan")}
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((q) => {
              const open = openDigest === q.digest;
              return (
                <Fragment key={q.digest}>
                  <tr className="border-b border-border last:border-b-0">
                    <td className="max-w-[46ch] px-2 py-1.5 align-top">
                      {/* `line-clamp` sets `display: -webkit-box`, so the digest
                          needs its own block and the schema its own line below. */}
                      <div
                        className="line-clamp-2 font-mono text-2xs"
                        title={q.digest}
                      >
                        {q.digest}
                      </div>
                      {q.schema && (
                        <div className="font-mono text-3xs text-muted-foreground">
                          {q.schema}
                        </div>
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono tabular-nums">
                      {formatCount(q.count)}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono tabular-nums">
                      {q.avgMs < 1 ? "<1" : Math.round(q.avgMs)} ms
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono tabular-nums text-muted-foreground">
                      {q.maxMs < 1 ? "<1" : Math.round(q.maxMs)} ms
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono tabular-nums text-muted-foreground">
                      {formatCount(q.rowsExamined)} / {formatCount(q.rowsSent)}
                    </td>
                    <td className="px-2 py-1.5">
                      {q.fullScans > 0 ? (
                        <span className="rounded-full border border-destructive/40 bg-destructive/10 px-1.5 py-0.5 font-mono text-3xs text-destructive">
                          {t("pulse.slowest.noIndexCount", {
                            count: formatCount(q.fullScans),
                          })}
                        </span>
                      ) : (
                        <span className="font-mono text-3xs text-muted-foreground">
                          —
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-1.5">
                      <button
                        type="button"
                        disabled={!q.sample}
                        onClick={() => toggleExplain(q)}
                        title={
                          q.sample ? undefined : t("pulse.explain.unavailable")
                        }
                        aria-expanded={open}
                        className={cn(
                          "flex items-center gap-1 rounded-md px-1.5 py-1 font-mono text-3xs",
                          "text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40",
                          "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent",
                        )}
                      >
                        <ChevronRight
                          className={cn(
                            "h-3 w-3 transition-transform",
                            open && "rotate-90",
                          )}
                        />
                        {t("pulse.table.plan")}
                      </button>
                    </td>
                  </tr>
                  {open && (
                    <tr className="border-b border-border last:border-b-0">
                      <td colSpan={7} className="bg-accent/20 p-0">
                        <ExplainPanel
                          state={explains[q.digest] ?? { loading: true }}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function StorageView({ view }: { view: PulseView }) {
  const { t } = useTranslation();
  const items = view.storage?.items ?? [];

  if (items.length === 0) {
    return (
      <EmptyState
        icon={HardDrive}
        title={
          view.storage?.error
            ? t("pulse.storage.unavailable")
            : view.storage
              ? t("pulse.storage.empty")
              : t("pulse.loading")
        }
      />
    );
  }

  const max = Math.max(...items.map((i) => i.totalBytes));

  return (
    <Panel
      title={t("pulse.section.storage")}
      hint={formatBytes(view.storageTotalBytes)}
    >
      <div className="flex flex-col gap-2">
        {items.map((item) => {
          const total = item.totalBytes;
          const pct = (n: number) =>
            total > 0 ? `${((n / total) * 100).toFixed(1)}%` : "0%";
          return (
            <div
              key={`${item.schema}.${item.name}`}
              className="grid grid-cols-[minmax(0,14rem)_1fr_auto] items-center gap-3"
            >
              <span className="truncate font-mono text-2xs" title={item.name}>
                {item.name}
              </span>
              <span className="flex h-4 overflow-hidden rounded-sm bg-accent">
                <span
                  className="relative flex h-full"
                  style={{ width: `${((total / max) * 100).toFixed(1)}%` }}
                >
                  <span
                    style={{
                      width: pct(item.dataBytes),
                      background: "var(--brand)",
                    }}
                  />
                  <span
                    style={{
                      width: pct(item.indexBytes),
                      background: "var(--fk)",
                    }}
                  />
                  {item.freeIsWithinData ? (
                    // Reclaimable space already inside the data segment
                    // (MongoDB) — an overlay at its trailing edge, not a
                    // segment that would add its own width on top of a total
                    // that already includes it.
                    <span
                      className="absolute inset-y-0 opacity-60"
                      style={{
                        right: pct(item.indexBytes),
                        width: pct(item.freeBytes),
                        backgroundImage:
                          "repeating-linear-gradient(45deg, var(--warning) 0, var(--warning) 2px, transparent 2px, transparent 4px)",
                      }}
                    />
                  ) : (
                    <span
                      style={{
                        width: pct(item.freeBytes),
                        background: "var(--warning)",
                      }}
                    />
                  )}
                </span>
              </span>
              <span className="font-mono text-2xs tabular-nums text-muted-foreground">
                {formatBytes(total)}
              </span>
            </div>
          );
        })}
        <StorageLegend />
      </div>
    </Panel>
  );
}

function SessionsView({ connectionId }: { connectionId: string }) {
  const { t } = useTranslation();
  const { items, loading, error, refresh } = useOnDemandRead<PulseSession>(
    connectionId,
    api.pulseSessions,
  );

  if (loading && items.length === 0) {
    return <EmptyState icon={Users} title={t("pulse.loading")} />;
  }
  if (error && items.length === 0) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title={t("pulse.sessions.unavailable")}
        hint={error}
      />
    );
  }
  if (items.length === 0) {
    return <EmptyState icon={Users} title={t("pulse.sessions.empty")} />;
  }

  return (
    <Panel
      title={t("pulse.section.sessions")}
      hint={t("pulse.showingOf", { shown: items.length, total: items.length })}
      action={<RefreshButton onClick={refresh} loading={loading} />}
    >
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-border text-3xs uppercase tracking-wider text-muted-foreground">
              <th className="px-2 py-1.5 text-left font-medium">
                {t("pulse.table.id")}
              </th>
              <th className="px-2 py-1.5 text-left font-medium">
                {t("pulse.table.user")}
              </th>
              <th className="px-2 py-1.5 text-left font-medium">
                {t("pulse.table.command")}
              </th>
              <th className="px-2 py-1.5 text-left font-medium">
                {t("pulse.table.state")}
              </th>
              <th className="px-2 py-1.5 text-right font-medium">
                {t("pulse.table.duration")}
              </th>
              <th className="px-2 py-1.5 text-left font-medium">
                {t("pulse.table.statement")}
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((s) => (
              <tr key={s.id} className="border-b border-border last:border-b-0">
                <td className="px-2 py-1.5 font-mono text-2xs text-muted-foreground">
                  {s.id}
                </td>
                <td className="px-2 py-1.5 align-top">
                  <div className="font-mono text-2xs">{s.user ?? "—"}</div>
                  {(s.host || s.db) && (
                    <div className="truncate font-mono text-3xs text-muted-foreground">
                      {[s.host, s.db].filter(Boolean).join(" · ")}
                    </div>
                  )}
                </td>
                <td className="px-2 py-1.5 font-mono text-2xs">{s.command}</td>
                <td className="px-2 py-1.5">
                  <div className="flex items-center gap-1">
                    <span className="font-mono text-2xs">{s.state ?? "—"}</span>
                    {s.blockedBy && (
                      <span
                        title={t("pulse.sessions.blockedByTitle", {
                          id: s.blockedBy,
                        })}
                        className="flex items-center gap-0.5 rounded-full border border-destructive/40 bg-destructive/10 px-1.5 py-0.5 font-mono text-3xs text-destructive"
                      >
                        <Link2 className="h-2.5 w-2.5" />
                        {s.blockedBy}
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-2 py-1.5 text-right font-mono tabular-nums text-muted-foreground">
                  {s.durationSecs < 1 ? "<1" : Math.round(s.durationSecs)} s
                </td>
                <td className="max-w-[46ch] px-2 py-1.5">
                  <div
                    className="line-clamp-2 font-mono text-2xs"
                    title={s.query ?? undefined}
                  >
                    {s.query ?? "—"}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function IndexesView({ connectionId }: { connectionId: string }) {
  const { t } = useTranslation();
  const { items, loading, error, refresh } = useOnDemandRead<PulseIndexUsage>(
    connectionId,
    api.pulseIndexUsage,
  );

  if (loading && items.length === 0) {
    return <EmptyState icon={ListTree} title={t("pulse.loading")} />;
  }
  if (error && items.length === 0) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title={t("pulse.indexes.unavailable")}
        hint={error}
      />
    );
  }
  if (items.length === 0) {
    return <EmptyState icon={ListTree} title={t("pulse.indexes.empty")} />;
  }

  return (
    <Panel
      title={t("pulse.section.indexes")}
      hint={t("pulse.showingOf", { shown: items.length, total: items.length })}
      action={<RefreshButton onClick={refresh} loading={loading} />}
    >
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-border text-3xs uppercase tracking-wider text-muted-foreground">
              <th className="px-2 py-1.5 text-left font-medium">
                {t("pulse.table.table")}
              </th>
              <th className="px-2 py-1.5 text-left font-medium">
                {t("pulse.table.index")}
              </th>
              <th className="px-2 py-1.5 text-right font-medium">
                {t("pulse.table.reads")}
              </th>
              <th className="px-2 py-1.5 text-right font-medium">
                {t("pulse.table.size")}
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr
                key={`${i.schema}.${i.table}.${i.indexName}`}
                className="border-b border-border last:border-b-0"
              >
                <td className="px-2 py-1.5 align-top">
                  <div className="font-mono text-2xs">{i.table}</div>
                  {i.schema && (
                    <div className="font-mono text-3xs text-muted-foreground">
                      {i.schema}
                    </div>
                  )}
                </td>
                <td className="px-2 py-1.5 font-mono text-2xs">
                  {i.indexName}
                </td>
                <td className="px-2 py-1.5 text-right">
                  {i.reads === null ? (
                    <span className="font-mono text-3xs text-muted-foreground">
                      —
                    </span>
                  ) : i.reads === 0 ? (
                    <span className="rounded-full border border-destructive/40 bg-destructive/10 px-1.5 py-0.5 font-mono text-3xs text-destructive">
                      {t("pulse.indexes.unused")}
                    </span>
                  ) : (
                    <span className="font-mono text-2xs tabular-nums">
                      {formatCount(i.reads)}
                    </span>
                  )}
                </td>
                <td className="px-2 py-1.5 text-right font-mono text-2xs tabular-nums text-muted-foreground">
                  {i.sizeBytes === null ? "—" : formatBytes(i.sizeBytes)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

type RetroRange = "24h" | "7d" | "30d";

const RETRO_RANGE_MS: Record<RetroRange, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

/** Two metrics, not the whole live tile set: cache-hit history would need
 *  its two underlying counters lined up point-for-point, which downsampled
 *  history has no guarantee of doing cleanly, and every other live tile is
 *  a live-only concern (connection ceiling, index nobody enabled a
 *  history for). Queries/s and connection pressure are the two figures
 *  worth asking "what did this look like a week ago" about. */
const RETRO_METRICS: { metric: string; labelKey: string; color: string }[] = [
  {
    metric: "queries",
    labelKey: "pulse.metric.queriesPerSecond",
    color: "var(--brand)",
  },
  {
    metric: "connections_active",
    labelKey: "pulse.metric.connections",
    color: "var(--fk)",
  },
];

function RetroChart({
  connectionId,
  metric,
  labelKey,
  color,
  range,
}: {
  connectionId: string;
  metric: string;
  labelKey: string;
  color: string;
  range: RetroRange;
}) {
  const { t } = useTranslation();
  const [series, setSeries] = useState<PulseHistorySeries | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    api
      .pulseHistory(connectionId, metric, Date.now() - RETRO_RANGE_MS[range])
      .then((s) => {
        if (!cancelled) {
          setSeries(s);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(String(e));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [connectionId, metric, range]);

  const values = series ? seriesFromHistory(series.points, series.kind) : [];
  const latest = latestOf(values);

  return (
    <div className="rounded-md border border-border p-2">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-2xs text-muted-foreground">{t(labelKey)}</span>
        <span className="font-mono text-xs tabular-nums">
          {latest === null
            ? "—"
            : latest < 10
              ? latest.toFixed(1)
              : Math.round(latest)}
        </span>
      </div>
      {loading && values.length === 0 ? (
        <div className="flex h-16 items-center justify-center text-2xs text-muted-foreground">
          {t("pulse.loading")}
        </div>
      ) : error && values.length === 0 ? (
        <div className="flex h-16 items-center justify-center text-2xs text-muted-foreground">
          {t("pulse.retro.unavailable")}
        </div>
      ) : values.every((v) => v === null) ? (
        <div className="flex h-16 items-center justify-center text-2xs text-muted-foreground">
          {t("pulse.retro.empty")}
        </div>
      ) : (
        <Sparkline
          values={values}
          color={color}
          width={480}
          height={64}
          className="w-full"
        />
      )}
    </div>
  );
}

function RetroView({ connectionId }: { connectionId: string }) {
  const { t } = useTranslation();
  const [range, setRange] = useState<RetroRange>("24h");

  return (
    <Panel
      title={t("pulse.section.retro")}
      action={
        <Segmented
          size="sm"
          value={range}
          onValueChange={setRange}
          options={(["24h", "7d", "30d"] as const).map((r) => ({
            value: r,
            label: t(`pulse.retro.range.${r}`),
          }))}
        />
      }
    >
      <div className="flex flex-col gap-2">
        {RETRO_METRICS.map((m) => (
          <RetroChart
            key={m.metric}
            connectionId={connectionId}
            metric={m.metric}
            labelKey={m.labelKey}
            color={m.color}
            range={range}
          />
        ))}
      </div>
    </Panel>
  );
}

function PulseBody({ connectionId }: { connectionId: string }) {
  const { t } = useTranslation();
  const [viewId, setViewId] = useState<ViewId>("status");

  // Without `monitor` the window shows why, and polls nothing.
  const monitorLock = usePolicyLock(connectionId, "monitor");

  // This window exists to show Pulse, so it is always the active surface —
  // `usePulseLive` still stands down while the window is minimised.
  usePulseLive(connectionId, !monitorLock);
  const { refresh } = usePulseDetail(connectionId, !monitorLock);
  const view = usePulseView(connectionId);

  if (monitorLock) return <PolicyLockedState reason={monitorLock} />;

  if (isUnsupported(view.error) && !view.latest) {
    return (
      <EmptyState
        icon={ServerCog}
        title={t("pulse.unsupported.title")}
        hint={t("pulse.unsupported.hint")}
      />
    );
  }

  if (!view.latest) {
    return (
      <EmptyState
        icon={Activity}
        title={view.error ? t("pulse.failed") : t("pulse.collecting")}
        hint={view.error}
      />
    );
  }

  return (
    <div className="grid h-full grid-cols-[168px_1fr] overflow-hidden">
      <nav
        aria-label={t("pulse.title")}
        className="flex flex-col gap-0.5 border-r border-border bg-card p-2"
      >
        <p className="px-2 pb-2 pt-1 text-3xs uppercase tracking-wider text-muted-foreground">
          {t("pulse.title")}
        </p>
        {VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            onClick={() => setViewId(v.id)}
            aria-current={viewId === v.id}
            className={cn(
              "flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs",
              "transition-colors hover:bg-accent hover:text-foreground",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40",
              viewId === v.id
                ? "bg-accent font-semibold text-foreground"
                : "text-muted-foreground",
            )}
          >
            <v.icon
              className={cn("h-3.5 w-3.5", viewId === v.id && "text-brand")}
            />
            {t(v.labelKey)}
            {v.id === "status" && view.alerts.length > 0 && (
              <span className="ml-auto rounded-full bg-warning/20 px-1.5 font-mono text-3xs text-warning">
                {view.alerts.length}
              </span>
            )}
          </button>
        ))}
        <div className="mt-auto flex flex-col gap-1 border-t border-border pt-2">
          <Button
            variant="quiet"
            size="sm"
            icon={RefreshCw}
            onClick={refresh}
            className="justify-start"
          >
            {t("pulse.refresh")}
          </Button>
          <p className="px-2 pb-1 font-mono text-3xs leading-relaxed text-muted-foreground">
            {view.latest.driver} {view.latest.serverVersion}
          </p>
        </div>
      </nav>

      <div className="min-w-0 overflow-y-auto p-3">
        {viewId === "status" && <StatusView view={view} />}
        {viewId === "queries" && (
          <QueriesView view={view} connectionId={connectionId} />
        )}
        {viewId === "storage" && <StorageView view={view} />}
        {viewId === "sessions" && <SessionsView connectionId={connectionId} />}
        {viewId === "indexes" && <IndexesView connectionId={connectionId} />}
        {viewId === "retro" && <RetroView connectionId={connectionId} />}
      </div>
    </div>
  );
}

export function PulseWindow() {
  const { t } = useTranslation();
  const [connectionId, setConnectionId] = useState<string | null | undefined>(
    undefined,
  );
  const language = usePreferences((s) => s.prefs.ui.language);

  // Minimal bootstrap, mirroring `DetachedTabWindow`: enough state for the
  // views to run standalone, without the main window's launch-restore flow.
  //
  // `takePulseWindowIntent` REMOVES the intent from the backend map, so it
  // must run exactly once. Under `<React.StrictMode>` (main.tsx) this effect
  // mounts, unmounts and remounts in dev — a second call finds nothing and
  // resolves `null`, and with no guard that second `setConnectionId` always
  // wins, painting the "lost its connection" state even though the first
  // call already had the real id. Same idiom as `App.tsx`'s
  // `launchRestoreDone` and `useCliIntents`' `cliArgsHandled`.
  const intentHandled = useRef(false);
  useEffect(() => {
    if (intentHandled.current) return;
    intentHandled.current = true;
    void useAppFlavor.getState().load();
    void usePreferences.getState().hydrate();
    void useConnections.getState().refresh();
    void api
      .takePulseWindowIntent(getCurrentWindow().label)
      .then((id) => setConnectionId(id ?? null));
  }, []);

  useEffect(() => {
    setLanguage(language);
  }, [language]);

  useBridge(startWindowListBridge);
  useBridge(startPolicyBridge);

  return (
    <TooltipProvider>
      <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
        <TitleBar>
          <WindowCaption />
        </TitleBar>
        <SandboxRibbon />
        <WindowColorBadge />
        <div className="min-h-0 flex-1">
          {connectionId === undefined ? null : connectionId === null ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              {t("pulse.windowUnavailable")}
            </div>
          ) : (
            <ConnectionErrorBoundary resetKey={connectionId}>
              <PulseBody connectionId={connectionId} />
            </ConnectionErrorBoundary>
          )}
        </div>
        <NotificationHosts />
        <ConfirmHost />
      </div>
    </TooltipProvider>
  );
}
