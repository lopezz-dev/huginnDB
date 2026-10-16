/**
 * Reusable row layout for a single preference: label + description on the
 * left, control on the right. All settings sections compose these.
 *
 * A row that passes `prefId` becomes addressable: the command palette can send
 * the user straight to it (`useSettingsDialog.openAtPref`), and the row scrolls
 * itself into view and flashes a ring so the setting is findable in a long
 * section. The id must match the `prefId` the palette's settings registry uses
 * for that preference (`src/lib/commandPalette/settingsRegistry.ts`) — the two
 * halves are joined by that string alone. `PrefId` narrows it to a real
 * preference path so a mismatch is a compile error instead of "the section
 * opens, nothing is highlighted".
 *
 * The same id is what lets a row say it has **moved off its default**: a dot
 * before the label and a reset button beside the control, with no per-row
 * wiring, because a `PrefId` is already the path to read in both the live prefs
 * and the defaults. Which settings get that treatment is `lib/prefDefaults.ts`'s
 * call (the AI endpoint and the UI language do not).
 */

import { useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { RotateCcw } from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";
import { Label } from "@/components/ui/label";
import { useSettingsDialog } from "@/components/settings/useSettingsDialog";
import { DEFAULT_PREFS, usePreferences } from "@/stores/preferences/preferences";
import { readPref, resettablePath } from "@/lib/prefDefaults";
import type { PrefId } from "@/lib/prefId";
import { cn } from "@/lib/utils";
import { PrefGroupContext } from "./PrefGroup";

/** How long the ring stays on after a jump. */
const FLASH_MS = 1600;

interface Props {
  label: string;
  description?: string;
  htmlFor?: string;
  /** Stable id making this row a jump target for the command palette. */
  prefId?: PrefId;
  /**
   * Full-width line under the label and the control, inside the row: what the
   * setting currently resolves to ("found mongosh 2.3 at …") or why it does
   * not. It belongs to the row, so it gets the row's inset and sits above the
   * hairline — a status rendered as a sibling of the row ran edge to edge of
   * the group card, with no padding, under the wrong divider.
   */
  footer?: React.ReactNode;
  children: React.ReactNode;
}

export function PrefRow({
  label,
  description,
  htmlFor,
  prefId,
  footer,
  children,
}: Props) {
  const { t } = useTranslation();
  const inGroup = useContext(PrefGroupContext);
  const highlightPrefId = useSettingsDialog((s) => s.highlightPrefId);
  const clearHighlight = useSettingsDialog((s) => s.clearHighlight);
  const [flashing, setFlashing] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const path = prefId ? resettablePath(prefId) : null;
  // A boolean out of the selector, never the value: primitives keep the
  // subscription stable, and the row only needs to re-render when it crosses
  // the default, not on every keystroke in its own input.
  const modified = usePreferences((s) =>
    path ? !Object.is(readPref(s.prefs, path), readPref(DEFAULT_PREFS, path)) : false,
  );
  const resetPrefs = usePreferences((s) => s.resetPrefs);

  // Consume the request as soon as it lands: clearing the store immediately
  // (rather than after the timeout) keeps the flash tied to the navigation that
  // asked for it, so re-opening the same section later doesn't replay it.
  useEffect(() => {
    if (!prefId || highlightPrefId !== prefId) return;
    clearHighlight();
    setFlashing(true);
    // The section pane has just mounted; wait a frame so the scroll lands on a
    // laid-out element rather than a zero-height one.
    const raf = requestAnimationFrame(() =>
      ref.current?.scrollIntoView({ block: "center", behavior: "smooth" }),
    );
    const timer = window.setTimeout(() => setFlashing(false), FLASH_MS);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
    };
  }, [prefId, highlightPrefId, clearHighlight]);

  const resetLabel = (() => {
    if (!path) return "";
    const value = readPref(DEFAULT_PREFS, path);
    // Only values that read well out of context: "Reset to default (13)" helps,
    // "Reset to default (modal)" would leak an enum's spelling into the UI.
    if (typeof value === "number") return t("settings.resetToDefaultValue", { value });
    if (typeof value === "boolean")
      return t("settings.resetToDefaultValue", {
        value: t(value ? "commandPalette.settings.on" : "commandPalette.settings.off"),
      });
    return t("settings.resetToDefault");
  })();

  return (
    <div
      ref={ref}
      data-pref-id={prefId}
      data-modified={modified || undefined}
      className={cn(
        "border-b border-border/60 py-3 last:border-b-0",
        inGroup && "px-4",
        // One blue pulse on arrival (`animate-brand-flash`, ~0.5s) settling
        // into the persistent ring — the "small blue spark when an action
        // completes" microdetail of the brand language, on the one navigation
        // that genuinely completes somewhere the user can't see yet. Inside a
        // group card the ring is inset instead: the card clips its children,
        // and the negative margin that works on a flush row would be cut off.
        flashing &&
          (inGroup
            ? "animate-brand-flash bg-brand/10 ring-1 ring-inset ring-brand/60 transition-colors"
            : "-mx-2 animate-brand-flash rounded-md bg-brand/10 px-2 ring-1 ring-brand/60 transition-colors"),
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <div className="flex items-center gap-1.5">
            {modified && (
              <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand" />
            )}
            <Label htmlFor={htmlFor} className="text-sm font-medium">
              {label}
            </Label>
            {modified && <span className="sr-only">{t("settings.changed")}</span>}
          </div>
          {description && (
            <div className="mt-0.5 text-2xs leading-snug text-muted-foreground">
              {description}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-start gap-1">
          {modified && prefId && (
            <IconButton
              size="xs"
              icon={RotateCcw}
              label={resetLabel}
              tone="brand"
              flat
              className="mt-0.5"
              onClick={() => resetPrefs([prefId])}
            />
          )}
          {children}
        </div>
      </div>
      {footer && <div className="mt-2">{footer}</div>}
    </div>
  );
}
