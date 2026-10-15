import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/tauri", () => ({
  api: { terminalCloseWindowSessions: vi.fn(() => Promise.resolve(2)) },
}));

import { api } from "@/lib/tauri";
import { sweepOrphanedSessions, useTerminals } from "./terminals";

const shell = { kind: "shell" as const, connectionId: null, database: null, title: "bash" };

beforeEach(() => {
  useTerminals.setState({ tabs: [], activeKey: null });
});

describe("terminal tabs", () => {
  it("opening adds a tab, shows it, and returns a unique key", () => {
    const a = useTerminals.getState().open(shell);
    const b = useTerminals.getState().open({ ...shell, title: "zsh" });
    expect(a).not.toBe(b);
    const { tabs, activeKey } = useTerminals.getState();
    expect(tabs.map((t) => t.title)).toEqual(["bash", "zsh"]);
    expect(activeKey).toBe(b);
    expect(tabs.every((t) => !t.exited)).toBe(true);
  });

  it("closing the active tab shows the one that slides into its place, else the one before", () => {
    const { open } = useTerminals.getState();
    const [a, b, c] = [open(shell), open(shell), open(shell)];
    useTerminals.getState().select(b);
    useTerminals.getState().close(b);
    expect(useTerminals.getState().activeKey).toBe(c);
    useTerminals.getState().close(c);
    expect(useTerminals.getState().activeKey).toBe(a);
    useTerminals.getState().close(a);
    expect(useTerminals.getState().activeKey).toBeNull();
  });

  it("closing another tab keeps the selection", () => {
    const { open } = useTerminals.getState();
    const [a, b] = [open(shell), open(shell)];
    useTerminals.getState().close(a);
    expect(useTerminals.getState().activeKey).toBe(b);
    useTerminals.getState().close("no-such-key");
    expect(useTerminals.getState().tabs).toHaveLength(1);
  });

  it("an exited tab stays, marked, until closed", () => {
    const key = useTerminals.getState().open(shell);
    useTerminals.getState().markExited(key);
    expect(useTerminals.getState().tabs[0]).toMatchObject({ key, exited: true });
  });

  it("closeAll empties the strip", () => {
    useTerminals.getState().open(shell);
    useTerminals.getState().open(shell);
    useTerminals.getState().closeAll();
    expect(useTerminals.getState()).toMatchObject({ tabs: [], activeKey: null });
  });
});

describe("sweepOrphanedSessions", () => {
  it("asks the backend once per page, however many tabs wait on it", async () => {
    await Promise.all([sweepOrphanedSessions(), sweepOrphanedSessions()]);
    await sweepOrphanedSessions();
    expect(api.terminalCloseWindowSessions).toHaveBeenCalledTimes(1);
  });
});
