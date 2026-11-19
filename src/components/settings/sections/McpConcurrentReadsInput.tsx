/**
 * How many AI reads may run at once against one connection (ADR #141), next
 * to its timeout in Settings → MCP. The field's behaviour is
 * `McpLimitInput`'s.
 */

import { useTranslation } from "react-i18next";

import {
  DEFAULT_MCP_CONCURRENT_READS,
  MAX_MCP_CONCURRENT_READS,
  MIN_MCP_CONCURRENT_READS,
  parseMcpConcurrentReads,
} from "@/lib/connection/mcpConcurrentReads";

import { McpLimitInput } from "./McpLimitInput";

export function McpConcurrentReadsInput({
  name,
  value,
  onChange,
}: {
  /** The connection's name, for the field's accessible label. */
  name: string;
  /** The connection's own limit; `null`/`undefined` follows the default. */
  value: number | null | undefined;
  onChange: (reads: number | null) => void;
}) {
  const { t } = useTranslation();
  return (
    <McpLimitInput
      value={value}
      min={MIN_MCP_CONCURRENT_READS}
      max={MAX_MCP_CONCURRENT_READS}
      fallback={DEFAULT_MCP_CONCURRENT_READS}
      parse={parseMcpConcurrentReads}
      label={t("settings.mcp.concurrentReads.rowLabel", { name })}
      title={t("settings.mcp.concurrentReads.rowTitle", {
        reads: DEFAULT_MCP_CONCURRENT_READS,
      })}
      onChange={onChange}
      width="w-12"
    />
  );
}
