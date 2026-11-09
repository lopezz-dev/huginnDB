/**
 * Top-bar "Window" dropdown — window/layout-level actions that don't fit
 * under File (connections) or View (panel visibility): opening a new OS
 * window, and resetting the outer shell layout back to its default.
 */

import { AppWindow, ChevronDown, LayoutGrid } from "lucide-react";
import { useTranslation } from "react-i18next";
import { notify } from "@/lib/notify";
import { useSessionPanelLayout } from "@/stores/session/panelLayout";
import { api } from "@/lib/tauri";
import { ShortcutHint } from "@/components/menus/ShortcutHint";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown";

export function WindowMenu() {
  const { t } = useTranslation();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button flat variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-xs">
          <AppWindow className="h-3.5 w-3.5" />
          {t("menu.window.label")}
          <ChevronDown className="h-3 w-3 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      {/* A minimum, not a fixed width, and no wrapping: the panel grows to
          its longest label plus its shortcut, so "Restablecer disposición de
          ventanas" stays on one line in any typeface or language. */}
      <DropdownMenuContent align="start" className="min-w-56 whitespace-nowrap">
        <DropdownMenuItem
          onSelect={() => {
            // Same treatment as the other two entry points to this command
            // (`App.tsx`'s action map and the command palette): a window that
            // does not appear is not something a console line explains.
            void api
              .openNewWindow()
              .catch((err) =>
                notify.error(t("menu.window.newWindowFailed"), {
                  description: String(err),
                }),
              );
          }}
        >
          <AppWindow className="mr-2 h-3.5 w-3.5" />
          {t("menu.window.newWindow")}
          <ShortcutHint action="newWindow" />
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => useSessionPanelLayout.getState().resetLayout()}
        >
          <LayoutGrid className="mr-2 h-3.5 w-3.5" />
          {t("menu.window.resetLayout")}
          <ShortcutHint action="resetLayout" />
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
