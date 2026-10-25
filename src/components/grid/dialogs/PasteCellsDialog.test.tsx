/**
 * @vitest-environment jsdom
 *
 * The paste confirmation (ADR #114): it says what the block changes and adds,
 * names what it leaves out and why, and offers to paste only what is allowed —
 * or nothing, when nothing can be written.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@/lib/i18n";

import { planPaste } from "@/lib/grid/pastePlan";
import type { CellValue, ColumnInfo, ColumnMeta } from "@/types";
import { PasteCellsDialog } from "./PasteCellsDialog";

afterEach(cleanup);

const columns = [
  { name: "id", data_type: "int" },
  { name: "importe", data_type: "decimal" },
  { name: "estado", data_type: "varchar" },
] as ColumnMeta[];
const rows: CellValue[][] = [
  [1, "10.00", "Abierto"],
  [2, "20.00", "Abierto"],
];
const info = (name: string, over: Partial<ColumnInfo> = {}): ColumnInfo => ({
  name,
  data_type: "varchar",
  nullable: true,
  is_primary_key: false,
  ...over,
});

function plan(block: string[][], locked = false) {
  return planPaste({
    block,
    rows,
    columns: columns.slice(1),
    columnIndexByName: new Map(columns.map((c, i) => [c.name, i])),
    pkColumns: ["id"],
    columnInfo: new Map([
      ["id", info("id", { data_type: "int", is_primary_key: true, nullable: false })],
      ["importe", info("importe")],
      ["estado", info("estado")],
    ]),
    bitColumns: new Set(),
    canUpdate: true,
    canInsert: true,
    updateLock: locked ? (c) => (c === "importe" ? "locked" : null) : undefined,
  });
}

describe("PasteCellsDialog", () => {
  it("says what the block writes and pastes it", () => {
    const onApply = vi.fn(async () => {});
    render(
      <PasteCellsDialog
        plan={plan([
          ["11.00", "Cerrado"],
          ["22.00", "Cerrado"],
          ["33.00", "Nuevo"],
        ])}
        table="dbo.pedidos"
        documentMode={false}
        onApply={onApply}
        onClose={() => {}}
      />,
    );
    expect(
      screen.getByText(/changes 4 cells in 2 rows · adds 1 new row/),
    ).toBeTruthy();
    expect(screen.getByText(/one transaction/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Paste" }));
    expect(onApply).toHaveBeenCalled();
  });

  it("names the cells it leaves out and pastes only the allowed ones", () => {
    render(
      <PasteCellsDialog
        plan={plan([["11.00", "Cerrado"]], true)}
        table="dbo.pedidos"
        documentMode={false}
        onApply={async () => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText("1 cell is left out")).toBeTruthy();
    expect(screen.getByText(/doesn't let you write this column/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Paste only the allowed cells" })).toBeTruthy();
  });

  it("offers nothing to apply when nothing can be written", () => {
    render(
      <PasteCellsDialog
        plan={plan([["10.00", "Abierto"]])}
        table="dbo.pedidos"
        documentMode={false}
        onApply={async () => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText("Nothing in this block can be written here.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Paste" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
