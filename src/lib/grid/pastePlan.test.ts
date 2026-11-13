import { describe, expect, it } from "vitest";
import type { CellValue, ColumnInfo, ColumnMeta } from "@/types";
import en from "@/lib/i18n/locales/en.json";
import es from "@/lib/i18n/locales/es.json";
import { SKIP_REASONS, planPaste, type PastePlanInput } from "./pastePlan";

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
    keyOf: (row) => [row[0]],
    pkColumns: ["id"],
    columnInfo: new Map([
      ["id", info("id", { data_type: "int", nullable: false, is_primary_key: true })],
      ["cliente", info("cliente", { nullable: false })],
      ["estado", info("estado")],
      ["obs", info("obs")],
    ]),
    bitColumns: new Set(),
    canUpdate: true,
    newRows: "allowed",
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
    const denied = planPaste(input({ block, newRows: "policy" }));
    expect(denied.inserts).toEqual([]);
    expect(denied.skipped).toContainEqual({ column: "cliente", reason: "noInsert", count: 1 });

    // A view is not a policy matter, and the dialog must not say it is.
    const view = planPaste(input({ block, newRows: "view" }));
    expect(view.inserts).toEqual([]);
    expect(view.skipped).toContainEqual({ column: "cliente", reason: "view", count: 1 });

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

// A query's result: `SELECT estado AS st, upper(obs) AS o2, id AS pk FROM
// pedidos` — an alias, an expression, and the key itself under an alias.
describe("planPaste — result columns that are not table columns", () => {
  const resultCols = [col("st"), col("o2"), col("pk", "int")];
  const resultRows: CellValue[][] = [
    ["Abierto", "X", 1],
    ["Cerrado", "OK", 2],
  ];
  const tableOf: Record<string, string | null> = { st: "estado", o2: null, pk: "id" };
  const query = (over: Partial<PastePlanInput> = {}) =>
    input({
      rows: resultRows,
      columns: resultCols,
      columnIndexByName: new Map(resultCols.map((c, i) => [c.name, i])),
      columnOf: (name) => tableOf[name] ?? null,
      keyOf: (row) => [row[2]],
      newRows: "result",
      ...over,
    });

  it("writes an alias to the table column it stands for, keyed by the row's key", () => {
    const plan = planPaste(query({ block: [["En curso"]] }));
    expect(plan.updates).toEqual([
      { pkValues: [1], column: "estado", value: "En curso", columnType: "varchar" },
    ]);
    // What the person sees keeps the result's name.
    expect(plan.previewColumns).toEqual(["st"]);
  });

  it("leaves an expression out, by the name shown", () => {
    const plan = planPaste(query({ block: [["En curso", "nuevo"]] }));
    expect(plan.updates.map((u) => u.column)).toEqual(["estado"]);
    expect(plan.skipped).toContainEqual({ column: "o2", reason: "computed", count: 1 });
  });

  it("knows the key under its alias", () => {
    const plan = planPaste(query({ columns: [resultCols[2]], block: [["9"]] }));
    expect(plan.updates).toEqual([]);
    expect(plan.skipped).toContainEqual({ column: "pk", reason: "key", count: 1 });
  });

  it("judges the policy on the table column", () => {
    const plan = planPaste(
      query({ block: [["En curso"]], updateLock: (c) => (c === "estado" ? "no" : null) }),
    );
    expect(plan.updates).toEqual([]);
    expect(plan.skipped).toContainEqual({ column: "st", reason: "policy", count: 1 });
  });

  it("adds no rows below a result, saying why", () => {
    const plan = planPaste(query({ block: [["a"], ["b"], ["c"]] }));
    expect(plan.inserts).toEqual([]);
    expect(plan.skipped).toContainEqual({ column: "st", reason: "result", count: 1 });
  });

  it("normalises a BIT by its table column", () => {
    const plan = planPaste(
      query({ block: [["true"]], bitColumns: new Set(["estado"]) }),
    );
    expect(plan.updates[0]).toMatchObject({ column: "estado", value: "1" });
  });
});

describe("SKIP_REASONS", () => {
  // The dialog builds the key from the reason, which `keys.test.ts` cannot see.
  it.each(SKIP_REASONS)("%s has its sentence in both locales", (reason) => {
    const at = (locale: unknown) =>
      (locale as { dataGrid: { paste: { reason: Record<string, unknown> } } }).dataGrid
        .paste.reason[reason];
    expect(typeof at(en)).toBe("string");
    expect(typeof at(es)).toBe("string");
  });
});
