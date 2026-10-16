/**
 * Empty-state screen shown when no tabs are open.
 *
 * Split out of `TabbedArea`, and with it the last copy of the key-cap markup
 * that `components/ui/kbd.tsx` exists to own — this one was inside a god file,
 * which is why the earlier sweep of eight call sites missed it. The overrides
 * passed to it reproduce the previous look exactly, `leading-normal` included,
 * since the shared component sets `leading-none` for the denser rows in the
 * command palette.
 */

import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";

import { WorkspacePicker } from "@/components/connection/WorkspacePicker";
import { useSettingsDialog } from "@/components/settings/useSettingsDialog";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { formatComboForDisplay, getBinding } from "@/lib/keybindings";
import { openQueryTab } from "@/lib/tabs/openQueryTab";
import { isMainWindow } from "@/lib/window";
import { useCommandPalette } from "@/stores/dialogs/commandPalette";
import { useConnectionDialog } from "@/stores/dialogs/connectionDialog";
import { usePreferences } from "@/stores/preferences/preferences";
import { useConnections } from "@/stores/session/connections";
import { useEnvironments } from "@/stores/session/environments";
import { useUi } from "@/stores/session/ui";

/**
 * Empty-state screen shown when no tabs are open.
 *
 * It used to be a logo, a line of text and a "New query" button floating
 * below the workspace picker (#110) with no relation to each other, plus a
 * lot of dead space on wide windows — the reported inconsistency. This
 * composes the same pieces (hero, hint, picker) into one column with a
 * shared visual frame: the "new query" action now sits inline with the hint
 * it belongs to instead of hanging on its own underneath, the picker gets a
 * console-style card so it reads as the deliberate focal panel rather than a
 * loose block, and a subtle dot-grid + brand glow fills the backdrop instead
 * of leaving flat empty space. A fresh install (no profiles, no picker to
 * show) now gets an actual "New connection" call to action instead of just
 * static hint text — previously the least useful screen in the app at the
 * moment you most need a way in. The keyboard-shortcut footer reads the
 * user's live rebindings (`getBinding`), never hardcoded combos, and doubles
 * as a real trigger for the command palette / preferences.
 */
export function EmptyWatermark() {
  const { t } = useTranslation();
  const connectionId = useUi((s) => s.selectedConnectionId);
  const hasProfiles = useConnections((s) => s.profiles.length > 0);
  const environments = useEnvironments((s) => s.environments);
  // Same guard as `WorkspacePicker` itself — left main-window-only for now,
  // see that component's comment.
  const showEnvironments = isMainWindow() && environments.length > 1;
  const showPicker = hasProfiles || showEnvironments;

  // The File menu's manager, not a dialog of our own: a private instance was
  // out of reach of the store, so the origin editor could not put it aside.
  const openNewConnection = useConnectionDialog((s) => s.openNew);
  const togglePalette = useCommandPalette((s) => s.toggle);
  const openSettings = useSettingsDialog((s) => s.openAt);
  const paletteCombo = usePreferences((s) =>
    getBinding(s.prefs.keybindings, "toggleCommandPalette"),
  );
  const settingsCombo = usePreferences((s) =>
    getBinding(s.prefs.keybindings, "openSettings"),
  );

  function openNewQuery() {
    if (!connectionId) return;
    openQueryTab(connectionId);
  }

  return (
    <div className="relative flex h-full flex-col items-center overflow-y-auto p-6">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 overflow-hidden"
      >
        {/* Two blooms rather than one: a wide wash from above for the surface,
            and a tighter one behind the lockup as its light source. The
            halftone is no longer here — it used to cover the whole workspace,
            under the picker card and the hint pill too; it now sits behind the
            lockup only, as the same halo the empty states use. */}
        <div className="absolute left-1/2 top-[-140px] h-[420px] w-[680px] -translate-x-1/2 rounded-full bg-brand/20 blur-[110px]" />
      </div>

      <div className="relative z-10 flex w-full max-w-3xl flex-1 flex-col items-center justify-center gap-7 py-10">
        <div className="flex flex-col items-center gap-3 text-center">
          {/* The full sticker lockup, not the mark plus a mono wordmark: an
              empty workspace is one of the few places the brief hands the
              brand its full voice, and the lockup already carries the name, so
              repeating it in type underneath was saying it twice. Served at
              512px for a ~240px box (2x DPI); the 1024px variant exists for
              docs, and the untouched master lives in `brand/`. */}
          <div className="relative">
            {/* The brand halftone as a halo — `halftone-spot`, shared with
                `EmptyState`, so every empty surface shows one texture. Square
                box (the utility draws a circle in it) centred on the lockup,
                coarser pitch for the larger size. */}
            <div
              aria-hidden
              className="halftone-spot pointer-events-none absolute left-1/2 top-1/2 -z-10 h-[22rem] w-[22rem] -translate-x-1/2 -translate-y-1/2 [--halftone-pitch:12px]"
            />
            <div className="absolute inset-0 -z-10 scale-125 rounded-[2rem] bg-brand/25 blur-2xl" />
            <img
              src="/image/huginn-lockup-512.png"
              alt="HuginnDB"
              width={512}
              height={288}
              className="h-auto w-60 select-none drop-shadow-[0_6px_24px_color-mix(in_srgb,var(--brand)_35%,transparent)]"
              draggable={false}
            />
          </div>
          {!showPicker && (
            <p className="max-w-xs text-sm text-muted-foreground">
              {t("tabs.emptyConnectFirst")}
            </p>
          )}
        </div>

        {showPicker ? (
          <>
            <div className="flex flex-wrap items-center justify-center gap-2.5 rounded-full border border-border/70 bg-card/60 py-1.5 pl-4 pr-1.5 text-sm text-muted-foreground">
              <span>
                {connectionId
                  ? t("tabs.emptyOpenSomething")
                  : t("tabs.emptyConnectFirst")}
              </span>
              {connectionId && (
                <Button
                  size="sm"
                  className="h-7 gap-1.5 rounded-full px-3"
                  onClick={openNewQuery}
                >
                  <Plus className="h-3.5 w-3.5" />
                  {t("tabs.newQuery")}
                </Button>
              )}
            </div>

            <div className="w-full rounded-2xl border border-border/70 bg-card/50 p-5 shadow-elevation-1">
              <WorkspacePicker />
            </div>
          </>
        ) : (
          <Button className="gap-1.5" onClick={() => openNewConnection()}>
            <Plus className="h-4 w-4" />
            {t("menu.file.newConnection")}
          </Button>
        )}
      </div>

      <div className="relative z-10 flex items-center gap-5 pb-1 text-xs text-muted-foreground">
        <Button
          type="button"
          flat
          variant="quiet"
          size="xs"
          onClick={() => togglePalette()}
        >
          <Kbd className="px-1.5 py-0.5 text-3xs font-medium leading-normal text-muted-foreground">
            {formatComboForDisplay(paletteCombo)}
          </Kbd>
          {t("commandPalette.title")}
        </Button>
        <Button
          type="button"
          flat
          variant="quiet"
          size="xs"
          onClick={() => openSettings()}
        >
          <Kbd className="px-1.5 py-0.5 text-3xs font-medium leading-normal text-muted-foreground">
            {formatComboForDisplay(settingsCombo)}
          </Kbd>
          {t("settings.title")}
        </Button>
      </div>
    </div>
  );
}
