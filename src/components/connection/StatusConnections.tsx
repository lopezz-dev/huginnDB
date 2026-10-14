/**
 * Status-bar connections control. A dropdown listing the currently active
 * pools (click to jump to that workspace, or disconnect) — the trigger shows
 * a brand-coloured dot + a live count. The full saved-profile browsing/quick
 * -connect list lives in the Schema panel's `ConnectionsTree` (#107) now, so
 * this control only surfaces what's *already* connected, not every profile.
 *
 * Connect / disconnect mirror the FileMenu flow (best-effort connect with the
 * keychain-stored secret; disconnect tears down the schema cache + tabs) so
 * the two entry points behave identically.
 */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronUp, PlugZap, RotateCw } from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";
import { useConnections } from "@/stores/session/connections";
import { useConnectionHealth } from "@/stores/session/connectionHealth";
import { useSchema } from "@/stores/session/schema";
import { useTabs } from "@/stores/session/tabs";
import { useUi } from "@/stores/session/ui";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuItem,
} from "@/components/ui/dropdown";
import { DriverBadge } from "@/components/common/DriverBadge";
import { VanishedOriginMark } from "@/components/common/VanishedOriginNotice";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { connectAndWarm } from "@/lib/connection/connectFlow";
import { cn } from "@/lib/utils";
import type { ConnectionProfile } from "@/types";

export function StatusConnections() {
  const { t } = useTranslation();
  const profiles = useConnections((s) => s.profiles);
  const active = useConnections((s) => s.active);
  const versions = useConnections((s) => s.versions);
  const disconnect = useConnections((s) => s.disconnect);
  const lostConnections = useConnectionHealth((s) => s.lost);
  const editedConnections = useConnectionHealth((s) => s.edited);
  const dropSchema = useSchema((s) => s.drop);
  const closeTabs = useTabs((s) => s.closeForConnection);
  const selected = useUi((s) => s.selectedConnectionId);
  const setSelected = useUi((s) => s.setSelectedConnectionId);

  // Just the connected profiles, in whatever order `profiles` already has
  // them. Reference-stable inputs, so deriving here (rather than via a store
  // selector) honours the Zustand rule.
  const activeProfiles = useMemo(
    () => profiles.filter((p) => active.has(p.id)),
    [profiles, active],
  );

  // The connection currently in focus (a live pool the workspace points at).
  // Drives the trigger label so the active connection is visible at a glance.
  const current = useMemo(
    () =>
      selected
        ? (profiles.find((p) => p.id === selected && active.has(p.id)) ?? null)
        : null,
    [selected, profiles, active],
  );

  async function handleConnect(p: ConnectionProfile) {
    if (active.has(p.id)) {
      setSelected(p.id);
      return;
    }
    // Was an inlined copy of `connectAndWarm`, one of three; the copies had
    // already drifted (this one added the wrong-driver hint, the command
    // palette's did not) and a fourth decision — whether a successful connect
    // says so — was not going to be spelled three times.
    if (await connectAndWarm(p.id)) setSelected(p.id);
  }

  /** Mirrors `ConnectionList.handleReconnect`: tear down the dead pool and
   *  reopen it, keeping any open tabs intact. */
  async function handleReconnect(p: ConnectionProfile) {
    try {
      await disconnect(p.id);
    } catch {
      // The pool was already dead; proceed to reconnect regardless.
    }
    await handleConnect(p);
  }

  /** Ids being torn down, so their row can say so — see the tree's own note:
   *  closing a pool is several round trips, and a control that looks ignored
   *  invites a second click. */
  const [disconnecting, setDisconnecting] = useState<Set<string>>(
    () => new Set(),
  );
  function markDisconnecting(id: string, value: boolean) {
    setDisconnecting((prev) => {
      if (prev.has(id) === value) return prev;
      const next = new Set(prev);
      if (value) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function handleDisconnect(id: string) {
    if (disconnecting.has(id)) return;
    markDisconnecting(id, true);
    try {
      await disconnect(id);
      dropSchema(id);
      closeTabs(id);
      if (selected === id) setSelected(null);
    } catch {
      // Non-fatal: leave the rest of the UI untouched on a teardown error.
    } finally {
      markDisconnecting(id, false);
    }
  }

  function renderActiveItem(p: ConnectionProfile) {
    const lostError = lostConnections[p.id];
    const isLost = !!lostError;
    // Open with settings the profile no longer has. Lost outranks it.
    const isEdited = !isLost && !!editedConnections[p.id];
    return (
      <DropdownMenuItem
        key={p.id}
        onSelect={() => setSelected(p.id)}
        // A lost pool is the most important state in this list — give the whole
        // row a destructive wash so it's unmissable, not just a 6px red dot.
        // Otherwise the focused connection (the one the workspace points at)
        // gets a resting brand wash so it reads as "active", distinct from the
        // other merely-connected rows (issue #31).
        className={cn(
          "gap-2",
          isLost
            ? "bg-destructive/10 focus:bg-destructive/15"
            : isEdited
              ? "bg-warning/10 focus:bg-warning/15"
              : selected === p.id && "bg-brand/10",
        )}
      >
        {/* Circular state indicators, echoing the lit dots on the logo's
            database cylinder: same 8px circle for every state, with a soft
            halo of its own colour so a live connection reads as *lit* rather
            than merely coloured. */}
        {isLost ? (
          <span className="h-2 w-2 shrink-0 rounded-full bg-destructive shadow-[0_0_0_3px_color-mix(in_srgb,var(--destructive)_18%,transparent)]" />
        ) : isEdited ? (
          <span className="h-2 w-2 shrink-0 rounded-full bg-warning shadow-[0_0_0_3px_color-mix(in_srgb,var(--warning)_18%,transparent)]" />
        ) : selected === p.id ? (
          <Check className="h-3.5 w-3.5 shrink-0 text-brand" />
        ) : (
          <span className="h-2 w-2 shrink-0 rounded-full bg-brand shadow-[0_0_0_3px_color-mix(in_srgb,var(--brand)_18%,transparent)]" />
        )}
        <span
          className={cn(
            "flex-1 truncate text-xs",
            selected === p.id && "font-semibold",
          )}
          title={
            isLost
              ? t("connections.lost", { message: lostError })
              : isEdited
                ? t("connections.edited")
                : undefined
          }
        >
          {p.name}
        </span>
        {selected === p.id && (
          <span className="shrink-0 rounded-sm bg-brand/15 px-1 py-0.5 text-3xs font-medium uppercase tracking-wide text-brand">
            {t("statusBar.activeLabel")}
          </span>
        )}
        {versions[p.id] && !isLost && (
          <span className="max-w-[6rem] truncate font-mono text-3xs text-muted-foreground">
            {versions[p.id]}
          </span>
        )}
        <VanishedOriginMark profileId={p.id} />
        <DriverBadge driver={p.driver} />
        {isLost || isEdited ? (
          // Explicit labelled affordance rather than a cryptic red icon.
          <button
            type="button"
            title={t(
              isLost
                ? "connections.reconnectTooltip"
                : "connections.editedTooltip",
            )}
            className={cn(
              "ml-0.5 flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-0.5 text-2xs font-medium transition-colors",
              isLost
                ? "text-destructive hover:bg-destructive/20"
                : "text-warning hover:bg-warning/20",
            )}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              void handleReconnect(p);
            }}
          >
            <RotateCw className="h-3 w-3" />
            {t("connections.reconnect")}
          </button>
        ) : (
          // `nativeTitle`: this sits inside open menu content, the one place
          // the OS tooltip is correct (see `tooltip.tsx`).
          <IconButton
            type="button"
            flat
            nativeTitle
            size="xs"
            tone="destructive"
            icon={PlugZap}
            label={t("statusBar.disconnect")}
            loading={disconnecting.has(p.id)}
            className="ml-0.5"
            onClick={(e) => {
              // Don't let the click bubble to the row's onSelect (jump).
              e.preventDefault();
              e.stopPropagation();
              void handleDisconnect(p.id);
            }}
          />
        )}
      </DropdownMenuItem>
    );
  }

  const count = activeProfiles.length;

  return (
    <DropdownMenu>
      <SimpleTooltip label={t("statusBar.connectionsActive")} side="top">
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              "flex items-center gap-1.5 rounded-sm px-1 py-0.5 outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
              count > 0 && "text-foreground",
            )}
          >
            {current ? (
              <DriverBadge driver={current.driver} />
            ) : (
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  count > 0 ? "bg-brand" : "bg-muted-foreground/40",
                )}
              />
            )}
            <span className="max-w-[12rem] truncate">
              {current
                ? current.name
                : count > 0
                  ? t("statusBar.connections", { count })
                  : t("statusBar.disconnected")}
            </span>
            <ChevronUp className="h-3 w-3 opacity-60" />
          </button>
        </DropdownMenuTrigger>
      </SimpleTooltip>
      <DropdownMenuContent side="top" align="start" className="w-72">
        <DropdownMenuLabel>
          {t("statusBar.connectionsActive")}
        </DropdownMenuLabel>
        {activeProfiles.length === 0 ? (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            {t("statusBar.noConnections")}
          </div>
        ) : (
          activeProfiles.map(renderActiveItem)
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
