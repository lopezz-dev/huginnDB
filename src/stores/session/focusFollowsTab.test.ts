import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startFocusFollowsTab } from "@/stores/session/focusFollowsTab";
import { useConnections } from "@/stores/session/connections";
import { useTabs } from "@/stores/session/tabs";
import { useUi } from "@/stores/session/ui";
import type { AppTab } from "@/types";

function tab(id: string, connectionId: string): AppTab {
  return { id, kind: "query", title: id, connectionId };
}

let stop: (() => void) | null = null;

beforeEach(() => {
  useTabs.setState({ tabs: [], activeId: null });
  useUi.setState({ selectedConnectionId: null });
  useConnections.setState({ active: new Set(["c1", "c2"]) });
  stop = startFocusFollowsTab();
});

afterEach(() => {
  stop?.();
  stop = null;
});

describe("focusFollowsTab", () => {
  it("moves the workspace to the focused tab's connection", () => {
    useUi.getState().setSelectedConnectionId("c1");
    useTabs.getState().open({ kind: "query", title: "q", connectionId: "c2" });
    expect(useUi.getState().selectedConnectionId).toBe("c2");
  });

  it("selects the owning profile, not the synthetic database-view id", () => {
    // The whole reason ADR #32 exists: `useConnections.active` only holds
    // top-level ids, so a `<parent>::db::<db>` selection is cleared a render
    // later by App's active-set sync.
    useTabs
      .getState()
      .open({ kind: "query", title: "q", connectionId: "c2::db::shop" });
    expect(useUi.getState().selectedConnectionId).toBe("c2");
  });

  it("follows a plain focus change, with no tab opened", () => {
    // The half of the bug nobody reported: clicking an already-open tab of the
    // other connection left the `+` button pointed at the old one.
    useTabs.getState().replaceAll([tab("a", "c1"), tab("b", "c2")], "a");
    expect(useUi.getState().selectedConnectionId).toBe("c1");
    useTabs.getState().setActive("b");
    expect(useUi.getState().selectedConnectionId).toBe("c2");
  });

  it("leaves the selection alone when the last tab closes", () => {
    useTabs.getState().replaceAll([tab("a", "c1")], "a");
    useTabs.getState().close("a");
    expect(useTabs.getState().activeId).toBeNull();
    // Clearing from here would fight App's own active-set sync and the
    // environment-switch teardown, which both have their own opinion.
    expect(useUi.getState().selectedConnectionId).toBe("c1");
  });

  it("ignores a tab whose pool is no longer live", () => {
    useConnections.setState({ active: new Set(["c1"]) });
    useUi.getState().setSelectedConnectionId("c1");
    useTabs.getState().replaceAll([tab("a", "c2")], "a");
    expect(useUi.getState().selectedConnectionId).toBe("c1");
  });

  it("does not react to edits that leave the focused tab unchanged", () => {
    useTabs.getState().replaceAll([tab("a", "c1")], "a");
    useUi.setState({ selectedConnectionId: "c2" });
    // A keystroke in the editor replaces the whole `tabs` array; the focus did
    // not move, so neither should the workspace.
    useTabs.getState().updateQuery("a", "SELECT 1");
    expect(useUi.getState().selectedConnectionId).toBe("c2");
  });

  it("is idempotent — a second start does not subscribe twice", () => {
    const again = startFocusFollowsTab();
    expect(again).toBe(stop);
  });
});
