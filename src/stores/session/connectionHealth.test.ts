/**
 * Which open connections were edited since they opened is the backend's
 * answer, re-asked on every profile change and every connect/disconnect —
 * never inferred in the window, since reusing a pool another window opened
 * does not make it any less stale.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { editedConnections } = vi.hoisted(() => ({
  editedConnections: vi.fn<() => Promise<string[]>>(),
}));
vi.mock("@/lib/tauri", () => ({ api: { editedConnections } }));

import { useConnectionHealth } from "./connectionHealth";

describe("connectionHealth.edited", () => {
  beforeEach(() => {
    editedConnections.mockReset();
    useConnectionHealth.setState({ lost: {}, edited: {} });
  });

  it("mirrors the backend's answer, replacing what was there", async () => {
    editedConnections.mockResolvedValueOnce(["a", "b"]);
    await useConnectionHealth.getState().refreshEdited();
    expect(useConnectionHealth.getState().edited).toEqual({ a: true, b: true });

    // Reconnected `a`: the next answer no longer lists it.
    editedConnections.mockResolvedValueOnce(["b"]);
    await useConnectionHealth.getState().refreshEdited();
    expect(useConnectionHealth.getState().edited).toEqual({ b: true });
  });

  it("keeps the last answer when the backend cannot be asked", async () => {
    useConnectionHealth.setState({ edited: { a: true } });
    editedConnections.mockRejectedValueOnce(new Error("ipc down"));
    await useConnectionHealth.getState().refreshEdited();
    expect(useConnectionHealth.getState().edited).toEqual({ a: true });
  });

  it("clearing a lost flag leaves the edited one to the backend", async () => {
    useConnectionHealth.setState({ lost: { a: "ping" }, edited: { a: true } });
    useConnectionHealth.getState().clear("a");
    expect(useConnectionHealth.getState().lost).toEqual({});
    expect(useConnectionHealth.getState().edited).toEqual({ a: true });
  });
});
