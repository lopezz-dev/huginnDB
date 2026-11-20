/**
 * Spanish says "consulta", not "query".
 *
 * The anglicism crept into es.json one string at a time ("Nueva query",
 * "pestaña de query", "historial de queries") while the explorer and the
 * command palette already said "consulta", so the same thing had two names
 * depending on where you looked. Decided with the maintainer on 2026-11-19.
 *
 * Only prose is checked: an interpolation (`{{query}}`) and an identifier
 * (`run_query`, `queryPlanner`) are not words a reader sees as Spanish.
 */

import { describe, expect, it } from "vitest";
import es from "./locales/es.json";
import { localeEntries } from "./localeEntries";


describe("Spanish terms", () => {
  it("es.json never uses 'query' as a Spanish word", () => {
    const found = localeEntries(es)
      .filter(([, v]) => /\bquer(y|ies)\b/i.test(v.replace(/\{\{[^}]*\}\}/g, "")))
      .map(([k, v]) => `${k}  ${JSON.stringify(v)}`);
    expect(found).toEqual([]);
  });
});
