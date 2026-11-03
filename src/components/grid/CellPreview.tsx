/**
 * Compact floating cell-value preview panel, anchored to the bottom-right
 * of the DataGrid container.
 *
 * Shows the column name, detected content type (JSON / XML / SQL / text),
 * a formatted preview of the cell value, and keyboard shortcut hints for
 * fullscreen view, saving, and closing.
 *
 * F11 / the fullscreen button escalates to the full Monaco-based CellEditor.
 * Esc closes the panel without discarding anything.
 */

import { useEffect, useMemo } from "react";
import { X, Maximize2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { detectLanguage } from "@/lib/grid/detectContentType";
import { autoFormatOnOpen } from "@/lib/grid/autoFormat";
import { useConnectionDriver } from "@/lib/connection/useConnectionDriver";
import {
  usePreferences,
  selectEditorPrefs,
  selectGridPrefs,
} from "@/stores/preferences/preferences";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import type { CellValue } from "@/types";

/** Maps a detected content language to the badge label shown in the header. */
const LANG_BADGE: Record<string, string> = {
  json: "JSON",
  xml: "XML",
  sql: "SQL",
  plaintext: "TEXT",
};

interface Props {
  /** Column name displayed in the panel header. */
  columnName: string;
  /** Raw cell value from the query result. */
  value: CellValue;
  /** Called when the user closes the panel (Esc or ×). */
  onClose: () => void;
  /** Called when the user requests the full Monaco editor (F11). */
  onFullscreen: () => void;
  /**
   * If provided, the panel renders a Save action (Ctrl+S / ⌘S).
   * Receives the current display text; the caller is responsible for
   * persisting it via `api.updateCell`.
   */
  onSave?: (value: string) => Promise<void>;
  /**
   * If provided, the panel renders a "Set NULL" action (Ctrl+Shift+N).
   * Persists `null` for the cell via the caller's update path.
   */
  onSetNull?: () => Promise<void>;
  /** Connection this cell belongs to, used only to pick the SQL dialect when
   *  the value is a query string. Absent for grids with no connection
   *  identity, which then format as standard SQL. */
  connectionId?: string;
  /**
   * Set when the cell was left on the server (ADR #133): `value` is only its
   * stand-in `null`. The panel then shows `label` (its type and size) and a
   * button that loads the row, after which it is handed the real value.
   */
  trimmed?: { label: string; onLoad: () => void };
}

export function CellPreview({
  columnName,
  value,
  onClose,
  onFullscreen,
  onSave,
  onSetNull,
  connectionId,
  trimmed,
}: Props) {
  /** String representation of the raw cell value. */
  const rawText = useMemo(() => {
    if (value === null || value === undefined) return "";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  }, [value]);

  /** Content type detected from the raw text. Recomputed only when value changes. */
  const lang = useMemo(() => detectLanguage(rawText), [rawText]);

  const editorPrefs = usePreferences(selectEditorPrefs);
  const driver = useConnectionDriver(connectionId ?? "");

  /**
   * Formatted display text (pretty-printed JSON, indented XML, …), subject to
   * the per-type preferences.
   *
   * This panel used to format unconditionally, which is why `autoFormatJson`
   * and `autoFormatXml` ship **on** — off would have silently taken that away
   * from every existing install rather than being a neutral default.
   *
   * Note what this is NOT wired into: `onSave` below sends `rawText`, never
   * `formatted`. That asymmetry is deliberate and worth preserving — the
   * preview's formatting is display-only and can never write, which is exactly
   * why enabling it by default carries no risk on this surface. The editors,
   * where the formatted text *does* become what gets saved, are the ones that
   * need `autoFormatOnOpen`'s losslessness check.
   */
  const formatted = useMemo(
    () => autoFormatOnOpen(rawText, lang, editorPrefs, driver),
    [rawText, lang, editorPrefs, driver],
  );

  /** Handle keyboard shortcuts: F11 → fullscreen, Esc → close, Ctrl+S → save. */
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "F11") {
        e.preventDefault();
        onFullscreen();
      } else if (e.key === "Escape") {
        onClose();
      } else if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        onSave?.(rawText);
      } else if (
        (e.ctrlKey || e.metaKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === "n"
      ) {
        e.preventDefault();
        onSetNull?.();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onFullscreen, onSave, onSetNull, rawText]);

  const { t } = useTranslation();
  const nullDisplay = usePreferences((s) => selectGridPrefs(s).nullDisplay);
  const isNull = value === null || value === undefined;

  return (
    <div
      className={cn(
        "absolute bottom-2 right-2 z-20 flex w-80 flex-col",
        "rounded-lg border border-border bg-card shadow-elevation-4",
        "overflow-hidden",
      )}
    >
      {/* Header: column name + content-type badge + close button */}
      <div className="flex items-center justify-between border-b border-border py-1 pl-3 pr-1.5">
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">{t("cellPreview.cell")}</span>
          <span className="text-muted-foreground/40">·</span>
          <span className="font-medium">{columnName}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-3xs text-muted-foreground">
            {LANG_BADGE[lang] ?? "TEXT"}
          </span>
          <IconButton
            size="xs"
            icon={X}
            label={t("cellPreview.closeEsc")}
            onClick={onClose}
          />
        </div>
      </div>

      {/* Content: formatted value */}
      <div className="max-h-48 overflow-auto p-3">
        {trimmed ? (
          <div className="flex items-center gap-2 text-xs">
            <span className="font-mono italic text-muted-foreground">
              {trimmed.label}
            </span>
            <Button
              variant="outline"
              size="xs"
              className="ml-auto"
              onClick={trimmed.onLoad}
            >
              {t("dataGrid.trimmed.load")}
            </Button>
          </div>
        ) : isNull ? (
          <span className="font-mono text-xs italic text-muted-foreground">
            {nullDisplay}
          </span>
        ) : (
          <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed">
            {formatted}
          </pre>
        )}
      </div>

      {/* Footer: keyboard shortcut hints */}
      <div className="flex items-center gap-3 border-t border-border px-3 py-1.5 text-3xs text-muted-foreground/70">
        <button
          className="flex items-center gap-1 hover:text-muted-foreground"
          onClick={onFullscreen}
          title={t("cellPreview.openFullEditor")}
        >
          <Maximize2 className="h-3 w-3" />
          <span>{t("cellPreview.fullscreenHint")}</span>
        </button>
        {onSave && (
          <button
            className="hover:text-muted-foreground"
            onClick={() => onSave(rawText)}
            title={t("cellPreview.saveTitle")}
          >
            {t("cellPreview.saveHint")}
          </button>
        )}
        {onSetNull && (
          <button
            className="hover:text-muted-foreground"
            onClick={() => onSetNull()}
            title={t("cellPreview.setNullTitle")}
          >
            {t("cellPreview.setNullHint")}
          </button>
        )}
        <button
          className="ml-auto hover:text-muted-foreground"
          onClick={onClose}
        >
          {t("cellPreview.closeHint")}
        </button>
      </div>
    </div>
  );
}
