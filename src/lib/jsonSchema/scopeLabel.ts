/**
 * Human-readable label for a binding's scope.
 *
 * Presentation only. There is deliberately no matching logic here — the cascade,
 * the glob and the specificity ranking live exclusively in Rust
 * (`src-tauri/src/json_schemas/mod.rs`), and a helper in this file growing a
 * "does this match?" branch would be the first step toward the second
 * implementation ADRs #30/#33 exist to prevent.
 */

import type { JsonSchemaBinding } from "@/types";

/** The four axes, with `null` meaning "any". */
export type BindingScope = Pick<
  JsonSchemaBinding,
  "connectionId" | "dbSchema" | "table" | "column"
>;

/**
 * Render a scope as `conn · public · widgets · configuration`.
 *
 * A wildcard axis renders as the glyph `*`, never as an empty segment: an empty
 * cell reads as "not filled in yet", which is the single most common
 * misreading of a cascade table.
 *
 * `connectionName` resolves the connection id to something the user recognises;
 * without it the id is shown truncated, which is still better than nothing when
 * the profile has been deleted.
 */
export function formatScopeLabel(
  scope: BindingScope,
  t: (key: string) => string,
  connectionName?: (id: string) => string | undefined,
): string {
  const any = "*";
  const conn = scope.connectionId
    ? (connectionName?.(scope.connectionId) ?? shortId(scope.connectionId))
    : any;
  const parts = [
    conn,
    scope.dbSchema || any,
    scope.table || any,
    scope.column || t("jsonSchemas.scope.columnMissing"),
  ];
  return parts.join(" · ");
}

/** First segment of a uuid — enough to tell two apart in a label. */
function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}
