/**
 * Lightweight content-type detection used by the cell editor.
 *
 * The detection is heuristic on purpose: we only need to decide which
 * Monaco language to apply when the user pops a cell open. False
 * positives degrade to "plaintext" via the language dropdown in the
 * editor.
 */

import { formatSql, sqlDialectFor } from "@/lib/sql/formatSql";
import type { Driver } from "@/types";

export type ContentLanguage = "json" | "xml" | "sql" | "plaintext";

/** Guess the content language by inspecting the first/last characters. */
export function detectLanguage(value: string): ContentLanguage {
  const s = value.trim();
  if (!s) return "plaintext";

  // JSON: starts/ends with matching brackets and parses cleanly.
  if (
    (s.startsWith("{") && s.endsWith("}")) ||
    (s.startsWith("[") && s.endsWith("]"))
  ) {
    try {
      JSON.parse(s);
      return "json";
    } catch {
      /* fall through */
    }
  }

  // XML: wrapped in angle brackets and contains at least one tag-looking
  // construct. We do not validate the document structure.
  if (s.startsWith("<") && s.endsWith(">") && /<\/?[a-zA-Z]/.test(s)) {
    return "xml";
  }

  // SQL: starts with a familiar verb. Catches DDL and DML.
  if (/^\s*(select|insert|update|delete|with|create|alter|drop)\b/i.test(s)) {
    return "sql";
  }

  return "plaintext";
}

/**
 * Best-effort pretty-print for the supported languages. Returns `value`
 * unchanged for plaintext or when formatting fails (so the user never
 * loses their content).
 *
 * **This is the raw formatter — it happily rewrites content, not just
 * whitespace.** `JSON.parse`/`stringify` loses integer precision past 2^53,
 * normalises `1.0` to `1`, dedupes duplicate keys and hoists integer-like ones;
 * `formatXml` does not parse at all. That is acceptable behind the explicit
 * "Format" button, where the click *is* the user accepting a rewrite. The
 * automatic path must go through `autoFormatOnOpen` instead, which refuses any
 * reformat that changed more than whitespace.
 *
 * `driver` only matters for `sql` — it picks the dialect. It is optional so the
 * call sites that have no connection identity (and the manual button before it
 * learned about drivers) keep compiling; SQL then formats as standard SQL.
 */
export function tryFormat(
  value: string,
  lang: ContentLanguage,
  driver?: Driver,
): string {
  if (lang === "json") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  if (lang === "xml") {
    return formatXml(value);
  }
  if (lang === "sql") {
    return formatSql(value, sqlDialectFor(driver));
  }
  return value;
}

/** Tiny XML indenter; does not parse the document, just lines up tags. */
function formatXml(xml: string): string {
  const PADDING = "  ";
  const reg = /(>)(<)(\/*)/g;
  const formatted = xml.replace(reg, "$1\n$2$3");
  let pad = 0;
  return formatted
    .split("\n")
    .map((line) => {
      let indent = 0;
      if (/^<\/.+>/.test(line)) {
        pad -= 1;
      } else if (/^<[^!?][^>]*[^/]>$/.test(line)) {
        indent = 1;
      }
      const padding = PADDING.repeat(Math.max(pad, 0));
      pad += indent;
      return padding + line;
    })
    .join("\n");
}
