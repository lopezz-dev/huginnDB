/**
 * The Schema panel's top two levels: folder → connection (#107).
 *
 * Before this, the panel showed the schema of whichever connection was selected
 * elsewhere, so browsing a second server meant leaving the tree to pick it from
 * a menu. Now every saved connection is a row here, grouped by its folder, and
 * expanding one renders its existing schema subtree underneath — database →
 * tables for a multi-DB connection, schema → tables for a single-DB one.
 *
 * Two things are reused rather than reinvented. Folders come from
 * `bucketByGroup` + `useConnectionGroupCollapse`, the same pair the File menu,
 * the connections manager dialog and the status bar use, so the initial fold
 * state and the `connectionGroupExpandMode` preference behave identically in
 * all of them — but each surface keeps its own session-local overrides after
 * that, so folding a folder in the connections manager while this tree is
 * open no longer folds it here too. Expanding one draws its schema subtree
 * underneath — and since ADR #108 the whole panel, folders to columns, is one
 * flat virtualised list (`buildFlatTree` → `FlatTreeRow`), so only the rows
 * near the viewport are mounted however large a schema is. The connection
 * row's right-click menu is [[ConnectionActionsMenu]], its neighbour here.
 *
 * Expansion defaults to "expanded when connected" and only the user's folds are
 * stored (`LaunchState.collapsedConnections`, per environment). Keeping the
 * default derived rather than persisted is what stops the tree from ever claiming
 * a row is open over a subtree that doesn't exist: a remembered fold can only
 * ever mean "show this folded when it comes back".
 *
 * **This file owns the search.** The filter box used to hand a raw string down
 * to whichever connection happened to be selected and `""` to every other one,
 * so with two connections open one filtered and the other did not, and nothing
 * on screen said why — the only marker of "selected" is a hairline on the row,
 * and the selection moves on its own when a tab opens. Now the needle is
 * committed once (`useTreeSearch`), counted once against every live connection
 * (`useTreeMatchCounts`), and what travels down to the explorers is the parsed
 * `patterns` array plus that connection's already-computed summary. A row with
 * no matches folds to one dimmed line with a `0` badge instead of silently
 * showing its whole tree.
 *
 * The fold a filter causes is **visual and ephemeral**: it never touches
 * `collapsedConnections`, because that set goes through `persistLaunchState`
 * and a search would otherwise leave permanent folds the user never asked for.
 * The chevron still works, as a session-local override for as long as the
 * filter lasts.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useTranslation } from "react-i18next";
import { DatabaseBackup, DatabaseZap, ListFilter, PlugZap } from "lucide-react";
import { SearchField } from "@/components/ui/search-field";
import { MICRO_HEADING } from "@/components/ui/styles";
import { IconButton } from "@/components/ui/icon-button";
import { Spinner } from "@/components/ui/spinner";
import { Checkbox } from "@/components/ui/checkbox";
import { useConnections } from "@/stores/session/connections";
import { useConnectionHealth } from "@/stores/session/connectionHealth";
import { useUi } from "@/stores/session/ui";
import { useConnectionGroupCollapse } from "@/lib/connection/useConnectionGroups";
import { resolveVisibleDatabases } from "@/lib/connection/visibleDatabases";
import { isServerWide } from "@/lib/connectionLabel";
import {
  useLoadingConnectionIds,
  useTreeMatchCounts,
} from "@/lib/schema/useTreeMatchCounts";
import { rowMatchState, totalMatches } from "@/lib/schema/treeMatches";
import { buildFlatTree, type FlatRow } from "@/lib/schema/flatTree";
import { useOpenTableKeys } from "@/lib/schema/useOpenTableKeys";
import { useSchemaTreeNeeds } from "@/lib/schema/useSchemaTreeNeeds";
import { warmForSearch } from "@/lib/schema/warmForSearch";
import { scopeLabel } from "@/lib/schema/filterScope";
import { useTreeSearch } from "@/stores/session/treeSearch";
import { useSchema } from "@/stores/session/schema";
import { useDatabaseViews } from "@/stores/session/databaseViews";
import { useOriginSync } from "@/stores/sync/originSync";
import { usePreferences } from "@/stores/preferences/preferences";
import {
  connectAndWarm,
  disconnectAll,
  disconnectAndClean,
} from "@/lib/connection/connectFlow";
import { persistLaunchState } from "@/stores/session/persistedTabs";
import { isTooManyConnections } from "@/lib/db/driver";
import { notify } from "@/lib/notify";
import { api } from "@/lib/tauri";
import { bucketByGroup, cn } from "@/lib/utils";
import { DriverBadge } from "@/components/common/DriverBadge";
import { EmptyState } from "@/components/common/EmptyState";
import { Button } from "@/components/ui/button";
import { SimpleTooltip } from "@/components/ui/tooltip";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DialogActions } from "@/components/ui/dialog-actions";
import {
  ScopeChip,
  TreeFilterBox,
} from "@/components/connection/TreeFilterBox";
import {
  ConnectionTreeRow,
  type ConnectionRowActions,
} from "@/components/connection/ConnectionTreeRow";
import { FlatTreeRow } from "@/components/connection/FlatTreeRow";
import { SchemaTreeDialogs } from "@/components/schema/dialogs/SchemaTreeDialogs";
import type { TreeConnectionInput } from "@/lib/schema/treeMatches";
import type { ConnectionProfile } from "@/types";

export function ConnectionsTree() {
  const { t } = useTranslation();
  const profiles = useConnections((s) => s.profiles);
  const active = useConnections((s) => s.active);
  const lostConnections = useConnectionHealth((s) => s.lost);
  const editedConnections = useConnectionHealth((s) => s.edited);
  // Ids currently fetching their schema, so a row can show that even while
  // collapsed — the explorer's spinning refresh button carried that signal
  // before its icon strip moved to the context menu. Narrowed to a
  // `Set<string>` (`useLoadingConnectionIds`, next to `useTreeMatchCounts`)
  // rather than the raw `byConnection` map: reading the whole map here made
  // this the tree's SECOND wide subscription to it (on top of
  // `useTreeMatchCounts`'s own), so any schema write anywhere re-rendered
  // every row regardless of whether its own loading state had changed.
  // The tree's one wide subscription to the schema map: the match counts, the
  // row spinner and the flattened rows all derive from this single read (see
  // `useTreeMatchCounts`).
  const byConnection = useSchema((s) => s.byConnection);
  const loadingConnectionIds = useLoadingConnectionIds(byConnection);
  const selected = useUi((s) => s.selectedConnectionId);
  const setSelected = useUi((s) => s.setSelectedConnectionId);
  // The folded set (see `useUi`): a row follows its pool unless the user said
  // otherwise, so only the overrides are tracked — and only the collapsing ones,
  // since "expanded" is already the default for a live connection.
  const collapsed = useUi((s) => s.collapsedConnections);
  const setConnectionCollapsed = useUi((s) => s.setConnectionCollapsed);
  // One filter box for the whole tree, searching every live connection at
  // once. `needle`/`patterns`/`scope` are the COMMITTED, debounced state the
  // subtrees below filter by — the raw, per-keystroke text and its debounce
  // now live entirely inside `TreeFilterBox` (see its own doc comment), so
  // this component only re-renders once per debounce fire instead of once
  // per keystroke.
  const needle = useTreeSearch((s) => s.needle);
  const patterns = useTreeSearch((s) => s.patterns);
  const scope = useTreeSearch((s) => s.scope);
  const narrowTo = useTreeSearch((s) => s.narrowTo);
  const clearScope = useTreeSearch((s) => s.clearScope);
  const requestFocus = useTreeSearch((s) => s.requestFocus);
  const groupCollapse = useConnectionGroupCollapse();
  const filterInputRef = useRef<HTMLInputElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const filtering = needle.length > 0;

  /**
   * Arrow-key movement between the box and the connection rows.
   *
   * Deliberately a local `onKeyDown` rather than three more catalogue actions:
   * these are a widget's internal navigation, like the arrows inside a
   * `<select>`, and putting them in Settings would invite someone to rebind
   * "move down" globally.
   *
   * Walks the flat row list rather than the DOM. It used to collect
   * `[data-tree-row]` with `querySelectorAll`, which only works while every
   * row is mounted — and the tree is virtualised now (ADR #108), so the next
   * connection can be ten thousand tables away and not in the DOM at all. The
   * target is scrolled into the window first and focused once it renders.
   */
  function moveRowFocus(from: HTMLElement | null, delta: 1 | -1): boolean {
    const rows = flatRef.current;
    const item = from?.closest<HTMLElement>("[data-index]");
    const current = item ? Number(item.dataset.index) : -1;
    let next = -1;
    if (delta === 1) {
      next = rows.findIndex((r, i) => i > current && r.kind === "connection");
    } else {
      for (let i = Math.min(current, rows.length) - 1; i >= 0; i -= 1) {
        if (rows[i].kind === "connection") {
          next = i;
          break;
        }
      }
    }
    if (next < 0) {
      if (delta === 1) return false;
      // Up from the first row goes back to where the search is typed.
      filterInputRef.current?.focus();
      return true;
    }
    focusRowAt(next);
    return true;
  }

  /** Bring row `index` into the window and focus its `[data-tree-row]` once
   *  the virtualiser has rendered it — a few frames at most. */
  function focusRowAt(index: number) {
    virtualizerRef.current?.scrollToIndex(index, { align: "auto" });
    let attempts = 10;
    const tryFocus = () => {
      const el = rowsRef.current?.querySelector<HTMLElement>(
        `[data-index="${index}"] [data-tree-row]`,
      );
      if (el) el.focus();
      else if (attempts-- > 0) requestAnimationFrame(tryFocus);
    };
    tryFocus();
  }

  // DataGrip-style subset of connections to show, one level up from the
  // per-connection database subset (`useVisibleDatabases`).
  // Lives in `useUi`, persisted per environment via
  // `LaunchState.visibleConnections` — not in prefs, so switching environments
  // doesn't drag one's filter into another's tree. The level below now resolves
  // the same way, through a per-environment override on top of the profile's
  // `visible_databases`.
  const visibleConnectionIds = useUi((s) => s.visibleConnections);
  const visibleSet = useMemo(
    () =>
      visibleConnectionIds && visibleConnectionIds.length > 0
        ? new Set(visibleConnectionIds)
        : null,
    [visibleConnectionIds],
  );
  const [visibilityPickerOpen, setVisibilityPickerOpen] = useState(false);

  // Reference-stable inputs, derived here rather than in the selector (gotcha #1).
  const visibleProfiles = useMemo(
    () => profiles.filter((p) => !visibleSet || visibleSet.has(p.id)),
    [profiles, visibleSet],
  );
  const buckets = useMemo(
    () => bucketByGroup(visibleProfiles),
    [visibleProfiles],
  );

  // Inputs for the match counter: only *live* connections, since an idle one has
  // nothing to search and its row says so instead of showing a misleading `0`.
  // The visible-databases subset is resolved through the pure
  // `resolveVisibleDatabases` rather than `useVisibleDatabases`, which cannot be
  // called in a loop (Rules of Hooks) — that split is exactly why the pure
  // function exists.
  const databaseVisibility = useUi((s) => s.databaseVisibility);
  const treeConnections = useMemo<TreeConnectionInput[]>(
    () =>
      visibleProfiles
        .filter((p) => active.has(p.id))
        .map((p) => ({
          connectionId: p.id,
          multiDb: isServerWide(p),
          visibleDatabases: resolveVisibleDatabases(
            databaseVisibility[p.id],
            p.visible_databases,
          ),
        })),
    [visibleProfiles, active, databaseVisibility],
  );
  const matchCounts = useTreeMatchCounts(
    treeConnections,
    byConnection,
    patterns,
    scope,
  );
  const totals = useMemo(
    () => totalMatches(matchCounts.values()),
    [matchCounts],
  );

  /**
   * A scope whose connection left the tree is dropped automatically.
   *
   * Without this the box keeps a chip naming a connection that is no longer
   * there and every search silently returns nothing — which is the implicit
   * scope's original failure mode with a label stuck on it. "Left the tree"
   * covers both disconnecting and being filtered out of the environment's
   * visible subset.
   */
  useEffect(() => {
    useTreeSearch
      .getState()
      .pruneScopeAgainst(
        (id) => active.has(id) && (!visibleSet || visibleSet.has(id)),
      );
  }, [active, visibleSet]);

  const scopeProfile = useMemo(
    () =>
      scope.kind === "all"
        ? null
        : profiles.find((p) => p.id === scope.connectionId),
    [profiles, scope],
  );

  /**
   * Reach the databases the search has not read.
   *
   * Typing does not do this and must not: every database view is a whole
   * connection pool, and a fan-out driven by a keystroke is what made a
   * nineteen-database server exhaust its own connection limit (1.13.0). So the
   * cost is a button, and the button says how much it will cost.
   *
   * `warmForSearch` walks the connections one at a time and bounds each to
   * `DB_VIEW_WARM_CONCURRENCY`; the counts fill in on their own as each child
   * slice lands, because that is what invalidates the memo above.
   */
  const [warming, setWarming] = useState(false);
  const limitReached = useTreeSearch((s) => s.limitReached);
  const setLimitReached = useTreeSearch((s) => s.setLimitReached);
  async function handleWarmForSearch() {
    if (warming) return;
    const targets = Array.from(matchCounts.values())
      .filter((s) => s.coldDatabases.length > 0)
      .map((s) => ({ parentId: s.connectionId, databases: s.coldDatabases }));
    if (targets.length === 0) return;
    setWarming(true);
    try {
      const result = await warmForSearch(targets);
      if (result.limitError) {
        // The one failure the user can act on. Everything still queued would be
        // refused identically, so the offer to warm is withdrawn until they
        // free something up — reusing the toast the explorer's own prefetch
        // used to raise from inside a keystroke.
        setLimitReached(true);
        notify.error(String(result.limitError), {
          actions: [
            {
              label: t("schema.releaseIdlePools"),
              variant: "primary",
              onClick: () => {
                void api
                  .releaseIdlePools()
                  .then((closed) => {
                    notify.success(
                      t("schema.releasedIdlePools", { count: closed }),
                    );
                    setLimitReached(false);
                  })
                  .catch((err) => notify.error(String(err)));
              },
            },
          ],
        });
      } else if (result.skipped > 0) {
        // Not a limit refusal, so nothing here is going to be retried by
        // releasing pools: some databases simply would not answer. Reported
        // once for the whole fan-out — `warmDatabases` stays quiet precisely so
        // this can be one card instead of nineteen — and with the first real
        // error, which used to be discarded entirely.
        notify.warning(
          t("connectionsTree.filter.warmPartial", {
            count: result.loaded,
            skipped: result.skipped,
          }),
          {
            description: result.firstError
              ? String(result.firstError)
              : undefined,
          },
        );
      }
    } catch (e) {
      if (isTooManyConnections(e)) setLimitReached(true);
      notify.error(String(e));
    } finally {
      setWarming(false);
    }
  }

  /**
   * Connections the user re-opened by hand while the filter had folded them.
   *
   * Deliberately component-local and not `collapsedConnections`: that set is
   * persisted through `persistLaunchState`, so recording a search's folds there
   * would leave the user with permanent folds they never chose. Dropped as soon
   * as the filter is gone, which is also when the automatic folds disappear.
   */
  const [foldOverrides, setFoldOverrides] = useState<Set<string>>(
    () => new Set(),
  );
  useEffect(() => {
    if (!filtering)
      setFoldOverrides((prev) => (prev.size === 0 ? prev : new Set()));
  }, [filtering]);

  /**
   * Ids currently connecting, so their row can show a spinner and refuse a
   * second click — shared with `useConnections` rather than local state,
   * because the environment switch's background reconnect calls the same
   * `connect()` this tree's own click handler does, and both need to land in
   * the same place for a row to show "connecting…" regardless of which one
   * kicked it off.
   */
  const connectingIds = useConnections((s) => s.connecting);

  /**
   * Has the filter folded this row to a single line?
   *
   * Only a *real* zero folds — a connection still loading, or a multi-DB server
   * whose databases have never been read, has no evidence for one (see
   * `rowMatchState`). Folding on a provisional zero is how a user concludes the
   * search failed and gives up on it.
   */
  function filterFolds(id: string): boolean {
    if (!filtering || foldOverrides.has(id)) return false;
    return filterFoldsIgnoringOverride(id);
  }

  function toggleFoldOverride(id: string) {
    setFoldOverrides((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const isExpanded = (p: ConnectionProfile) =>
    active.has(p.id) && !collapsed.includes(p.id) && !filterFolds(p.id);

  /**
   * Fold or unfold, and persist it. `persistLaunchState` is otherwise only called
   * on connect/disconnect and at graceful close, so without this a fold made just
   * before an abrupt exit would be lost — the same "keep it roughly fresh"
   * reasoning the connect/disconnect calls already document.
   */
  function setCollapsed(id: string, value: boolean) {
    setConnectionCollapsed(id, value);
    void persistLaunchState(Array.from(useConnections.getState().active));
  }

  /**
   * A row click both focuses the connection (tabs and the query editor follow
   * `selectedConnectionId`) and opens it. An idle connection connects first —
   * clicking a connection you can see and getting nothing would be the more
   * surprising behaviour.
   */
  async function handleRowClick(p: ConnectionProfile) {
    if (connectingIds.has(p.id)) return;
    if (!active.has(p.id)) {
      const ok = await connectAndWarm(p.id);
      if (!ok) return;
      setSelected(p.id);
      // Connecting unfolds: the click that opened it asked to see inside.
      setCollapsed(p.id, false);
      return;
    }
    setSelected(p.id);
    // While the filter has this row folded for having nothing to show, the
    // chevron toggles a session-local override instead of a persisted fold:
    // the user is peeking inside a connection the search dismissed, which is
    // not a statement about how they want the tree to look next launch.
    if (filtering && filterFoldsIgnoringOverride(p.id)) {
      toggleFoldOverride(p.id);
      return;
    }
    setCollapsed(p.id, isExpanded(p));
  }

  /**
   * `filterFolds`, blind to the override — "would the filter fold this?"
   *
   * `failed` is not in this list, and that is the point: folding a connection
   * whose schema read failed took the inline error message off the screen,
   * leaving a dimmed row with a confident `0` and no way to find out why. See
   * ADR #68.
   */
  function filterFoldsIgnoringOverride(id: string): boolean {
    const summary = matchCounts.get(id);
    if (!summary) return false;
    const state = rowMatchState(summary);
    return state === "none" || state === "out-of-scope";
  }

  /**
   * Ids currently being torn down, so their row can say so.
   *
   * A set rather than a single id: nothing stops the user from starting a
   * second row's disconnect while the first is still closing, and closing a
   * pool is not instant — the backend closes every per-database view under it
   * in turn, each waiting up to five seconds on a server that has stopped
   * answering. That is the same wait the "disconnect all" button now reports;
   * one row's ✕ was the last affordance still silently ignoring the click.
   */
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

  async function handleDisconnect(p: ConnectionProfile) {
    if (disconnecting.has(p.id)) return;
    markDisconnecting(p.id, true);
    try {
      await disconnectAndClean(p.id);
    } finally {
      markDisconnecting(p.id, false);
    }
    if (selected === p.id) setSelected(null);
    // The fold is left in place deliberately: it can only mean "show folded when
    // this comes back", never "open over a subtree that isn't there".
  }

  /**
   * Tear down every live pool and clear the selected connection. Lives here
   * (rather than the File menu, where it used to sit next to the now-removed
   * connection list) since it's a bulk action over exactly what this tree shows.
   *
   * The loop this used to run awaited one connection before starting the next,
   * on top of a backend that already closes each connection's per-database
   * pools one at a time — every one of them up to a 5s timeout on a server
   * that has stopped answering. Four nested serial layers is what made the
   * button feel like it had hung. `disconnectAll` runs the connections
   * concurrently, and is shared with the keyboard shortcut, which used to be a
   * second, faster, *lossier* implementation of the same command.
   */
  const [disconnectingAll, setDisconnectingAll] = useState(false);
  async function handleDisconnectAll() {
    if (disconnectingAll) return;
    setDisconnectingAll(true);
    try {
      await disconnectAll();
    } finally {
      setDisconnectingAll(false);
    }
    setSelected(null);
  }

  /** Tear the dead pool down and reopen it, mirroring the status bar's affordance. */
  async function handleReconnect(p: ConnectionProfile) {
    try {
      await useConnections.getState().disconnect(p.id);
    } catch {
      // Already dead; reconnect regardless.
    }
    const ok = await connectAndWarm(p.id);
    if (ok) setSelected(p.id);
  }

  /**
   * The four callbacks `ConnectionTreeRow` needs, mirrored through a ref —
   * see `ConnectionTreeRow`'s own doc comment for why a ref instead of
   * `useCallback`. Rebuilt every render (cheap: it's a five-property object,
   * not the several-thousand-closures cost this pattern guards against
   * elsewhere), but the REF itself never changes identity.
   */
  const rowActionsRef = useRef<ConnectionRowActions>({
    onRowClick: (p) => void handleRowClick(p),
    onDisconnect: (p) => void handleDisconnect(p),
    onReconnect: (p) => void handleReconnect(p),
    onNarrowToConnection: (connectionId) => {
      narrowTo({ kind: "connection", connectionId });
      requestFocus();
    },
    moveRowFocus,
  });
  rowActionsRef.current = {
    onRowClick: (p) => void handleRowClick(p),
    onDisconnect: (p) => void handleDisconnect(p),
    onReconnect: (p) => void handleReconnect(p),
    onNarrowToConnection: (connectionId) => {
      narrowTo({ kind: "connection", connectionId });
      requestFocus();
    },
    moveRowFocus,
  };

  function renderConnectionRow(p: ConnectionProfile) {
    const isActive = active.has(p.id);
    const lostMessage = lostConnections[p.id];
    const summary = matchCounts.get(p.id);
    return (
      <ConnectionTreeRow
        key={p.id}
        profile={p}
        isActive={isActive}
        isBusy={connectingIds.has(p.id) || loadingConnectionIds.has(p.id)}
        isExpanded={isExpanded(p)}
        isDisconnecting={disconnecting.has(p.id)}
        isSelected={selected === p.id}
        isScopeTarget={scope.kind !== "all" && scope.connectionId === p.id}
        filtering={filtering}
        lostMessage={lostMessage}
        edited={!!editedConnections[p.id]}
        summary={summary}
        matchState={summary ? rowMatchState(summary) : null}
        actionsRef={rowActionsRef}
      />
    );
  }

  // Everything `buildFlatTree` reads besides the schema map, each read the way
  // gotcha #1 requires: the stored reference, never a derived object.
  const vanishedById = useOriginSync((s) => s.vanished);
  const vanished = useMemo(
    () => new Set(Object.keys(vanishedById)),
    [vanishedById],
  );
  const views = useDatabaseViews((s) => s.byId);
  const activeDatabaseByConnection = useUi(
    (s) => s.activeDatabaseByConnection,
  );
  const isGroupCollapsed = groupCollapse.isCollapsed;

  /**
   * The whole tree as rows (ADR #108).
   *
   * Rebuilt whenever anything it shows changes — any schema write, any fold —
   * which is cheap next to what it replaced: walking ten thousand table
   * objects is a millisecond, mounting ten thousand `TableRow`s was the
   * freeze. The grouping inside is memoised per `(tables, patterns)`, so a
   * column load anywhere regroups nothing.
   */
  const flat = useMemo(
    () =>
      buildFlatTree({
        buckets,
        allHidden: profiles.length > 0 && visibleProfiles.length === 0,
        isGroupCollapsed,
        // `isExpanded` closes over this render's folds and match counts; every
        // one of its inputs is in the dependency list below.
        isConnectionExpanded: isExpanded,
        active,
        vanished,
        byConnection,
        patterns,
        scope,
        matchCounts,
        visibleDatabases: (p) =>
          resolveVisibleDatabases(databaseVisibility[p.id], p.visible_databases),
        subsetIsLocal: (id) => databaseVisibility[id] !== undefined,
        activeDatabaseByConnection,
        views,
      }),
    [
      buckets,
      profiles.length,
      visibleProfiles.length,
      isGroupCollapsed,
      active,
      collapsed,
      filtering,
      foldOverrides,
      matchCounts,
      vanished,
      byConnection,
      patterns,
      scope,
      databaseVisibility,
      activeDatabaseByConnection,
      views,
    ],
  );
  useSchemaTreeNeeds(flat.needs);
  const flatRef = useRef<FlatRow[]>(flat.rows);
  flatRef.current = flat.rows;

  const virtualizer = useVirtualizer({
    count: flat.rows.length,
    getScrollElement: () => rowsRef.current,
    estimateSize: (i) => estimateRowHeight(flat.rows[i]),
    getItemKey: (i) => flat.rows[i].key,
    // The `py-1.5` the scroll container used to carry, as the virtualiser's
    // own padding so the first and last rows keep it.
    paddingStart: 6,
    paddingEnd: 6,
    overscan: 12,
  });
  const virtualizerRef = useRef(virtualizer);
  virtualizerRef.current = virtualizer;

  const metric = usePreferences((s) => s.prefs.ui.schemaTableMetric);
  const openKeys = useOpenTableKeys();
  if (profiles.length === 0) {
    return <EmptyState icon={DatabaseZap} title={t("connectionsTree.empty")} />;
  }

  return (
    // The whole panel is the `tree` keybinding scope — the filter box and the
    // connection rows included. It used to be declared inside `SchemaExplorer`,
    // which covered only an expanded connection's subtree, so Escape-to-clear
    // could not fire from the box it clears.
    <div className="flex h-full flex-col" data-kb-scope="tree">
      <div className="shrink-0 px-2 pb-1 pt-2">
        {/* The panel had no title and three stacked notice lines over a 28px
            input. The title comes back as a header row and the two tree-wide
            actions move into it as icons: they were labelled buttons that
            truncated to unreadable stumps at the widths this panel is actually
            dragged to, and the labels are now their tooltips. That pays for the
            vertical space the scope chip and the search summary need. */}
        <div className="mb-1.5 flex items-center gap-1">
          <span className={cn("flex-1 truncate", MICRO_HEADING)}>
            {t("panels.schema")}
          </span>
          {/* `tone="destructive"`: this drops every live pool in the tree, and
              as a hand-rolled button in the resting muted grey it read exactly
              like the filter button beside it. The tone shows the intent on
              hover only, so the header stays calm at rest — see `IconButton`.
              `loading` covers the rest: closing a pool through a tunnel or a
              pooler is a round trip per database, so this is not always
              instant, and the button says it is working instead of looking
              ignored. */}
          <IconButton
            icon={PlugZap}
            tone="destructive"
            label={t("menu.file.disconnectAll")}
            disabled={active.size === 0}
            loading={disconnectingAll}
            onClick={() => void handleDisconnectAll()}
            className="shrink-0"
          />
          {/* The "N of M connections" line folds into a brand dot on the icon
              that describes it — the subset is still announced, on the control
              that changes it, and its count is in the tooltip. */}
          <SimpleTooltip
            label={
              visibleSet
                ? `${t("connectionsTree.selectConnections.action")} — ${t(
                    "connectionsTree.selectConnections.subsetActive",
                    { count: visibleSet.size, total: profiles.length },
                  )}`
                : t("connectionsTree.selectConnections.action")
            }
          >
            {/* A `Button` rather than an `IconButton` only because of the dot:
                `IconButton` takes no children. Same shape and variant, so it
                still matches the disconnect button beside it. */}
            <Button
              type="button"
              variant="quiet"
              size="icon-sm"
              icon={ListFilter}
              onClick={() => setVisibilityPickerOpen(true)}
              aria-label={t("connectionsTree.selectConnections.action")}
              className={cn(
                "relative shrink-0",
                visibleSet && "text-brand hover:text-brand",
              )}
            >
              {visibleSet && (
                <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-brand ring-2 ring-background" />
              )}
            </Button>
          </SimpleTooltip>
        </div>
        <TreeFilterBox
          ref={filterInputRef}
          onArrowDown={() => moveRowFocus(null, 1)}
          placeholder={t("schema.filterPlaceholder")}
          clearLabel={t("connectionsTree.filter.clear")}
        />
        {/* The scope chip and the match summary share one wrapping row under the
            box. The chip used to sit *inside* the box, in front of the caret,
            which in the width this panel is normally docked at left about eight
            characters of input visible — see `TreeFilterBox`'s header. Out here
            it can name a connection and a database, and on a narrow panel it
            wraps onto its own line instead of taking the input's. */}
        {(filtering || (scope.kind !== "all" && scopeProfile)) && (
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs">
            {scope.kind !== "all" && scopeProfile && (
              <ScopeChip
                driver={scopeProfile.driver}
                label={scopeLabel(scope, scopeProfile.name)}
                title={
                  scope.kind === "database"
                    ? t("schema.filterScopedTo", { db: scope.database })
                    : t("schema.filterScopedToConnection", {
                        name: scopeProfile.name,
                      })
                }
                onClear={clearScope}
                clearLabel={t("connectionsTree.filter.clearScope")}
              />
            )}
            {/* The count is the only signal that the search reached a connection
                other than the one being looked at, so it is announced. The chip
                stays outside the live region: it is a control, not a status,
                and it would be read out on every keystroke. */}
            {filtering && (
              <span
                role="status"
                aria-live="polite"
                className="min-w-0 text-muted-foreground"
              >
                {totals.matches === 0 &&
                !totals.pending &&
                totals.cold === 0 ? (
                  <>
                    <span>{t("connectionsTree.filter.noMatchesAnywhere")}</span>{" "}
                    {/* The honest confession of what this filter actually looks
                        at. It has never searched columns, schemas or connection
                        names, and nothing on screen has ever said so. */}
                    <span className="text-muted-foreground/70">
                      {t("connectionsTree.filter.noMatchesHint")}
                    </span>
                  </>
                ) : scope.kind !== "all" ? (
                  // Scoped: the chip right next to this already names where, so
                  // repeating it here would be the same sentence twice on a line
                  // that has no width to spare.
                  t("connectionsTree.filter.summaryCount", {
                    matches: totals.matches,
                  })
                ) : (
                  t("connectionsTree.filter.summary", {
                    matches: totals.matches,
                    connections: totals.connections,
                  })
                )}
              </span>
            )}
          </div>
        )}
        {filtering && totals.cold > 0 && (
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-2xs">
            <span className="text-muted-foreground/70">
              {t("connectionsTree.filter.partialCount", {
                count: totals.matches,
                cold: totals.cold,
              })}
            </span>
            {!limitReached && (
              <button
                type="button"
                disabled={warming}
                onClick={() => void handleWarmForSearch()}
                title={t("connectionsTree.filter.searchUnloadedHint")}
                className="flex shrink-0 items-center gap-1 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-2xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60"
              >
                {warming ? (
                  <Spinner size="xs" className="shrink-0" />
                ) : (
                  <DatabaseBackup className="h-3 w-3 shrink-0 text-brand" />
                )}
                <span className="truncate">
                  {warming
                    ? t("connectionsTree.filter.searchingUnloaded")
                    : t("connectionsTree.filter.searchUnloaded", {
                        count: totals.cold,
                      })}
                </span>
              </button>
            )}
          </div>
        )}
        {/* Said on its own line rather than folded into the "left to search"
            one above, because the remedy is different: a cold database wants
            the warm button, one that would not answer wants a reconnect or a
            server that is up. Before this the failure had no line at all — the
            row it belonged to had been folded away (ADR #68). */}
        {filtering && totals.failed > 0 && (
          <div className="mt-1 text-2xs text-destructive/80">
            {t("connectionsTree.filter.failedConnections", {
              count: totals.failed,
            })}
          </div>
        )}
      </div>
      {/* One virtualised list for the whole tree (ADR #108): only the rows
          near the viewport are mounted, so a section with ten thousand tables
          costs what its visible thirty cost. Rows are measured as they
          render — most are a fixed ~24px, but notices and errors wrap. */}
      <div ref={rowsRef} className="flex-1 overflow-y-auto pr-1">
        <div
          className="relative w-full"
          style={{ height: virtualizer.getTotalSize() }}
        >
          {virtualizer.getVirtualItems().map((item) => (
            <div
              key={item.key}
              data-index={item.index}
              ref={virtualizer.measureElement}
              className="absolute left-0 top-0 w-full"
              style={{ transform: `translateY(${item.start}px)` }}
            >
              <FlatTreeRow
                row={flat.rows[item.index]}
                renderConnection={renderConnectionRow}
                onToggleGroup={groupCollapse.toggle}
                metric={metric}
                openKeys={openKeys}
              />
            </div>
          ))}
        </div>
      </div>
      <SchemaTreeDialogs />
      {visibilityPickerOpen && (
        <ConnectionVisibilityDialog
          profiles={profiles}
          selected={visibleConnectionIds ?? null}
          onClose={() => setVisibilityPickerOpen(false)}
        />
      )}
    </div>
  );
}

/**
 * A first guess at a row's height, before the virtualiser measures it.
 *
 * Only the guess: every rendered row is measured (`measureElement`), so a
 * wrong number costs a scrollbar that adjusts, never a wrong layout. Close
 * guesses matter for the rows that are never rendered — they are what the
 * total height, and so the scrollbar, is made of — which is why the two that
 * come in thousands (tables and columns) are the exact ~24px and ~22px they
 * measure.
 */
function estimateRowHeight(row: FlatRow | undefined): number {
  switch (row?.kind) {
    case "connection":
      return 32;
    case "group":
    case "database":
    case "bound-database":
    case "schema":
      return 28;
    case "section":
    case "indexes":
    case "table":
      return 24;
    case "column":
    case "columns-error":
      return 22;
    case "skeleton":
      return row.variant === "columns" ? 46 : 22 + row.rows * 12;
    case "no-databases":
      return 80;
    case "load-error":
      return 40;
    case "origin-notice":
      return 64;
    default:
      return 28;
  }
}

/**
 * DataGrip-style "choose which connections to show" picker, one level up
 * from `DatabaseVisibilityDialog`. Persisted per
 * environment via `LaunchState.visibleConnections` rather than on a profile,
 * since it spans every saved connection rather than one — and
 * rather than in global prefs, so the filter doesn't follow the user across
 * environments. "All selected" stores `null` so a newly-saved connection
 * stays visible by default. Save is disabled with nothing selected — an
 * empty subset would hide the whole tree, which is never what the user wants.
 */
function ConnectionVisibilityDialog({
  profiles,
  selected,
  onClose,
}: {
  profiles: ConnectionProfile[];
  /** The persisted subset of ids, or null when all are shown. */
  selected: string[] | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [sel, setSel] = useState<Set<string>>(
    () => new Set(selected ?? profiles.map((p) => p.id)),
  );
  const [filter, setFilter] = useState("");

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return profiles;
    return profiles.filter((p) => p.name.toLowerCase().includes(q));
  }, [profiles, filter]);

  const allFilteredSelected =
    filtered.length > 0 && filtered.every((p) => sel.has(p.id));

  const toggle = (id: string) => {
    setSel((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleAllFiltered = () =>
    setSel((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) {
        for (const p of filtered) next.delete(p.id);
      } else {
        for (const p of filtered) next.add(p.id);
      }
      return next;
    });

  const submit = () => {
    if (sel.size === 0) return;
    const chosen = profiles.filter((p) => sel.has(p.id)).map((p) => p.id);
    // "All" → null so a connection saved later stays visible automatically.
    const value = chosen.length === profiles.length ? null : chosen;
    useUi.getState().setVisibleConnections(value);
    void persistLaunchState(Array.from(useConnections.getState().active));
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent tier="panel">
        <DialogHeader>
          <DialogTitle>
            {t("connectionsTree.selectConnections.title")}
          </DialogTitle>
          <DialogDescription>
            {t("connectionsTree.selectConnections.description")}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="mb-1.5 flex items-center gap-1.5">
            <SearchField
              size="xs"
              value={filter}
              onValueChange={setFilter}
              placeholder={t(
                "connectionsTree.selectConnections.filterPlaceholder",
              )}
              className="flex-1"
              inputClassName="text-xs"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 shrink-0 px-2 text-2xs"
              disabled={filtered.length === 0}
              onClick={toggleAllFiltered}
            >
              {allFilteredSelected
                ? t("connectionsTree.selectConnections.deselectAll")
                : t("connectionsTree.selectConnections.selectAll")}
            </Button>
          </div>
          <div className="flex items-center justify-between pb-1">
            <span className="text-xs text-muted-foreground">
              {t("connectionsTree.selectConnections.count", {
                selected: sel.size,
                total: profiles.length,
              })}
            </span>
          </div>
          <div className="max-h-64 divide-y divide-border overflow-y-auto rounded-md border border-border">
            {filtered.length === 0 ? (
              <p className="px-3 py-2 text-xs text-muted-foreground">
                {t("connectionsTree.selectConnections.noMatches", {
                  query: filter,
                })}
              </p>
            ) : (
              filtered.map((p) => (
                <label
                  key={p.id}
                  className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-muted/50"
                >
                  <Checkbox
                    checked={sel.has(p.id)}
                    onChange={() => toggle(p.id)}
                  />
                  <span className="flex-1 truncate text-xs">{p.name}</span>
                  <DriverBadge driver={p.driver} />
                </label>
              ))
            )}
          </div>
        </DialogBody>
        <DialogActions
          onCancel={onClose}
          cancelLabel={t("common.cancel")}
          confirmLabel={t("common.save")}
          onConfirm={submit}
          confirmDisabled={sel.size === 0}
        />
      </DialogContent>
    </Dialog>
  );
}
