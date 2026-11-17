import { describe, expect, it, vi } from "vitest";

import { rowsExportedNotice, runExport } from "./exportTable";

describe("runExport", () => {
  it("announces the written path", async () => {
    const announce = vi.fn();
    const fail = vi.fn();
    await runExport(async () => "/tmp/out.sql", announce, fail);
    expect(announce).toHaveBeenCalledWith("/tmp/out.sql");
    expect(fail).not.toHaveBeenCalled();
  });

  it("stays silent when the user cancels the save dialog", async () => {
    const fail = vi.fn();
    // Rust reports a dismissed dialog as an ordinary Err; telling someone who
    // just cancelled that the export failed would be a lie.
    await runExport(
      async () => {
        throw new Error("export cancelled");
      },
      vi.fn(),
      fail,
    );
    expect(fail).not.toHaveBeenCalled();
  });

  it("surfaces any other failure", async () => {
    const fail = vi.fn();
    await runExport(
      async () => {
        throw new Error("permission denied");
      },
      vi.fn(),
      fail,
    );
    expect(fail).toHaveBeenCalledWith("Error: permission denied");
  });
});

describe("rowsExportedNotice", () => {
  const t = (key: string, opts?: Record<string, unknown>) =>
    opts ? `${key}:${JSON.stringify(opts)}` : key;

  it("names the file and says nothing more when no cell was cut", () => {
    expect(rowsExportedNotice({ path: "/tmp/a.csv", truncatedCells: 0 }, t)).toEqual({
      title: "notifications.fileSaved.rows",
      path: "/tmp/a.csv",
      description: undefined,
    });
  });

  it("says how many Excel cells were cut", () => {
    expect(rowsExportedNotice({ path: "/tmp/a.xlsx", truncatedCells: 3 }, t).description).toBe(
      'notifications.fileSaved.truncatedCells:{"count":3}',
    );
  });
});
