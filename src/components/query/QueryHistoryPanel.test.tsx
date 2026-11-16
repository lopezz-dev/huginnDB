/**
 * @vitest-environment jsdom
 *
 * The history dock panel (ADR #137). Two of these flip the defects the
 * characterization tests pinned on the old sidebar: Clear now clears only
 * what is shown, and Run opens the entry in a tab that runs it through its
 * own runner (the tab's test checks that a batch then takes the batch path).
 */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionProfile } from "@/types";

const h = vi.hoisted(() => ({
  confirm: vi.fn(async (_message: string) => true),
  open: vi.fn(),
}));

vi.mock("@/lib/confirmDestructive", () => ({ confirmIrreversible: h.confirm }));
vi.mock("@/lib/tabs/openQueryTab", () => ({ openQueryTab: h.open }));
const t = (key: string, opts?: Record<string, unknown>) =>
  opts ? `${key}${JSON.stringify(opts)}` : key;
vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({ t }),
}));

import { QueryHistoryPanel } from "./QueryHistoryPanel";
import { useQueryHistory } from "@/stores/query/queryHistory";
import { useConnections } from "@/stores/session/connections";

const profile = (id: string): ConnectionProfile =>
  ({ id, name: `${id}-name`, driver: "postgres" }) as ConnectionProfile;

function add(sql: string, connectionId: string) {
  useQueryHistory.getState().add({ sql, connectionId, elapsedMs: 1, rowsAffected: 0 });
}
const sqls = () => useQueryHistory.getState().entries.map((e) => e.sql);
const listed = () =>
  screen.queryAllByLabelText("history.open").map((b) => b.textContent ?? "");

beforeEach(() => {
  h.confirm.mockReset();
  h.confirm.mockResolvedValue(true);
  h.open.mockReset();
  useConnections.setState({ profiles: [profile("pg1"), profile("other")] });
  useQueryHistory.setState({ entries: [] });
  add("SELECT other", "other");
  add("SELECT one", "pg1");
  add("SELECT two", "pg1");
});
afterEach(() => cleanup());

async function clickClear() {
  await act(async () => {
    fireEvent.click(screen.getByLabelText("history.clear"));
  });
}

describe("QueryHistoryPanel", () => {
  it("lists the focused tab's connection, newest first — a ::db:: view reads its parent", () => {
    render(<QueryHistoryPanel connectionId="pg1::db::sales" />);
    expect(listed().map((x) => x.slice(0, 10))).toEqual(["SELECT two", "SELECT one"]);
  });

  it("the switch shows every connection, naming each entry's", () => {
    render(<QueryHistoryPanel connectionId="pg1" />);
    act(() => fireEvent.click(screen.getByRole("switch")));
    expect(listed()).toHaveLength(3);
    expect(screen.getByText("other-name")).toBeTruthy();
  });

  it("with no tab focused, says so instead of showing an empty list", () => {
    render(<QueryHistoryPanel connectionId={null} />);
    expect(screen.getByText("history.noConnection")).toBeTruthy();
  });

  it("Clear clears only this connection's entries, after a confirmation", async () => {
    render(<QueryHistoryPanel connectionId="pg1" />);
    await clickClear();
    expect(h.confirm).toHaveBeenCalledWith(
      `history.clearConnectionConfirm${JSON.stringify({ count: 2, name: "pg1-name" })}`,
    );
    expect(sqls()).toEqual(["SELECT other"]);
  });

  it("Clear does nothing when the confirmation is declined", async () => {
    h.confirm.mockResolvedValue(false);
    render(<QueryHistoryPanel connectionId="pg1" />);
    await clickClear();
    expect(sqls()).toHaveLength(3);
  });

  it("Clear with every connection shown clears every entry", async () => {
    render(<QueryHistoryPanel connectionId="pg1" />);
    act(() => fireEvent.click(screen.getByRole("switch")));
    await clickClear();
    expect(sqls()).toEqual([]);
  });

  it("Clear with a text filter clears only the matches", async () => {
    render(<QueryHistoryPanel connectionId="pg1" />);
    act(() => {
      fireEvent.change(screen.getByPlaceholderText("query.historyFilterPlaceholder"), {
        target: { value: "two" },
      });
    });
    await clickClear();
    expect(h.confirm).toHaveBeenCalledWith(
      `history.clearMatchesConfirm${JSON.stringify({ count: 1 })}`,
    );
    expect(sqls()).toEqual(["SELECT one", "SELECT other"]);
  });

  it("Run opens the entry in a query tab that runs it, on the connection it ran on", () => {
    render(<QueryHistoryPanel connectionId="pg1" />);
    act(() => fireEvent.click(screen.getAllByLabelText("query.runAgain")[0]));
    expect(h.open).toHaveBeenCalledWith("pg1", {
      sql: "SELECT two",
      resolveTarget: false,
      run: true,
    });
  });

  it("a click on the entry opens it without running", () => {
    render(<QueryHistoryPanel connectionId="pg1" />);
    act(() => fireEvent.click(screen.getAllByLabelText("history.open")[1]));
    expect(h.open).toHaveBeenCalledWith("pg1", {
      sql: "SELECT one",
      resolveTarget: false,
      run: false,
    });
  });
});
