/**
 * One per-connection MCP limit in Settings → MCP — the field behind
 * `McpMaxRowsInput`, `McpTimeoutInput` and `McpConcurrentReadsInput`, which
 * only say which limit it is.
 *
 * Blank means "follow the default", which the placeholder shows, so the common
 * case is an empty field rather than every row restating the same number.
 * Saved on blur or Enter rather than per keystroke: typing "500" would
 * otherwise write 5, then 50, then 500 — three disk writes and three toasts.
 * A value that is not a limit is put back rather than saved.
 */

import { useEffect, useState } from "react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export function McpLimitInput({
  value,
  min,
  max,
  fallback,
  parse,
  label,
  title,
  onChange,
  width = "w-20",
}: {
  /** The connection's own limit; `null`/`undefined` follows `fallback`. */
  value: number | null | undefined;
  min: number;
  max: number;
  /** The default it follows when blank, shown as the placeholder. */
  fallback: number;
  /** What a typed value means — `lib/connection/mcpLimit.ts`'s rule. */
  parse: (raw: string) => number | null | undefined;
  /** Accessible label, naming the connection. */
  label: string;
  title: string;
  onChange: (value: number | null) => void;
  width?: string;
}) {
  const saved = value == null ? "" : String(value);
  const [draft, setDraft] = useState(saved);
  useEffect(() => setDraft(saved), [saved]);

  function commit() {
    const parsed = parse(draft);
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
      min={min}
      max={max}
      size="xs"
      value={draft}
      placeholder={String(fallback)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
      aria-label={label}
      title={title}
      className={cn(width, "shrink-0 text-right font-mono")}
    />
  );
}
