/**
 * What a context menu says, as data — and the one function that decides how
 * it is laid out (ADR #143).
 *
 * A menu used to be JSX written at its call site, so every menu decided its
 * own order, its own grouping and its own idea of "dangerous": the inventory
 * of 18-11-2026 found eleven menus and nine ways they differed. Here a call
 * site only *describes* its actions, each tagged with a section from one
 * closed vocabulary, and `arrangeMenu` decides the rest. The renderer that
 * draws the result is `components/menus/ContextActionMenu.tsx`.
 *
 * Pure: no React state, no i18n, no store. Labels arrive translated; the
 * section headings are translated by the renderer from the section id.
 */

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import type { ActionId, FixedKey } from "@/lib/keybindings";

/**
 * Every section a menu can have, **in the order they appear**: what touches
 * nothing first, what destroys last. The order is the point — a call site
 * cannot reorder sections, only choose which one an action belongs to.
 *
 * - `navigate` — go somewhere else (follow a reference, open in a tab).
 * - `copy` — put something on the clipboard.
 * - `view` — look at it differently without changing it (side editor, as a
 *   date, refresh).
 * - `sort`, `filter` — narrow or reorder what is shown.
 * - `create` — add something new (a row, a table, a query).
 * - `edit` — change what exists (set NULL, rename, edit structure).
 * - `transfer` — move data in or out (export, import).
 * - `session` — where it lives and how it is held (connect, new window, pin).
 * - `danger` — cannot be undone. **Being here is what makes an action red**:
 *   there is no separate flag, so a red action outside it, or a dangerous one
 *   left plain inside it, cannot be written.
 */
export const MENU_SECTIONS = [
  "navigate",
  "copy",
  "view",
  "sort",
  "filter",
  "create",
  "edit",
  "transfer",
  "session",
  "danger",
] as const;

export type MenuSectionId = (typeof MENU_SECTIONS)[number];

/**
 * The key an item advertises. Either an action from the catalogue, shown with
 * the user's current binding (and nothing when it is unbound), or one of the
 * fixed keys the app answers outside it. Never a free string: a menu that
 * prints a key nobody handles is worse than one that prints none.
 */
export type MenuShortcut = { action: ActionId } | { fixed: FixedKey };

interface EntryBase {
  /** Stable within the menu; the React key. */
  id: string;
  section: MenuSectionId;
}

/** An icon, a label and what happens on select — almost every entry. */
export interface MenuAction extends EntryBase {
  kind?: "action";
  icon: LucideIcon;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  /** Why the managed policy forbids it (`usePolicyLocker`); shown under the
   *  label and disables the item. */
  locked?: string | null;
  /** A short trailing value in the label's register (a date preview). */
  detail?: string;
  shortcut?: MenuShortcut;
}

/** One row of a submenu: the formats of "Copy row as ▸", say. */
export interface MenuSubItem {
  id: string;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
}

/** An entry that opens a submenu. One with no items is dropped. */
export interface MenuSubmenu extends EntryBase {
  kind: "submenu";
  icon: LucideIcon;
  label: string;
  items: readonly MenuSubItem[];
}

/**
 * Anything that is not an action — the tab menu's colour swatches. Drawn in
 * its section like any other entry, so it still obeys the order; what it draws
 * is its own business.
 */
export interface MenuCustom extends EntryBase {
  kind: "custom";
  render: () => ReactNode;
}

export type MenuEntry = MenuAction | MenuSubmenu | MenuCustom;

/** The menu's subject: a column, a table, "3 rows selected". Always present —
 *  every menu says what it is about. */
export interface MenuHeader {
  title: string;
  /** Small chips beside the title (a type, `NULL`); falsy ones are skipped. */
  tags?: readonly (string | null | undefined | false)[];
}

export interface MenuSpec {
  header: MenuHeader;
  /** In any order across sections, in display order within one. Falsy
   *  entries are skipped, so a call site can write `cond && { … }`. */
  entries: readonly (MenuEntry | null | undefined | false)[];
}

export interface ArrangedSection {
  id: MenuSectionId;
  entries: MenuEntry[];
  /** Draw the section's heading. */
  showLabel: boolean;
  /** Draw a separator above it. Never together with `showLabel`: a heading
   *  already divides. */
  separatorBefore: boolean;
  /** Draw every action in it in the destructive colour. */
  destructive: boolean;
}

export interface ArrangedMenu {
  header: MenuHeader;
  sections: ArrangedSection[];
}

/**
 * Lay a menu out: group by section, put the sections in `MENU_SECTIONS`
 * order, drop what is empty.
 *
 * Headings appear only when there is more than one section to tell apart —
 * a two-item menu with a heading over each item says less, not more — and
 * `danger` never has one: it is set off by a separator, and its colour says
 * the rest.
 */
export function arrangeMenu(spec: MenuSpec): ArrangedMenu {
  const bySection = new Map<MenuSectionId, MenuEntry[]>();
  for (const entry of spec.entries) {
    if (!entry) continue;
    if (entry.kind === "submenu" && entry.items.length === 0) continue;
    const list = bySection.get(entry.section);
    if (list) list.push(entry);
    else bySection.set(entry.section, [entry]);
  }
  const present = MENU_SECTIONS.filter((id) => bySection.has(id));
  const labelled = present.filter((id) => id !== "danger").length > 1;
  return {
    header: spec.header,
    sections: present.map((id, i) => {
      const showLabel = labelled && id !== "danger";
      return {
        id,
        entries: bySection.get(id)!,
        showLabel,
        separatorBefore: i > 0 && !showLabel,
        destructive: id === "danger",
      };
    }),
  };
}
