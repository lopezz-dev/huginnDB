/**
 * One connection's MCP row cap, next to its write policy in Settings → MCP.
 *
 * Blank means "follow the default", which the placeholder shows, so the common
 * case is an empty field rather than every row restating the same number.
 * Saved on blur or Enter rather than per keystroke: typing "500" would
 * otherwise write 5, then 50, then 500 — three disk writes and three toasts.
 * A value that is not a limit is put back rather than saved.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Input } from "@/components/ui/input";
import {
  MAX_MCP_MAX_ROWS,
  MIN_MCP_MAX_ROWS,
  parseMcpMaxRows,
} from "@/lib/connection/mcpMaxRows";

export function McpMaxRowsInput({
  name,
  value,
  fallback,
  onChange,
}: {
  /** The connection's name, for the field's accessible label. */
  name: string;
  /** The connection's own limit; `null`/`undefined` follows `fallback`. */
  value: number | null | undefined;
  /** The global default, shown as the placeholder. */
  fallback: number;
  onChange: (rows: number | null) => void;
}) {
  const { t } = useTranslation();
  const saved = value == null ? "" : String(value);
  const [draft, setDraft] = useState(saved);
  useEffect(() => setDraft(saved), [saved]);

  function commit() {
    const parsed = parseMcpMaxRows(draft);
    if (parsed === undefined) {
      setDraft(saved);
      return;
    }
    if (parsed !== (value ?? null)) onChange(parsed);
  }

  return (
    <Input
      type="number"
      inputMode="numeric"
      min={MIN_MCP_MAX_ROWS}
      max={MAX_MCP_MAX_ROWS}
      size="xs"
      value={draft}
      placeholder={String(fallback)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
      aria-label={t("settings.mcp.maxRows.rowLabel", { name })}
      title={t("settings.mcp.maxRows.rowTitle", { rows: fallback })}
      className="w-20 shrink-0 text-right font-mono"
    />
  );
}
