/**
 * SQL pretty-printing — for cell values and for the query editor's Format
 * (`formatQuery`, ADR #137) — and the driver → dialect map behind it. Moved
 * from `lib/grid/` when the editor became its second consumer.
 *
 * **This is the only file in the repo that imports `sql-formatter`.** That is
 * deliberate: the package is the one heavy dependency this feature adds, and
 * keeping its import surface to a single module means that if the bundle cost
 * ever stops being acceptable, moving it behind a dynamic `import()` is a
 * one-file change rather than a refactor of the components that format.
 *
 * Two things about how it is imported are load-bearing:
 *
 * - **`formatDialect` rather than `format`.** `format(sql, { language: "postgresql" })`
 *   takes the dialect as a *string*, which means the string-to-dialect map is
 *   reachable from the entry point and every one of the twenty-odd dialects
 *   (BigQuery, Snowflake, Trino, Hive…) is pulled into the bundle.
 *   `formatDialect` takes the dialect object, so only the five imported below
 *   survive tree-shaking — the package declares `sideEffects: false`, so this
 *   actually works.
 * - **The map is a total `Record<Driver, …>`.** Adding a driver to the union in
 *   `types.ts` becomes a compile error here instead of silently falling back to
 *   generic SQL for the new engine.
 */

import {
  formatDialect,
  mysql,
  postgresql,
  sql,
  sqlite,
  transactsql,
  type DialectOptions,
} from "sql-formatter";
import type { Driver } from "@/types";

/**
 * HuginnDB's drivers mapped onto `sql-formatter`'s dialects.
 *
 * MongoDB maps to standard `sql` purely so the record stays total. A MongoDB
 * cell holds JSON and `detectLanguage` says so, which is the branch that
 * actually runs; the only way to reach the SQL branch on a Mongo connection is
 * a field that literally stores a query string, and neutral standard SQL is the
 * honest guess for text whose real dialect nothing on screen knows.
 */
const SQL_DIALECT: Record<Driver, DialectOptions> = {
  postgres: postgresql,
  mysql: mysql,
  sqlite: sqlite,
  sqlserver: transactsql,
  mongodb: sql,
};

/**
 * Dialect for a driver, falling back to standard SQL when there is no driver at
 * all — an ad-hoc query-result grid has no connection identity, and a profile
 * can vanish underneath a still-open tab. Mirrors how `quoteIdent` falls back
 * to ANSI quoting for an unknown driver.
 */
export function sqlDialectFor(driver?: Driver): DialectOptions {
  return driver ? SQL_DIALECT[driver] : sql;
}

/**
 * Pretty-print a SQL statement, or return it untouched if it cannot be parsed.
 *
 * The try/catch is not defensive padding: `detectLanguage` calls something SQL
 * when it merely *starts* with a familiar verb, so this is routinely handed
 * text that is not a valid statement, and `sql-formatter` throws on input it
 * cannot tokenise. Returning the input matches `tryFormat`'s standing contract
 * that the user never loses their content to a formatter.
 *
 * `tabWidth` is fixed at 2 to match the JSON and XML indenters rather than
 * threading `editor.tabSize` in, which would make the whole formatting path
 * take a preferences argument and stop being pure.
 */
export function formatSql(text: string, dialect: DialectOptions): string {
  try {
    return formatDialect(text, {
      dialect,
      tabWidth: 2,
      keywordCase: "upper",
    });
  } catch {
    return text;
  }
}
