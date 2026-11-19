/**
 * One connection's MCP timeout ceiling, next to its row cap in Settings → MCP.
 * The field's behaviour is `McpLimitInput`'s.
 */

import { useTranslation } from "react-i18next";

import {
  DEFAULT_MCP_TIMEOUT_SECS,
  MAX_MCP_TIMEOUT_SECS,
  MIN_MCP_TIMEOUT_SECS,
  parseMcpTimeoutSecs,
} from "@/lib/connection/mcpTimeout";

import { McpLimitInput } from "./McpLimitInput";

export function McpTimeoutInput({
  name,
  value,
  onChange,
}: {
  /** The connection's name, for the field's accessible label. */
  name: string;
  /** The connection's own ceiling; `null`/`undefined` follows the default. */
  value: number | null | undefined;
  onChange: (secs: number | null) => void;
}) {
  const { t } = useTranslation();
  return (
    <McpLimitInput
      value={value}
      min={MIN_MCP_TIMEOUT_SECS}
      max={MAX_MCP_TIMEOUT_SECS}
      fallback={DEFAULT_MCP_TIMEOUT_SECS}
      parse={parseMcpTimeoutSecs}
      label={t("settings.mcp.timeout.rowLabel", { name })}
      title={t("settings.mcp.timeout.rowTitle", {
        secs: DEFAULT_MCP_TIMEOUT_SECS,
      })}
      onChange={onChange}
    />
  );
}
