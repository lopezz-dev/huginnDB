/**
 * Tab-switchable, card-based picker for the empty workspace (#110, redesigned
 * twice: first from a shrunk folder-tree to small chips, then enlarged here).
 *
 * The chip version packed everything into a dense inline row — reads fine as
 * a menu, not as the one thing on an otherwise empty screen. This is bigger
 * on purpose: one clear focal element (name + icon) per card, generous
 * padding, restraint everywhere else — the border is the only decoration and
 * it only ever means one of two things, "this is selectable" (dim) or "this
 * is the current one" (brand, filled). No shadows, no gradients, nothing
 * fighting the content for attention.
 *
 * Group headers survive as plain non-interactive labels (folders still matter
 * for finding a connection among many), but they no longer fold — collapsing
 * a card grid buys nothing a scrollbar and a search box don't already give,
 * and it would be a second, disconnected collapse state from the one the tree
 * already owns via `useConnectionGroupCollapse`.
 *
 * The Environments tab only renders in the main window: switching tears down
 * and rebuilds the whole session (`useEnvironments.switchTo`), which is guarded
 * to the main window there too (ADR #8) — showing a control that quietly
 * no-ops elsewhere would be worse than not showing it.
 */

import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { SearchField } from "@/components/ui/search-field";
import { Spinner } from "@/components/ui/spinner";
import { isMainWindow } from "@/lib/window";
import { useConnections } from "@/stores/session/connections";
import { useUi } from "@/stores/session/ui";
import {
  effectiveColor,
  effectiveIcon,
  environmentLabel,
  useEnvironments,
  useOrderedEnvironments,
} from "@/stores/session/environments";
import { connectAndWarm } from "@/lib/connection/connectFlow";
import { bucketByGroup, cn } from "@/lib/utils";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { DriverBadge, driverLabel } from "@/components/common/DriverBadge";
import { EnvironmentAvatar } from "@/components/connection/EnvironmentAvatar";
import type { ConnectionProfile, Environment } from "@/types";

/**
 * Shared card shell. One message per card — an icon and a name, optionally a
 * muted subtitle — so the eye has exactly one thing to parse per tile rather
 * than a label competing with a status dot competing with a badge.
 */
function PickerCard({
  active,
  onClick,
  disabled,
  icon,
  label,
  subtitle,
}: {
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  icon: ReactNode;
  label: string;
  subtitle?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        // Connection card of the brand language: 12px corners, a 2px sticker
        // edge, a very light lift at rest, and on the active one a blue edge
        // with a *subtle* glow (`shadow-brand-ring`, not a neon halo).
        "flex flex-col items-center gap-2.5 rounded-xl border-2 px-4 py-5 text-center transition-[background-color,border-color,box-shadow,transform] duration-180 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 disabled:cursor-default disabled:opacity-60",
        active
          ? "border-brand bg-brand/10 shadow-brand-ring"
          : "border-border/60 bg-card shadow-elevation-1 hover:-translate-y-px hover:border-brand/70 hover:bg-brand/5 hover:shadow-elevation-2",
      )}
    >
      <span className="flex h-8 w-8 items-center justify-center">{icon}</span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span
          className={cn(
            "max-w-[9.5rem] truncate text-sm font-medium",
            active ? "text-foreground" : "text-foreground/85",
          )}
        >
          {label}
        </span>
        {subtitle && (
          <span className="max-w-[9.5rem] truncate text-2xs text-muted-foreground">
            {subtitle}
          </span>
        )}
      </span>
    </button>
  );
}

function ConnectionsPane() {
  const { t } = useTranslation();
  const profiles = useConnections((s) => s.profiles);
  const active = useConnections((s) => s.active);
  const selected = useUi((s) => s.selectedConnectionId);
  const setSelected = useUi((s) => s.setSelectedConnectionId);
  // Same per-environment subset `ConnectionsTree` applies (`useUi.visibleConnections`):
  // recommending a connection the active environment's filter hides would make
  // the filter pointless the moment the workspace is empty.
  const visibleConnectionIds = useUi((s) => s.visibleConnections);
  const visibleSet = useMemo(
    () =>
      visibleConnectionIds && visibleConnectionIds.length > 0
        ? new Set(visibleConnectionIds)
        : null,
    [visibleConnectionIds],
  );
  const visibleProfiles = useMemo(
    () => profiles.filter((p) => !visibleSet || visibleSet.has(p.id)),
    [profiles, visibleSet],
  );

  const [query, setQuery] = useState("");
  // Shared with `useConnections` rather than local state — see
  // `ConnectionsTree`'s `connectingIds` for why: the environment switch's
  // background reconnect calls the same `connect()` a card click does.
  const connectingIds = useConnections((s) => s.connecting);

  const needle = query.trim().toLowerCase();
  const matches = useMemo(
    () =>
      needle
        ? visibleProfiles.filter(
            (p) =>
              p.name.toLowerCase().includes(needle) ||
              (p.group ?? "").toLowerCase().includes(needle),
          )
        : visibleProfiles,
    [visibleProfiles, needle],
  );
  const buckets = useMemo(() => bucketByGroup(matches), [matches]);

  async function pick(p: ConnectionProfile) {
    if (connectingIds.has(p.id)) return;
    if (!active.has(p.id)) {
      const ok = await connectAndWarm(p.id);
      if (!ok) return;
    }
    setSelected(p.id);
  }

  function ConnectionCard({ p }: { p: ConnectionProfile }) {
    const isConnecting = connectingIds.has(p.id);
    return (
      <PickerCard
        active={selected === p.id}
        disabled={isConnecting}
        onClick={() => void pick(p)}
        label={p.name}
        subtitle={driverLabel(p.driver)}
        icon={
          isConnecting ? (
            <Spinner size="lg" className="text-muted-foreground" />
          ) : (
            <DriverBadge driver={p.driver} size="lg" />
          )
        }
      />
    );
  }

  return (
    <div className="flex w-full flex-col gap-3">
      <SearchField
        value={query}
        onValueChange={setQuery}
        placeholder={t("connectionDialog.searchPlaceholder")}
        inputClassName="text-sm"
      />
      <div className="max-h-96 overflow-y-auto">
        {matches.length === 0 ? (
          <div className="px-2 py-6 text-center text-xs italic text-muted-foreground">
            {needle
              ? t("commandPalette.noResults")
              : t("connectionsTree.empty")}
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {buckets.ungrouped.length > 0 && (
              <div className="grid grid-cols-[repeat(auto-fit,minmax(9.5rem,1fr))] gap-3">
                {buckets.ungrouped.map((p) => (
                  <ConnectionCard key={p.id} p={p} />
                ))}
              </div>
            )}
            {buckets.groups.map(({ name, items }) => (
              <div key={name} className="flex flex-col gap-2">
                <div className="px-0.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {name}
                </div>
                <div className="grid grid-cols-[repeat(auto-fit,minmax(9.5rem,1fr))] gap-3">
                  {items.map((p) => (
                    <ConnectionCard key={p.id} p={p} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function EnvironmentsPane() {
  const { t } = useTranslation();
  const activeId = useEnvironments((s) => s.activeId);
  const switchTo = useEnvironments((s) => s.switchTo);
  // Was a local `useState` mirroring what the store now tracks itself. Kept
  // local it was only ever right *here*: every other switch surface (the rail,
  // the status-bar switcher) had a boolean and pointed at the wrong row.
  const switchingTo = useEnvironments((s) => s.switchingTo);
  const [query, setQuery] = useState("");

  const defaultName = t("environments.defaultName");
  const needle = query.trim().toLowerCase();
  const ordered = useOrderedEnvironments();
  const matches = useMemo(
    () =>
      needle
        ? ordered.filter((env) =>
            environmentLabel(env, defaultName).toLowerCase().includes(needle),
          )
        : ordered,
    [ordered, needle, defaultName],
  );

  async function pick(env: Environment) {
    if (switchingTo !== null || env.id === activeId) return;
    await switchTo(env.id);
  }

  return (
    <div className="flex w-full flex-col gap-3">
      <SearchField
        value={query}
        onValueChange={setQuery}
        placeholder={t("workspacePicker.searchEnvironments")}
        inputClassName="text-sm"
      />
      {matches.length === 0 ? (
        <div className="px-2 py-6 text-center text-xs italic text-muted-foreground">
          {t("commandPalette.noResults")}
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(9.5rem,1fr))] gap-3">
          {matches.map((env) => (
            <PickerCard
              key={env.id}
              active={env.id === activeId}
              disabled={switchingTo !== null}
              onClick={() => void pick(env)}
              label={environmentLabel(env, defaultName)}
              icon={
                switchingTo === env.id ? (
                  <Spinner size="lg" className="text-muted-foreground" />
                ) : (
                  <EnvironmentAvatar
                    name={environmentLabel(env, defaultName)}
                    color={effectiveColor(env)}
                    icon={effectiveIcon(env)}
                    size={32}
                  />
                )
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function WorkspacePicker({ className }: { className?: string }) {
  const { t } = useTranslation();
  const hasProfiles = useConnections((s) => s.profiles.length > 0);
  const environments = useEnvironments((s) => s.environments);
  // Main-window-only for now: `switchTo` itself works locally in a secondary
  // window (it just re-points that window's own connection filter, see
  // `useEnvironments.switchTo`), but this empty-workspace picker tab hasn't
  // been audited for that surface yet — left out of the "New window"
  // independence pass that unlocked the rail/status-bar switcher.
  const showEnvironments = isMainWindow() && environments.length > 1;

  if (!hasProfiles && !showEnvironments) return null;

  if (!showEnvironments) {
    return (
      <div className={className}>
        <ConnectionsPane />
      </div>
    );
  }

  return (
    <Tabs
      defaultValue="connections"
      className={cn("flex flex-col gap-3", className)}
    >
      <TabsList className="h-auto self-center p-1">
        <TabsTrigger value="connections" className="px-4 py-1.5 text-sm">
          {t("workspacePicker.connectionsTab")}
        </TabsTrigger>
        <TabsTrigger value="environments" className="px-4 py-1.5 text-sm">
          {t("workspacePicker.environmentsTab")}
        </TabsTrigger>
      </TabsList>
      <TabsContent value="connections">
        <ConnectionsPane />
      </TabsContent>
      <TabsContent value="environments">
        <EnvironmentsPane />
      </TabsContent>
    </Tabs>
  );
}
