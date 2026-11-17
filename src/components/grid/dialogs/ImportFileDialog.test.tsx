/**
 * @vitest-environment jsdom
 *
 * The import dialog proposes a mapping by name, lets it be changed, sends
 * only the mapped columns, and keeps a refused import's message in place.
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "@/lib/i18n";
import i18n from "@/lib/i18n";
import { ImportFileDialog } from "./ImportFileDialog";
import type { ImportPreview } from "@/types";

const h = vi.hoisted(() => ({
  importTableFile: vi.fn(),
  insertLimit: null as string[] | null,
}));

const preview: ImportPreview = {
  format: "csv",
  columns: ["NAME", "id", "extra"],
  sample: [
    ["Tornillo", "1", "x"],
    ["Tuerca", "2", "y"],
  ],
  totalRows: 2,
  delimiter: ";",
  encoding: "UTF-8",
  sheets: [],
  sheet: null,
};

vi.mock("@/lib/tauri", () => ({
  api: {
    listColumns: () =>
      Promise.resolve([
        { name: "id", data_type: "int", nullable: false, is_primary_key: true },
        { name: "name", data_type: "text", nullable: true, is_primary_key: false },
        { name: "note", data_type: "text", nullable: true, is_primary_key: false },
      ]),
    previewImportFile: () => Promise.resolve(preview),
    importTableFile: (args: unknown) => h.importTableFile(args),
  },
}));

vi.mock("@/lib/policy/access", () => ({
  usePolicyColumns: () => ({
    insert: h.insertLimit,
    update: null,
    lock: (_verb: string, column: string) =>
      h.insertLimit && !h.insertLimit.includes(column) ? "locked" : null,
  }),
}));

vi.mock("@/lib/notify", () => ({ notify: { success: vi.fn() } }));

function mount(onImported = vi.fn(), onOpenChange = vi.fn()) {
  render(
    <ImportFileDialog
      open
      onOpenChange={onOpenChange}
      connectionId="c1"
      table="items"
      path="C:/data/items.csv"
      onImported={onImported}
    />,
  );
  return { onImported, onOpenChange };
}

beforeEach(() => {
  void i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  h.importTableFile.mockReset();
  h.insertLimit = null;
});

describe("ImportFileDialog", () => {
  it("maps by name and imports only the mapped columns", async () => {
    h.importTableFile.mockResolvedValue({
      inserted: 2,
      statements: 1,
      columns: ["id", "name"],
    });
    const { onImported, onOpenChange } = mount();
    const button = await screen.findByRole("button", { name: "Import 2 rows" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    expect(
      (screen.getByLabelText("File column for name") as HTMLSelectElement).value,
    ).toBe("0");
    expect(
      (screen.getByLabelText("File column for note") as HTMLSelectElement).value,
    ).toBe("");

    fireEvent.click(button);
    await waitFor(() => expect(onImported).toHaveBeenCalled());
    expect(h.importTableFile).toHaveBeenCalledWith(
      expect.objectContaining({
        table: "items",
        path: "C:/data/items.csv",
        mapping: [
          { column: "id", source: 1 },
          { column: "name", source: 0 },
        ],
        emptyAsNull: true,
      }),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("starts a column the policy withholds unmapped", async () => {
    h.insertLimit = ["id"];
    mount();
    await screen.findByRole("button", { name: "Import 2 rows" });
    await waitFor(() =>
      expect(
        (screen.getByLabelText("File column for id") as HTMLSelectElement)
          .value,
      ).toBe("1"),
    );
    expect(
      (screen.getByLabelText("File column for name") as HTMLSelectElement).value,
    ).toBe("");
    expect(screen.getAllByLabelText("locked").length).toBeGreaterThan(0);
  });

  it("keeps a refused import's message and stays open", async () => {
    h.importTableFile.mockRejectedValue(
      "import: row 3 of the file could not be inserted, so nothing was imported",
    );
    const { onOpenChange } = mount();
    const button = await screen.findByRole("button", { name: "Import 2 rows" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    expect(await screen.findByText(/row 3 of the file/)).toBeTruthy();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
