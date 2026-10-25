import { describe, expect, it } from "vitest";
import type { CellValue, ColumnInfo, ColumnMeta } from "@/types";
import { planPaste, type PastePlanInput } from "./pastePlan";

const col = (name: string, data_type = "varchar") => ({ name, data_type }) as ColumnMeta;
const info = (name: string, over: Partial<ColumnInfo> = {}): ColumnInfo => ({
  name,
  data_type: "varchar",
  nullable: true,
  is_primary_key: false,
  ...over,
});

// dbo.Pedidos: id (identity key), cliente (NOT NULL), estado, obs.
const columns = [col("id", "int"), col("cliente"), col("estado"), col("obs")];
const rows: CellValue[][] = [
  [1, "Ruiz", "Abierto", null],
  [2, "Costa", "Cerrado", "ok"],
];

function input(over: Partial<PastePlanInput> = {}): PastePlanInput {
  return {
    block: [],
    rows,
    columns,
    columnIndexByName: new Map(columns.map((c, i) => [c.name, i])),
    pkColumns: ["id"],
    columnInfo: new Map([
      ["id", info("id", { data_type: "int", nullable: false, is_primary_key: true })],
      ["cliente", info("cliente", { nullable: false })],
      ["estado", info("estado")],
      ["obs", info("obs")],
    ]),
    bitColumns: new Set(),
    canUpdate: true,
    canInsert: true,
    ...over,
  };
}

describe("planPaste", () => {
  it("writes the block right and down from the anchor, by the full key", () => {
    const plan = planPaste(
      input({
        rows: rows,
        columns: columns.slice(2), // anchored on `estado`
        block: [
          ["En curso", "llamar"],
          ["Cerrado", "revisar"],
        ],
      }),
    );
    expect(plan.updates).toEqual([
      { pkValues: [1], column: "estado", value: "En curso", columnType: "varchar" },
      { pkValues: [1], column: "obs", value: "llamar", columnType: "varchar" },
      { pkValues: [2], column: "obs", value: "revisar", columnType: "varchar" },
    ]);
    // Row 2's `estado` already says "Cerrado": not sent.
    expect(plan.unchanged).toBe(1);
    expect(plan.rowsChanged).toBe(2);
    expect(plan.inserts).toEqual([]);
  });

  it("leaves out keys and locked columns, and says how many of each", () => {
    const plan = planPaste(
      input({
        block: [
          ["9", "Nava", "Abierto", "x"],
          ["8", "Lema", "Abierto", "y"],
        ],
        updateLock: (c) => (c === "cliente" ? "locked" : null),
      }),
    );
    expect(plan.updates.map((u) => u.column)).toEqual(["obs", "estado", "obs"]);
    expect(plan.skipped).toEqual([
      { column: "id", reason: "key", count: 2 },
      { column: "cliente", reason: "policy", count: 2 },
    ]);
    expect(plan.preview[0].map((c) => c.state)).toEqual(["skip", "skip", "same", "write"]);
  });

  it("turns the rows below the last one into new rows, leaving generated keys and empty cells to the database", () => {
    const plan = planPaste(
      input({
        block: [["1", "Ruiz", "Abierto", ""], ["", "Nava", "", "nuevo"], ["", "Lema", "Abierto", ""]],
        rows: rows.slice(0, 1),
      }),
    );
    expect(plan.inserts).toEqual([
      [
        { column: "cliente", value: "Nava", columnType: "varchar" },
        { column: "obs", value: "nuevo", columnType: "varchar" },
      ],
      [
        { column: "cliente", value: "Lema", columnType: "varchar" },
        { column: "estado", value: "Abierto", columnType: "varchar" },
      ],
    ]);
    expect(plan.skipped).toEqual([
      { column: "id", reason: "key", count: 1 },
      { column: "id", reason: "generated", count: 2 },
    ]);
    expect(plan.missingOnInsert).toEqual([]);
  });

  it("names a required column the new rows leave empty", () => {
    const plan = planPaste(
      input({ columns: columns.slice(2), block: [["a"], ["b"], ["c"]] }),
    );
    expect(plan.inserts).toHaveLength(1);
    expect(plan.missingOnInsert).toEqual(["cliente"]);
  });

  it("adds no rows where the role may not insert, and limits them to the policy's columns", () => {
    const block = [["", "Ruiz", "x", "y"], ["", "Nava", "a", "b"], ["", "Lema", "c", "d"]];
    const denied = planPaste(input({ block, canInsert: false }));
    expect(denied.inserts).toEqual([]);
    expect(denied.skipped).toContainEqual({ column: "cliente", reason: "noInsert", count: 1 });

    const limited = planPaste(input({ block, insertLock: (c) => (c === "obs" ? "locked" : null) }));
    expect(limited.inserts[0].map((v) => v.column)).toEqual(["cliente", "estado"]);
    expect(limited.skipped).toContainEqual({ column: "obs", reason: "policy", count: 1 });
  });

  it("drops what is wider than the grid and normalises BIT and empty cells", () => {
    const plan = planPaste(
      input({
        columns: [col("flag", "bit"), col("cliente")],
        columnIndexByName: new Map([
          ["id", 0],
          ["cliente", 1],
          ["flag", 4],
        ]),
        rows: [[1, "Ruiz", "Abierto", null, "0"]],
        bitColumns: new Set(["flag"]),
        block: [["true", "", "extra"]],
      }),
    );
    expect(plan.droppedColumns).toBe(1);
    // `cliente` is NOT NULL: an empty cell is an empty string there, not NULL.
    expect(plan.updates).toEqual([
      { pkValues: [1], column: "flag", value: "1", columnType: "bit" },
      { pkValues: [1], column: "cliente", value: "", columnType: "varchar" },
    ]);
  });
});
