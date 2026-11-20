/**
 * Every `t("literal")` in the source resolves, and the two locales agree.
 *
 * This exists because a missing key is **invisible to every other check**.
 * TypeScript does not type `t()`'s argument, no test mounts every component,
 * and i18next's own fallback is to render the key itself — so the failure
 * ships as `common.previous` sitting in a button where a word should be, and
 * is only found by someone looking at that button. It was: a pagination footer
 * went out referencing two keys that had never been added.
 *
 * Only string literals are checked. A key built from a variable
 * (`t(\`settings.appearance.importError.${e.message}\`)`) cannot be resolved
 * statically, and guessing at the possible suffixes would either miss cases or
 * invent them.
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import en from "./locales/en.json";
import es from "./locales/es.json";
import { localeEntries } from "./localeEntries";

const SRC = join(process.cwd(), "src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [path] : [];
  });
}

const keysOf = (locale: unknown) => new Set(localeEntries(locale).map(([key]) => key));
const EN_KEYS = keysOf(en);
const ES_KEYS = keysOf(es);

/**
 * i18next resolves a plural key to `<key>_one` / `<key>_other` (and the other
 * CLDR categories), so a call site naming the bare key is correct even though
 * the bare key is absent from the file.
 */
const PLURAL_SUFFIXES = ["_one", "_other", "_zero", "_two", "_few", "_many"];

function resolves(key: string, keys: Set<string>): boolean {
  return keys.has(key) || PLURAL_SUFFIXES.some((s) => keys.has(`${key}${s}`));
}

/** Every `t("…")` with a literal argument, as `[key, file]`. */
function literalCalls(): [key: string, file: string][] {
  const calls: [string, string][] = [];
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, "utf-8");
    for (const m of text.matchAll(/\bt\(\s*"([^"$`]+)"/g)) {
      calls.push([m[1], file.slice(SRC.length + 1).replace(/\\/g, "/")]);
    }
  }
  return calls;
}

describe("i18n keys", () => {
  it("every literal t() key exists in English", () => {
    const missing = literalCalls()
      .filter(([key]) => !resolves(key, EN_KEYS))
      .map(([key, file]) => `${key}  (${file})`);
    expect(new Set(missing)).toEqual(new Set());
  });

  it("every literal t() key exists in Spanish", () => {
    // Separate assertion from the English one so a half-translated addition
    // names the language it is missing from rather than just "a key".
    const missing = literalCalls()
      .filter(([key]) => !resolves(key, ES_KEYS))
      .map(([key, file]) => `${key}  (${file})`);
    expect(new Set(missing)).toEqual(new Set());
  });

  it("the two locales carry the same keys", () => {
    // `CHANGELOG.es.md` is kept in step by hand and so is this file; the
    // difference is that this one can be checked. A key added to one locale
    // and forgotten in the other renders as the raw key for half the users.
    expect([...EN_KEYS].filter((k) => !ES_KEYS.has(k)).sort()).toEqual([]);
    expect([...ES_KEYS].filter((k) => !EN_KEYS.has(k)).sort()).toEqual([]);
  });

  it("finds a meaningful number of call sites", () => {
    // Guards the extraction itself: a regex that silently stopped matching
    // would make all three tests above pass by checking nothing.
    expect(literalCalls().length).toBeGreaterThan(500);
  });
});
