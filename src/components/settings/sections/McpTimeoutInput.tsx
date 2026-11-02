/**
 * One connection's MCP timeout ceiling, next to its row cap in Settings → MCP.
 *
 * The same field as `McpMaxRowsInput`, for the same reasons: blank follows the
 * default the placeholder shows, saved on blur or Enter rather than per
 * keystroke, and a value that is not a ceiling is put back rather than saved.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Input } from "@/components/ui/input";
import {
  DEFAULT_MCP_TIMEOUT_SECS,
  MAX_MCP_TIMEOUT_SECS,
  MIN_MCP_TIMEOUT_SECS,
  parseMcpTimeoutSecs,
} from "@/lib/connection/mcpTimeout";

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
  const saved = value == null ? "" : String(value);
  const [draft, setDraft] = useState(saved);
  useEffect(() => setDraft(saved), [saved]);

  function commit() {
    const parsed = parseMcpTimeoutSecs(draft);
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
      min={MIN_MCP_TIMEOUT_SECS}
      max={MAX_MCP_TIMEOUT_SECS}
      size="xs"
      value={draft}
      placeholder={String(DEFAULT_MCP_TIMEOUT_SECS)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
      aria-label={t("settings.mcp.timeout.rowLabel", { name })}
      title={t("settings.mcp.timeout.rowTitle", {
        secs: DEFAULT_MCP_TIMEOUT_SECS,
      })}
      className="w-20 shrink-0 text-right font-mono"
    />
  );
}
