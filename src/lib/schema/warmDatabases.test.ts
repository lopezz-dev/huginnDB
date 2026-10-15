/**
 * `warmDatabases`' honesty about what it actually loaded.
 *
 * `useSchema.refresh` records its failure on the slice rather than throwing, so
 * `loaded += 1` used to run for a database whose table list had failed —
 * nineteen loaded, nineteen broken, reported as a clean success. And every
 * non-limit failure was reduced to `skipped += 1` with the error itself
 * dropped, so a server that had gone away produced a counter and nothing that
 * said why. See ADR #68.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const refresh = vi.fn<(id: string, opts?: unknown) => Promise<string | null>>();
const openTrackedDatabaseView =
  vi.fn<(parentId: string, db: string) => Promise<string>>();

vi.mock("@/stores/session/schema", () => ({
  useSchema: { getState: () => ({ refresh }) },
}));
vi.mock("@/stores/session/persistedTabs", () => ({
  openTrackedDatabaseView: (...a: unknown[]) =>
    openTrackedDatabaseView(...(a as [string, string])),
}));

const { warmDatabases } = await import("@/lib/schema/warmDatabases");

beforeEach(() => {
  vi.clearAllMocks();
  openTrackedDatabaseView.mockImplementation(
    async (p, db) => `${p}::db::${db}`,
  );
  refresh.mockResolvedValue(null);
});

describe("warmDatabases", () => {
  it("counts what loaded", async () => {
    const result = await warmDatabases("p", ["a", "b"]);
    expect(result).toMatchObject({ loaded: 2, skipped: 0, firstError: null });
    // Quiet: nineteen databases against a dead server must not be nineteen
    // cards — the caller reports one summary.
    expect(refresh).toHaveBeenCalledWith("p::db::a", { quiet: true });
  });

  it("does not count a database whose table list failed", async () => {
    refresh.mockImplementation(async (id) =>
      id.endsWith("b") ? "mongodb error: Server selection timeout" : null,
    );

    const result = await warmDatabases("p", ["a", "b"]);

    expect(result).toMatchObject({ loaded: 1, skipped: 1 });
    expect(String(result.firstError)).toContain("Server selection timeout");
  });

  it("keeps the first failure when the view itself would not open", async () => {
    openTrackedDatabaseView.mockRejectedValue(new Error("permission denied"));

    const result = await warmDatabases("p", ["a", "b"]);

    expect(result).toMatchObject({ loaded: 0, skipped: 2, limitError: null });
    expect(String(result.firstError)).toContain("permission denied");
  });

  it("still breaks the circuit on a connection-limit refusal", async () => {
    // The one failure that aborts the rest, because everything queued would be
    // refused the same way. It stays in its own field: releasing idle pools is
    // a remedy for this and for nothing else in here.
    openTrackedDatabaseView.mockRejectedValue(
      new Error("too many connections: server is full"),
    );

    const result = await warmDatabases("p", ["a", "b", "c"]);

    expect(result.limitError).toBeTruthy();
    expect(result.loaded).toBe(0);
    expect(result.skipped).toBe(3);
  });
});
