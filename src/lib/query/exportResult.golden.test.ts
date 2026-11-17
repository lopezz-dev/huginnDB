/**
 * The golden test the exported files share with the clipboard (ADR #137,
 * ADR #138).
 *
 * Every exported file is written in Rust (`src-tauri/src/db/result_export.rs`);
 * "Copy as ▸ CSV / JSON / INSERT" writes the same rows from here
 * (`lib/grid/copyFormats`). Both must produce the same bytes, so one fixture
 * is serialised by each language and compared with the same committed files
 * in `testdata/result-export/`. The Rust half is
 * `db::result_export::tests::the_golden_files_match`.
 *
 * When a format changes on purpose, regenerate the expected files from here
 * (`UPDATE_GOLDEN=1 pnpm vitest run src/lib/query/exportResult.golden.test.ts`)
 * and change the Rust writer until its test passes too.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { toBulk, toCsv, type SqlTarget } from "@/lib/grid/copyFormats";
import type { CellValue, ColumnMeta, Driver } from "@/types";

const dir = (name: string) =>
  fileURLToPath(new URL(`../../../testdata/result-export/${name}`, import.meta.url));

interface Fixture {
  columns: string[];
  rows: CellValue[][];
  /** Positional: the table column each result column is, `null` for an expression. */
  target: { table: string; columns: (string | null)[] };
}

const fixture: Fixture = JSON.parse(readFileSync(dir("fixture.json"), "utf8"));
const columns: ColumnMeta[] = fixture.columns.map((name) => ({ name, data_type: "text" }));
const target: SqlTarget = {
  table: fixture.target.table,
  columnOf: (name) => fixture.target.columns[fixture.columns.indexOf(name)] ?? null,
  pkColumns: [],
};

type TextFormat = "csv" | "csvSemicolon" | "json" | "sql";

/** What a file of `format` holds for these rows, written the clipboard's way. */
function serialize(format: TextFormat, rows: CellValue[][], driver: Driver): string {
  switch (format) {
    case "csv":
      return toCsv(rows, columns, ",");
    case "csvSemicolon":
      return toCsv(rows, columns, ";");
    case "json":
      return toBulk(rows, "json", { columns, driver });
    case "sql":
      return `${toBulk(rows, "insert", { columns, driver, target })}
`;
  }
}

const GOLDEN: [TextFormat, Driver, string][] = [
  ["csv", "postgres", "expected.csv"],
  ["csvSemicolon", "postgres", "expected-semicolon.csv"],
  ["json", "postgres", "expected.json"],
  ["sql", "postgres", "expected-postgres.sql"],
  ["sql", "mysql", "expected-mysql.sql"],
  ["sql", "sqlserver", "expected-sqlserver.sql"],
];

describe("result export golden files", () => {
  it.each(GOLDEN)("%s (%s) matches %s", (format, driver, file) => {
    const text = serialize(format, fixture.rows, driver);
    if (process.env.UPDATE_GOLDEN) writeFileSync(dir(file), text, "utf8");
    expect(text).toBe(readFileSync(dir(file), "utf8"));
  });
});
