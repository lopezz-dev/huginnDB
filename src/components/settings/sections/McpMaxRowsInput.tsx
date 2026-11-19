/**
 * One connection's MCP row cap, next to its write policy in Settings → MCP.
 * The field's behaviour is `McpLimitInput`'s.
 */

import { useTranslation } from "react-i18next";

import {
  MAX_MCP_MAX_ROWS,
  MIN_MCP_MAX_ROWS,
  parseMcpMaxRows,
} from "@/lib/connection/mcpMaxRows";

import { McpLimitInput } from "./McpLimitInput";

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
  return (
    <McpLimitInput
      value={value}
      min={MIN_MCP_MAX_ROWS}
      max={MAX_MCP_MAX_ROWS}
      fallback={fallback}
      parse={parseMcpMaxRows}
      label={t("settings.mcp.maxRows.rowLabel", { name })}
      title={t("settings.mcp.maxRows.rowTitle", { rows: fallback })}
      onChange={onChange}
    />
  );
}
