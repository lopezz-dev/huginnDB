/**
 * Editor-style workspace: a nested dockview instance whose panels are the
 * open table-data and query-editor tabs. Splitting and dragging a tab to
 * another group come for free from dockview. "Float in new window"
 * (`WorkspaceTab.detachToWindow`) is deliberately NOT dockview's
 * `addFloatingGroup` — that keeps the floating panel confined to the inner
 * workspace's own bounds (see CLAUDE.md's floating-window session note). It
 * instead opens a real `WebviewWindow` via `open_tab_window` and removes the
 * tab from this store, so it can be dragged anywhere on the desktop; see
 * `DetachedTabWindow`.
 *
 * `useTabs` stays the single source of truth for *which* tabs exist and
 * which is active; the inner dockview is a view that we reconcile against
 * it (store → dockview for add/remove, both directions for the active
 * panel). Keeping the store authoritative means the per-connection
 * persistence in `persistedTabs.ts` — which derives its snapshot from
 * `useTabs` — keeps working untouched. The trade-off is that split geometry
 * lives only for the session: on restart, restored tabs come back in the
 * default tabbed arrangement.
 *
 * All tab removal flows through the store (the custom tab's close button
 * and middle-click call `useTabs.close`), so add/remove is strictly
 * unidirectional (store → dockview) and can't feed back on itself.
 *
 * What lives here is the panel registry and that reconciler. The tab header
 * (`WorkspaceTab`) and the no-tabs-open screen (`EmptyWatermark`) were 600 of
 * this file's 1080 lines and are now their own modules; neither participates in
 * the reconciliation.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewHeaderActionsProps,
  type IDockviewPanelProps,
} from "dockview-react";

import { EmptyWatermark } from "@/components/shell/EmptyWatermark";
import { WorkspaceTab } from "@/components/shell/WorkspaceTab";
import { AggregationTab } from "@/components/aggregation/AggregationTab";
import { TableDataTab } from "@/components/grid/TableDataTab";
import { MongoIndexesTab } from "@/components/indexes/MongoIndexesTab";
import { QueryEditorTab } from "@/components/query/QueryEditorTab";
import { SecurityTab } from "@/components/schema/SecurityTab";
import { StructureEditorTab } from "@/components/schema/StructureEditorTab";
import { ViewEditorTab } from "@/components/schema/ViewEditorTab";
import { PolicyGate, PolicyLockHint } from "@/components/common/PolicyLock";
import { Button } from "@/components/ui/button";
import { SimpleTooltip } from "@/components/ui/tooltip";
import {
  clearInnerDockviewApi,
  consumePendingInternalLayout,
  huginnDockviewThemeInner,
  registerInnerDockviewApi,
  syncTabPanels,
} from "@/lib/dockview";
import { tabNeed, usePolicyLock } from "@/lib/policy/access";
import { openQueryTab } from "@/lib/tabs/openQueryTab";
import { usePreferences } from "@/stores/preferences/preferences";
import { scheduleSaveActive } from "@/stores/session/persistedTabs";
import { useTabs, useTabsIgnoringQuery } from "@/stores/session/tabs";
import { useUi } from "@/stores/session/ui";

interface Props {
  connectionId: string | null;
}

/** Params carried on each dockview panel, mirroring the `AppTab` payload. */
interface TablePanelParams {
  connectionId: string;
  schema?: string;
  table: string;
}
interface QueryPanelParams {
  tabId: string;
  connectionId: string;
}
interface StructurePanelParams {
  tabId: string;
  connectionId: string;
  schema?: string;
  table?: string;
  mode: "new" | "edit";
}
interface ViewPanelParams {
  tabId: string;
  connectionId: string;
  schema?: string;
  view?: string;
  mode: "new" | "edit";
}
interface AggregationPanelParams {
  tabId: string;
  connectionId: string;
  schema?: string;
  collection?: string;
  view?: string;
  mode: "new" | "edit";
}
interface IndexesPanelParams {
  tabId: string;
  connectionId: string;
  schema?: string;
  collection?: string;
}

/**
 * A tab body the managed policy does not allow is replaced by a locked empty
 * state — which covers the tabs restored from a previous session as much as
 * the ones opened now, since both are mounted here.
 */
function Gated({
  connectionId,
  tab,
  children,
}: {
  connectionId: string;
  tab: Parameters<typeof tabNeed>[0];
  children: ReactNode;
}) {
  const { need, relation } = tabNeed(tab);
  return (
    <PolicyGate connectionId={connectionId} need={need} relation={relation}>
      {children}
    </PolicyGate>
  );
}

// ---------------------------------------------------------------------------
// Panel bodies — read their identity from the panel params and delegate to
// the existing feature components. Each panel keeps its own mounted React
// tree for the lifetime of the tab, so switching tabs no longer resets a
// table's filter draft or a query editor's scroll position.
// ---------------------------------------------------------------------------

function TablePanel(props: IDockviewPanelProps<TablePanelParams>) {
  const { connectionId, schema, table } = props.params;
  // The dockview panel id is the tab id (see the reconciler's addPanel call),
  // so we can key the grid-selection report off it without a new param.
  return (
    <Gated connectionId={connectionId} tab={{ kind: "table", schema, table }}>
      <TableDataTab
        tabId={props.api.id}
        connectionId={connectionId}
        schema={schema}
        table={table}
      />
    </Gated>
  );
}

function QueryPanel(props: IDockviewPanelProps<QueryPanelParams>) {
  const { tabId, connectionId } = props.params;
  return (
    <Gated connectionId={connectionId} tab={{ kind: "query" }}>
      <QueryEditorTab tabId={tabId} connectionId={connectionId} />
    </Gated>
  );
}

function SecurityPanel(props: IDockviewPanelProps<QueryPanelParams>) {
  const { tabId, connectionId } = props.params;
  return (
    <Gated connectionId={connectionId} tab={{ kind: "security" }}>
      <SecurityTab tabId={tabId} connectionId={connectionId} />
    </Gated>
  );
}

function StructurePanel(props: IDockviewPanelProps<StructurePanelParams>) {
  const { tabId, connectionId, schema, table, mode } = props.params;
  return (
    <Gated
      connectionId={connectionId}
      tab={{ kind: "structure", schema, table, mode }}
    >
      <StructureEditorTab
        tabId={tabId}
        connectionId={connectionId}
        schema={schema}
        table={table}
        mode={mode}
      />
    </Gated>
  );
}

function ViewPanel(props: IDockviewPanelProps<ViewPanelParams>) {
  const { tabId, connectionId, schema, view, mode } = props.params;
  return (
    <Gated connectionId={connectionId} tab={{ kind: "view", schema, view, mode }}>
      <ViewEditorTab
        tabId={tabId}
        connectionId={connectionId}
        schema={schema}
        view={view}
        mode={mode}
      />
    </Gated>
  );
}

function AggregationPanel(props: IDockviewPanelProps<AggregationPanelParams>) {
  const { tabId, connectionId, schema, collection, view, mode } = props.params;
  return (
    <Gated
      connectionId={connectionId}
      tab={{ kind: "aggregation", schema, table: collection, view }}
    >
      <AggregationTab
        tabId={tabId}
        connectionId={connectionId}
        schema={schema}
        collection={collection}
        view={view}
        mode={mode}
      />
    </Gated>
  );
}

function IndexesPanel(props: IDockviewPanelProps<IndexesPanelParams>) {
  const { tabId, connectionId, schema, collection } = props.params;
  return (
    <Gated
      connectionId={connectionId}
      tab={{ kind: "indexes", schema, table: collection }}
    >
      <MongoIndexesTab
        tabId={tabId}
        connectionId={connectionId}
        schema={schema}
        collection={collection}
      />
    </Gated>
  );
}

const INNER_COMPONENTS = {
  table: TablePanel,
  query: QueryPanel,
  structure: StructurePanel,
  view: ViewPanel,
  aggregation: AggregationPanel,
  indexes: IndexesPanel,
  security: SecurityPanel,
};

function NewTabAction(_props: IDockviewHeaderActionsProps) {
  const { t } = useTranslation();
  const connectionId = useUi((s) => s.selectedConnectionId);
  const lock = usePolicyLock(connectionId, "freeSql");
  const button = (
    <Button
      variant="ghost"
      size="icon"
      className="h-7 w-7 text-muted-foreground hover:bg-accent hover:text-brand"
      disabled={!connectionId || !!lock}
      onClick={() => {
        if (!connectionId) return;
        openQueryTab(connectionId);
      }}
    >
      <Plus className="h-3.5 w-3.5" />
    </Button>
  );
  return (
    <div className="flex items-center gap-0.5 pr-1">
      {lock ? (
        <PolicyLockHint reason={lock}>{button}</PolicyLockHint>
      ) : (
        <SimpleTooltip label={t("tabs.newQueryTooltip")} side="bottom">
          {button}
        </SimpleTooltip>
      )}
    </div>
  );
}

export function TabbedArea(_props: Props) {
  const tabs = useTabsIgnoringQuery();
  const activeId = useTabs((s) => s.activeId);
  const tabAccentStyle = usePreferences((s) => s.prefs.ui.tabAccentStyle);
  const [api, setApi] = useState<DockviewApi | null>(null);
  // Set by the edge-fade effect below; called from `onDidLayoutChange`, which
  // is where a newly-created group's tab strip first becomes reachable.
  const refreshEdgeFade = useRef<() => void>(() => {});

  const onReady = (event: DockviewReadyEvent) => {
    setApi(event.api);
    registerInnerDockviewApi(event.api);

    // If hydration ran before this dockview mounted, it stashed the saved
    // split/float geometry. Rebuild it now: `fromJSON` recreates the panels
    // (with the params we stored at addPanel) AND the group/pane geometry, so
    // it is the authoritative layout restore. The reconciler effect below
    // then runs as an idempotent verification pass (panels already present →
    // nothing added; orphans → removed). Guarded like `restoreOrInitLayout`:
    // on any drift (a dropped oversize tab, schema change) we swallow the
    // error and let the reconciler build the default tabbed layout instead —
    // this preserves the old "comes back tabbed" safety behaviour.
    const pending = consumePendingInternalLayout();
    if (pending) {
      try {
        event.api.fromJSON(pending as Parameters<DockviewApi["fromJSON"]>[0]);
      } catch (err) {
        console.warn("Failed to restore inner workspace layout:", err);
      }
    }

    // User clicking a tab (or dockview activating one after a removal)
    // flows back into the store so the active body and status bar agree.
    event.api.onDidActivePanelChange((panel) => {
      if (panel) useTabs.getState().setActive(panel.id);
    });

    // A pure split/float/resize gesture touches no tab or schema state, so
    // nothing else schedules a save for it — without this, split geometry
    // could go unpersisted until an unrelated tab edit happened to trigger
    // one (see issue #80). It is also the only signal that a *group* (and
    // with it a tab strip) was created, which the edge-fade pass has to know
    // about — its own observers can only watch strips that already exist.
    event.api.onDidLayoutChange(() => {
      scheduleSaveActive();
      refreshEdgeFade.current();
    });
  };

  // Clear the inner-dockview singleton on unmount so a stale handle from a
  // previous workspace can't be captured/restored against.
  useEffect(() => {
    return () => {
      if (api) clearInnerDockviewApi(api);
    };
  }, [api]);

  // `syncTabPanels` only adds/removes panels — it needs to run again when a
  // tab opens or closes, never when an existing tab's own fields change
  // (its SQL body, most often: `updateQuery` replaces the whole `tabs`
  // array on every keystroke in the query editor). Depending on `tabs`
  // itself re-ran this — and the ResizeObserver-teardown effect below it —
  // on every keystroke; depending on the ids' identity instead means it
  // only fires on an actual open/close, while still reading the live
  // `tabs` array (via `getState()`, not the possibly-stale value this
  // render closed over) for the diff itself.
  const tabIdsSignature = tabs.map((t) => t.id).join("\0");

  // Reconcile the dockview panels with the store: add panels for new tabs,
  // remove panels for closed ones. This is the only place panels are
  // added/removed during ordinary use, so the flow is strictly store →
  // dockview. `hydrateWorkspaceLayout` (environment switch) also drives panel
  // creation directly, via the same `syncTabPanels` helper — see its comment
  // for why that path can't just wait for this effect to converge.
  useEffect(() => {
    if (!api) return;
    syncTabPanels(api, useTabs.getState().tabs);
  }, [api, tabIdsSignature]);

  // Mirror the store's active tab into dockview (e.g. when a tab is opened
  // from the schema explorer). `setActive` on the already-active panel is a
  // no-op, so this can't ping-pong with `onDidActivePanelChange`.
  useEffect(() => {
    if (!api || !activeId) return;
    const panel = api.getPanel(activeId);
    if (panel && !panel.api.isActive) panel.api.setActive();
  }, [api, activeId]);

  // Ease sibling panels into their new size when a drag-drop finishes,
  // instead of the instant jump dockview does by default (see the
  // `.dv-animate-resize` rule in index.css for why the class lives on this
  // root and not deeper). A *capture*-phase listener on the root fires
  // before dockview's own `drop` handler (registered directly on each
  // group's content element, bubble-phase — see dockview-core's
  // `DragAndDropObserver`), so the transition is already active by the time
  // dockview mutates the `.dv-view` sizes and has an old value to animate
  // from. Scoped to the native `drop` event specifically: a manual sash
  // drag never fires it, so interactive resizing is unaffected.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let clearTimer: number | undefined;
    const onDropCapture = () => {
      root.classList.add("dv-animate-resize");
      window.clearTimeout(clearTimer);
      clearTimer = window.setTimeout(() => {
        root.classList.remove("dv-animate-resize");
      }, 260);
    };
    root.addEventListener("drop", onDropCapture, { capture: true });
    return () => {
      root.removeEventListener("drop", onDropCapture, { capture: true });
      window.clearTimeout(clearTimer);
    };
  }, []);

  // Fade the tab strip's edges wherever there is more to scroll to. A strip
  // that overflows crops the tab straddling its edge mid-letter, which no
  // amount of label truncation can soften — the tab isn't truncated, it's
  // cropped by the scroll box around it — so the mask goes on the scroller
  // (`data-clip` → `index.css`). CSS can't see scroll offsets, hence this.
  // Re-running on tab opens/closes catches new/removed strips; the
  // per-container ResizeObserver catches splits and window resizes; the
  // capture-phase listener catches scrolling (a scroll event doesn't
  // bubble).
  //
  // Split into two effects on purpose: the observer/listener setup below
  // has no reason to ever tear down and rebuild itself on a keystroke, only
  // the "re-scan for new/removed tab strips" step does. Keyed on `[tabs]`
  // as one effect, this destroyed and recreated the ResizeObserver, redid
  // the querySelectorAll, and re-registered the capture-phase scroll
  // listener on every single `updateQuery` call.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      for (const el of root.querySelectorAll<HTMLElement>(".dv-tabs-container")) {
        observer.observe(el); // re-observing an observed element is a no-op
        const slack = 2;
        const hidden = el.scrollWidth - el.clientWidth;
        const left = hidden > slack && el.scrollLeft > slack;
        const right = hidden > slack && el.scrollLeft < hidden - slack;
        if (left && right) el.dataset.clip = "both";
        else if (left) el.dataset.clip = "left";
        else if (right) el.dataset.clip = "right";
        else delete el.dataset.clip;
      }
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(root);
    refreshEdgeFade.current = schedule;
    schedule();
    root.addEventListener("scroll", schedule, { capture: true });
    return () => {
      refreshEdgeFade.current = () => {};
      root.removeEventListener("scroll", schedule, { capture: true });
      observer.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  // The re-scan: a new or closed tab can add/remove a `.dv-tabs-container`
  // the observer above doesn't know about yet, so this asks it to look
  // again — via the same `refreshEdgeFade` ref `onDidLayoutChange` already
  // uses, not a second code path. Keyed on tab identity, not `tabs` itself,
  // for the same reason `syncTabPanels`'s effect is above.
  useEffect(() => {
    refreshEdgeFade.current();
  }, [tabIdsSignature]);

  return (
    // Explicit positioned, full-size wrapper. The nested DockviewReact root
    // itself is `height/width: 100%`, but it also creates a shell element
    // sized via ResizeObserver and absolutely-positioned drag overlays, so
    // we make sure the box it lives in is unambiguously sized and a
    // positioned ancestor — otherwise the overlays anchor against an outer
    // dockview's shell and the vertical layout collapses on the first split.
    <div
      ref={rootRef}
      className="inner-dock relative h-full w-full"
      data-tab-accent={tabAccentStyle}
    >
      <DockviewReact
        components={INNER_COMPONENTS}
        defaultTabComponent={WorkspaceTab}
        watermarkComponent={EmptyWatermark}
        rightHeaderActionsComponent={NewTabAction}
        onReady={onReady}
        theme={huginnDockviewThemeInner}
      />
    </div>
  );
}
