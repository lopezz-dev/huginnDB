/**
 * An environment's context menu in the rail, as a description (`MenuSpec`,
 * ADR #143).
 *
 * Split out of `EnvironmentRail`, where it was three hand-built
 * `ContextMenuItem`s in a fixed `w-48` — which wrapped "Open environment in
 * new window" onto two lines — with a delete coloured by hand and missing the
 * destructive hover tint. Runs only while the menu is open.
 */

import type { TFunction } from "i18next";
import { AppWindow, Pencil, Trash2 } from "lucide-react";

import type { MenuSpec } from "@/lib/menu/menuSpec";

export interface EnvironmentMenuContext {
  t: TFunction;
  /** The environment's name as the rail shows it (`environmentLabel`). */
  label: string;
  /** False for the last environment and for a mirrored one (#108); see
   *  `SortableEnvironmentButton`. */
  canDelete: boolean;
  onRename: () => void;
  onOpenInNewWindow: () => void;
  onDelete: () => void;
}

export function environmentMenu(ctx: EnvironmentMenuContext): MenuSpec {
  const { t } = ctx;
  return {
    header: { title: ctx.label },
    entries: [
      {
        id: "rename",
        section: "edit",
        icon: Pencil,
        label: t("environments.rename"),
        onSelect: ctx.onRename,
      },
      {
        id: "openInNewWindow",
        section: "session",
        icon: AppWindow,
        label: t("environments.openInNewWindow"),
        onSelect: ctx.onOpenInNewWindow,
      },
      ctx.canDelete && {
        id: "delete",
        section: "danger",
        icon: Trash2,
        label: t("environments.delete"),
        onSelect: ctx.onDelete,
      },
    ],
  };
}
