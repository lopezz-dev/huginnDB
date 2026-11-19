/**
 * The one way a context menu is drawn (ADR #143).
 *
 * A call site hands over a trigger and a function that describes the menu
 * (`MenuSpec`); this component decides everything about how it looks — order,
 * headings, separators, the destructive colour, the shortcut column — through
 * `arrangeMenu` and the primitives in `ui/context-menu.tsx`. It lives here and
 * not in `ui/` because it translates the section headings and reads the user's
 * key bindings, both of which `ui/` may not do (convention #60).
 *
 * `menu` is a function, and it is called only while the menu is open: Radix
 * mounts the content lazily, so the description reads the state at the moment
 * of the right-click. The grid relies on that twice over — a menu per cell
 * would otherwise build every description on every render, and the selection
 * a menu acts on is read through a ref precisely so it is not a prop of every
 * row (`GridRowCallbacks.selectedRows`).
 */

import { Fragment, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import {
  ContextMenu,
  ContextMenuAction,
  ContextMenuContent,
  ContextMenuHeader,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
  type ContextMenuWidth,
} from "@/components/ui/context-menu";
import { FIXED_KEYS, formatForDisplay, useShortcutLabel } from "@/lib/keybindings";
import {
  arrangeMenu,
  type MenuAction,
  type MenuSectionId,
  type MenuShortcut,
  type MenuSpec,
} from "@/lib/menu/menuSpec";

export function ContextActionMenu({
  menu,
  width,
  onOpenChange,
  children,
}: {
  /** Called each time the menu opens, never while it is closed. */
  menu: () => MenuSpec;
  /** The width tier (`ui/context-menu.tsx`): a minimum, not a fixed size. */
  width: ContextMenuWidth;
  /** E.g. to keep the targeted row looking targeted while the menu is open. */
  onOpenChange?: (open: boolean) => void;
  /** The element that opens the menu (Radix `asChild`): it must forward its
   *  ref and spread the props it is given. */
  children: ReactElement;
}) {
  return (
    <ContextMenu onOpenChange={onOpenChange}>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent width={width}>
        <MenuBody menu={menu} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** Rendered only while the menu is open; see the module note. */
function MenuBody({ menu }: { menu: () => MenuSpec }) {
  const { t } = useTranslation();
  const { header, sections } = arrangeMenu(menu());
  // Literal keys, one per section, so `keys.test.ts` can see them. `danger`
  // has none: `arrangeMenu` never labels it.
  const sectionLabel: Record<MenuSectionId, string | null> = {
    navigate: t("contextMenu.section.navigate"),
    copy: t("contextMenu.section.copy"),
    view: t("contextMenu.section.view"),
    sort: t("contextMenu.section.sort"),
    filter: t("contextMenu.section.filter"),
    create: t("contextMenu.section.create"),
    edit: t("contextMenu.section.edit"),
    transfer: t("contextMenu.section.transfer"),
    session: t("contextMenu.section.session"),
    danger: null,
  };
  return (
    <>
      <ContextMenuHeader title={header.title} tags={header.tags ? [...header.tags] : undefined} />
      <ContextMenuSeparator />
      {sections.map((section) => (
        <Fragment key={section.id}>
          {section.separatorBefore && <ContextMenuSeparator />}
          {section.showLabel && <ContextMenuLabel>{sectionLabel[section.id]}</ContextMenuLabel>}
          {section.entries.map((entry) => {
            if (entry.kind === "custom") {
              return <Fragment key={entry.id}>{entry.render()}</Fragment>;
            }
            if (entry.kind === "submenu") {
              const Icon = entry.icon;
              return (
                <ContextMenuSub key={entry.id}>
                  <ContextMenuSubTrigger>
                    <Icon className="mr-2 h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{entry.label}</span>
                  </ContextMenuSubTrigger>
                  <ContextMenuSubContent>
                    {entry.items.map((item) => (
                      <ContextMenuItem
                        key={item.id}
                        disabled={item.disabled}
                        onSelect={item.onSelect}
                      >
                        {item.label}
                      </ContextMenuItem>
                    ))}
                  </ContextMenuSubContent>
                </ContextMenuSub>
              );
            }
            return (
              <ActionItem key={entry.id} entry={entry} destructive={section.destructive} />
            );
          })}
        </Fragment>
      ))}
    </>
  );
}

/** One action, with its shortcut resolved against the user's bindings. */
function ActionItem({ entry, destructive }: { entry: MenuAction; destructive: boolean }) {
  const shortcut = useShortcutText(entry.shortcut);
  return (
    <ContextMenuAction
      icon={entry.icon}
      label={entry.label}
      onSelect={entry.onSelect}
      disabled={entry.disabled}
      locked={entry.locked}
      detail={entry.detail}
      destructive={destructive}
      shortcut={shortcut}
    />
  );
}

/** The display form of an item's key, or nothing: an unbound catalogue
 *  action shows no chip rather than an empty one. */
function useShortcutText(shortcut: MenuShortcut | undefined): string | undefined {
  const bound = useShortcutLabel(shortcut && "action" in shortcut ? shortcut.action : undefined);
  if (!shortcut) return undefined;
  return "fixed" in shortcut ? formatForDisplay(FIXED_KEYS[shortcut.fixed]) : bound;
}
