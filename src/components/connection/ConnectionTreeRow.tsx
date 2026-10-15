/**
 * One connection row of `ConnectionsTree` — the row only. Its subtree is rows
 * of their own in the tree's one virtualised list (ADR #108), so an expanded
 * connection no longer mounts everything under it.
 *
 * Extracted out of `ConnectionsTree.renderConnection`, which returned this
 * exact JSX from a plain function CALLED per row (`renderConnection(p)`),
 * not rendered as `<renderConnection />` — so there was never a component
 * boundary here at all. Every row's JSX was reconciled as part of
 * `ConnectionsTree`'s own render pass, which means React could never bail
 * out of diffing it, no matter how little a given row actually changed. As
 * an actual `memo()`-wrapped component, a row now CAN skip re-rendering
 * when its own props are unchanged — see convention #28.
 *
 * The prop signature is wide (a whole `ConnectionMatchSummary`, a callback
 * bundle) rather than narrowed to primitives the way `SchemaTableRow` is —
 * deliberately: a connections list is dozens of rows, not the hundreds a
 * table list can be, so the payoff of chasing primitive props here is much
 * smaller than the `SchemaTableRow` fix earns. `actions` is grouped into one
 * bundle (the `TableActions` precedent) so a new affordance is one prop to
 * add, not eight.
 *
 * `actions` is a REF, not a plain object — the same `interactiveRef` /
 * `rowCallbacksRef` pattern `DataGrid`/`GridRow` already use, and
 * `DocumentListView`'s `callbacksRef`/`actionsRef` from the list-view memo
 * fix. `handleRowClick`/`handleDisconnect`/`handleReconnect` close over
 * several other per-render closures in `ConnectionsTree` (`filterFolds`,
 * `setCollapsed`, `matchCounts`, …) that are not themselves memoized, so a
 * `useCallback` for any of them would either go stale (an incomplete
 * dependency array silently calling last render's `matchCounts`) or gain no
 * stability at all (an exhaustive one, since most of those deps change
 * often) — a ref sidesteps the question entirely: it's rebuilt fresh every
 * `ConnectionsTree` render like the handlers themselves, but the REF OBJECT
 * `ConnectionTreeRow` receives never changes identity, so its `memo()` never
 * sees it as a changed prop.
 */

import { memo, type MutableRefObject, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  ChevronRight,
  ListFilter,
  Plug,
  PlugZap,
  RotateCw,
} from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { DriverBadge } from "@/components/common/DriverBadge";
import { VanishedOriginMark } from "@/components/common/VanishedOriginNotice";
import { ConnectionActionsMenu } from "@/components/connection/ConnectionActionsMenu";
import { cn } from "@/lib/utils";
import type {
  ConnectionMatchSummary,
  RowMatchState,
} from "@/lib/schema/treeMatches";
import type { ConnectionProfile } from "@/types";

export interface ConnectionRowActions {
  onRowClick: (p: ConnectionProfile) => void;
  onDisconnect: (p: ConnectionProfile) => void;
  onReconnect: (p: ConnectionProfile) => void;
  onNarrowToConnection: (connectionId: string) => void;
  moveRowFocus: (from: HTMLElement | null, delta: 1 | -1) => boolean;
}

interface ConnectionTreeRowProps {
  profile: ConnectionProfile;
  isActive: boolean;
  isBusy: boolean;
  isExpanded: boolean;
  isDisconnecting: boolean;
  isSelected: boolean;
  isScopeTarget: boolean;
  filtering: boolean;
  lostMessage: string | undefined;
  /** Open, but the profile was edited since: still on the old target. */
  edited: boolean;
  summary: ConnectionMatchSummary | undefined;
  matchState: RowMatchState | null;
  actionsRef: MutableRefObject<ConnectionRowActions>;
}

export const ConnectionTreeRow = memo(function ConnectionTreeRow({
  profile: p,
  isActive,
  isBusy,
  isExpanded: expanded,
  isDisconnecting,
  isSelected,
  isScopeTarget,
  filtering,
  lostMessage,
  edited,
  summary,
  matchState,
  actionsRef,
}: ConnectionTreeRowProps) {
  const { t } = useTranslation();
  const isLost = !!lostMessage;
  // Lost outranks edited: a dead pool needs the reconnect for a better reason.
  const isEdited = !isLost && edited && isActive;
  // Dimmed, never hidden: a connection row is what the user needs in order to
  // connect it or to narrow the search to it, so the filter may quieten it
  // but must not take it away.
  //
  // `failed` is deliberately absent from this list, as it is from
  // `filterFoldsIgnoringOverride`: a connection the server would not answer is
  // the row the user most needs to see, and quietening it is how the failure
  // used to leave the screen entirely (ADR #68).
  const dimmedByFilter =
    filtering &&
    isActive &&
    (matchState === "none" || matchState === "out-of-scope");

  return (
    <ConnectionActionsMenu
      connectionId={p.id}
      onConnect={() => actionsRef.current.onRowClick(p)}
      onDisconnect={() => actionsRef.current.onDisconnect(p)}
    >
      <div
        role="button"
        tabIndex={0}
        data-tree-row
        onClick={() => actionsRef.current.onRowClick(p)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            actionsRef.current.onRowClick(p);
            return;
          }
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            if (
              actionsRef.current.moveRowFocus(
                e.currentTarget,
                e.key === "ArrowDown" ? 1 : -1,
              )
            ) {
              e.preventDefault();
            }
          }
        }}
        title={
          isLost
            ? t("connections.lost", { message: lostMessage })
            : isEdited
              ? t("connections.edited")
              : p.name
        }
        className={cn(
          "group flex cursor-pointer items-center gap-2 rounded-md py-1.5 pl-2 pr-2 text-sm outline-none transition-colors duration-150 hover:bg-accent focus-visible:ring-2 focus-visible:ring-brand/40",
          isLost && "bg-destructive/10",
          isEdited && "bg-warning/10",
          dimmedByFilter && "opacity-55 hover:opacity-100",
          // Selected connection: the same brand rail the active table row
          // carries in `SchemaTableRow`, so "this is the one you're in"
          // reads identically at both levels of the tree, plus a hairline
          // blue edge as the card's quiet version of an active border.
          !isLost &&
            !isEdited &&
            isSelected &&
            "bg-brand/10 ring-1 ring-inset ring-brand/25 shadow-[inset_2px_0_0_var(--brand)]",
        )}
      >
        {isBusy ? (
          <Spinner size="sm" className="shrink-0 text-muted-foreground" />
        ) : expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        {/* Identity glyph: the driver's brand mark now leads the row —
            something recognisable at a glance beats a plain bullet — with
            live/idle/lost folded into a small corner dot instead of a
            separate one. Same brand/destructive vocabulary the status bar
            uses, just relocated onto the icon. */}
        <span className="relative inline-flex shrink-0">
          <DriverBadge driver={p.driver} />
          <span
            className={cn(
              "absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full ring-2 ring-background",
              isLost
                ? "bg-destructive"
                : isEdited
                  ? "bg-warning"
                  : isActive
                    ? "bg-brand"
                    : "bg-muted-foreground/40",
            )}
          />
        </span>
        <span
          className={cn(
            "flex-1 truncate",
            isSelected && "font-semibold",
            !isActive && "text-muted-foreground",
          )}
        >
          {p.name}
        </span>
        {/* One of the three explicit ways into a scope (the others are this
            row's context menu and a database row's). Offered only while
            something is typed: narrowing an empty search would leave a chip
            with nothing to modify. */}
        {filtering && isActive && !isScopeTarget && (
          <button
            type="button"
            title={t("connectionsTree.filter.scopeHere")}
            aria-label={t("connectionsTree.filter.scopeHere")}
            className="shrink-0 rounded-sm p-0.5 text-muted-foreground opacity-0 transition-colors hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
            onClick={(e) => {
              e.stopPropagation();
              actionsRef.current.onNarrowToConnection(p.id);
            }}
          >
            <ListFilter className="h-3 w-3" />
          </button>
        )}
        {filtering && (
          <MatchBadge
            isActive={isActive}
            count={summary?.count ?? 0}
            cold={summary?.coldDatabases.length ?? 0}
            failed={summary?.failedDatabases.length ?? 0}
            failure={summary?.failed ?? null}
            state={matchState}
          />
        )}
        <VanishedOriginMark profileId={p.id} />
        {isLost || isEdited ? (
          <button
            type="button"
            title={t(
              isLost
                ? "connections.reconnectTooltip"
                : "connections.editedTooltip",
            )}
            className={cn(
              "flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-0.5 text-2xs font-medium transition-colors",
              isLost
                ? "text-destructive hover:bg-destructive/20"
                : "text-warning hover:bg-warning/20",
            )}
            onClick={(e) => {
              e.stopPropagation();
              actionsRef.current.onReconnect(p);
            }}
          >
            <RotateCw className="h-3 w-3" />
            {t("connections.reconnect")}
          </button>
        ) : isActive ? (
          <button
            type="button"
            title={t("statusBar.disconnect")}
            disabled={isDisconnecting}
            // Hidden until hover/focus so a long list of live connections
            // isn't a wall of buttons, but always shown for the focused row
            // — and for one that is mid-teardown, which is the whole point
            // of showing that state at all.
            className={cn(
              "shrink-0 rounded-sm p-0.5 text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive group-hover:opacity-100",
              isSelected || isDisconnecting ? "opacity-100" : "opacity-0",
            )}
            onClick={(e) => {
              e.stopPropagation();
              actionsRef.current.onDisconnect(p);
            }}
          >
            {/* `PlugZap`, the same mark the header's "disconnect all"
                carries, not an ✕: an ✕ on a row reads as "remove this
                connection", which is a different and much worse action
                than closing its pool. */}
            {isDisconnecting ? (
              <Spinner size="sm" />
            ) : (
              <PlugZap className="h-3.5 w-3.5" />
            )}
          </button>
        ) : (
          <Plug className="h-3 w-3 shrink-0 text-muted-foreground/40 opacity-0 transition-opacity group-hover:opacity-100" />
        )}
      </div>
    </ConnectionActionsMenu>
  );
});

/**
 * The per-connection match count, shown while something is typed.
 *
 * The states it can render are the point of it. A connection that is not
 * connected has not been searched at all; one still fetching its own list is
 * counting; one whose read *failed* says so rather than reporting what it did
 * not find; a multi-DB server whose databases have never been read has looked
 * at *some* of itself and says so with a `+` (or a bare `—` when it has found
 * nothing yet). Only the last case — everything visible loaded, nothing matched
 * — earns a plain `0`. Saying `0` about something nobody has read, or about
 * something that would not answer, is what makes a user abandon a search that
 * would have worked.
 */
function MatchBadge({
  isActive,
  count,
  cold,
  failed,
  failure,
  state,
}: {
  isActive: boolean;
  count: number;
  cold: number;
  /** Databases of this connection whose own read failed. */
  failed: number;
  /** The connection's own failure message, when it has one. */
  failure: string | null;
  state: RowMatchState | null;
}) {
  const { t } = useTranslation();
  const base = "shrink-0 rounded-sm px-1 text-3xs leading-4 tabular-nums";
  const muted = cn(base, "bg-muted text-muted-foreground/60");

  // One `SimpleTooltip` around one span, rather than a native `title=` per
  // arm. Every arm here is an *explanation of a state the glyph cannot carry*
  // — "—" means four different things across these branches — so the label is
  // the whole point of the badge and an OS tooltip is the wrong vehicle for it:
  // no styling, no theme, and a delay the app does not control. This is the
  // pass ROADMAP's adoption-debt entry asks for on this file, and it is what
  // kept the new `failed` arm from adding a ninth OS tooltip to it.
  const label = (): ReactNode => {
    if (!isActive) return t("connectionsTree.filter.connectToSearch");
    switch (state) {
      case "out-of-scope":
        return t("connectionsTree.filter.clearScope");
      case "pending":
        return t("connectionsTree.filter.counting");
      case "failed":
        return (
          failure ??
          t("connectionsTree.filter.failedDatabases", { count: failed })
        );
      case "unloaded":
        return t("connectionsTree.filter.partialCount", { count: 0, cold });
      default:
        if (failed > 0)
          return t("connectionsTree.filter.partialFailed", { count, failed });
        if (cold > 0)
          return t("connectionsTree.filter.partialCount", { count, cold });
        return null;
    }
  };

  const body = (): { className: string; content: ReactNode } => {
    // Not connected, or out of scope: this connection was never searched, and
    // saying it found nothing would send the user off to fix a needle that is
    // not the problem.
    if (!isActive || state === "out-of-scope")
      return { className: muted, content: "—" };
    if (state === "pending") return { className: muted, content: "…" };
    // Asked and refused, which is a different fact from finding nothing — so
    // never a `0`, and never the muted treatment. The row also stays unfolded
    // and undimmed in this state; see `rowMatchState`.
    if (state === "failed")
      return {
        className: cn(base, "bg-destructive/15 text-destructive"),
        content: "!",
      };
    // Looked at some of itself and found nothing yet: a bare "—", because the
    // databases nobody has read have no evidence for a zero.
    if (state === "unloaded") return { className: muted, content: "—" };
    // A count that is real but possibly incomplete, for either reason:
    // databases nobody has read, or databases that would not answer.
    const partial = cold > 0 || failed > 0;
    return {
      className: cn(base, count > 0 ? "bg-brand/15 text-brand" : muted),
      content: (
        <>
          {count}
          {partial && "+"}
        </>
      ),
    };
  };

  const { className, content } = body();
  // `SimpleTooltip` renders its children untouched when the label is empty, so
  // the one state with nothing to explain — a complete count — costs nothing.
  return (
    <SimpleTooltip label={label()}>
      <span className={className}>{content}</span>
    </SimpleTooltip>
  );
}
