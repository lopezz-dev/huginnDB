/**
 * `connectAndWarm`'s reporting.
 *
 * The regression this exists for: `useSchema.refresh` records its failure on
 * the slice rather than throwing (one unreachable child must not abort a
 * fan-out), so awaiting it inside the `try` meant the `catch` was unreachable
 * for anything that failed *after* the pool opened — and the app announced
 * "Connected" for a server that had never answered. MongoDB hit it on every
 * connection, because its client is lazy and `connect` could not fail at all.
 * See ADR #68.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const connect = vi.fn<(id: string) => Promise<void>>();
const refresh = vi.fn<(id: string, opts?: unknown) => Promise<string | null>>();

vi.mock("@/stores/session/connections", () => ({
  useConnections: {
    getState: () => ({
      connect,
      profiles: [{ id: "c1", name: "Staging Mongo" }],
      active: new Set<string>(),
    }),
  },
}));
vi.mock("@/stores/session/schema", () => ({
  useSchema: { getState: () => ({ refresh, drop: vi.fn() }) },
}));
vi.mock("@/stores/session/tabs", () => ({
  useTabs: { getState: () => ({ closeForConnection: vi.fn() }) },
}));
vi.mock("@/stores/session/persistedTabs", () => ({
  persistLaunchState: vi.fn().mockResolvedValue(undefined),
}));

const success = vi.fn();
const error = vi.fn();
vi.mock("@/lib/notify", () => ({
  notify: { success, error, info: vi.fn(), warning: vi.fn() },
}));
vi.mock("@/lib/i18n", () => ({ default: { t: (k: string) => k } }));

const { connectAndWarm } = await import("@/lib/connection/connectFlow");

beforeEach(() => {
  vi.clearAllMocks();
  connect.mockResolvedValue(undefined);
  refresh.mockResolvedValue(null);
});

describe("connectAndWarm", () => {
  it("reports success only when the schema actually loaded", async () => {
    expect(await connectAndWarm("c1")).toBe(true);
    expect(success).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
  });

  it("asks the store to stay quiet, and reports the failure itself", async () => {
    // The store's own card would not name the profile or add the driver hint,
    // and two cards for one gesture is worse than either.
    refresh.mockResolvedValue("mongodb error: Server selection timeout");

    expect(await connectAndWarm("c1")).toBe(false);

    expect(refresh).toHaveBeenCalledWith("c1", { quiet: true });
    expect(success).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toBe("connections.connectFailed");
    expect(error.mock.calls[0][1]).toMatchObject({
      description: "mongodb error: Server selection timeout",
    });
  });

  it("reports a pool that would not open the same way", async () => {
    // The two exits must not drift: one is the pool refusing, the other is the
    // schema read failing behind a pool that opened.
    connect.mockRejectedValue(new Error("Connection refused (os error 111)"));

    expect(await connectAndWarm("c1")).toBe(false);

    expect(success).not.toHaveBeenCalled();
    expect(error.mock.calls[0][0]).toBe("connections.connectFailed");
    expect(error.mock.calls[0][1]).toMatchObject({
      description: expect.stringContaining("Connection refused"),
    });
  });
});
