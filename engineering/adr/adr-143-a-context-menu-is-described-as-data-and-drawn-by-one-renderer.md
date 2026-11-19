---
id: 143
type: adr
status: accepted
date: 2026-11-19
tags: [ui, ux, react]
triggered_by_external_trap: false
related: [53, 60, 96, 136]
supersedes: []
superseded_by: null
amends: []
---

# ADR #143: A context menu is described as data and drawn by one renderer, which owns its order, headings, colour and width

A context menu no longer writes its own JSX. Its call site describes the menu as data — a header naming its subject, and actions each tagged with a section from one closed vocabulary — and `ContextActionMenu` draws it: `arrangeMenu` puts the sections in a fixed order, decides whether they get headings, and makes everything in the `danger` section red. An inventory of the app's eleven context menus (18-11-2026) found nine ways they differed; each of those was a decision every call site made again, and the renderer is where it is now made once.

**Decision:** describe every context menu as a `MenuSpec` (`lib/menu/menuSpec.ts`) and draw it with `components/menus/ContextActionMenu.tsx`; the section vocabulary is ordered and closed, belonging to `danger` is what makes an action destructive, shortcuts come only from the action catalogue or a closed list of fixed keys, and a menu states a minimum width tier rather than a size.

**Alternatives rejected:**

- **Keep composing JSX, with a `<MenuSection id>` wrapper.** It would share the look of a section but leave the order to whoever writes the menu, and the order was the most visible inconsistency (Refresh first in one menu, sixth in the next; a connection's last two actions swapping with its state).
- **Put the renderer in `components/ui/`, taking translated headings and resolved shortcuts as props.** `ui/` may import neither i18n nor a store (convention #60), so every call site would translate the nine headings and read the key bindings itself — the duplication this decision exists to remove.
- **A `destructive` flag on the action, separate from its section.** It is how menus were written before, and it is how the app ended up with a red "Drop table" beside a plain "Empty table", and a hand-coloured delete without the hover tint. With the colour derived from the section, a red action outside `danger` and a plain one inside it cannot be written.
- **Three fixed widths.** A fixed width is what wrapped "Open environment in a new window" onto two lines in the environment rail. The tier is a minimum; a menu grows to fit its words on one line, up to a cap.

## Context

Alex asked for the context menus to be unified on 18-11-2026, taking the grid's cell menu as the reference: it was the only one with a header naming its subject and headed sections. An inventory of every menu, captured from the real components in both themes, measured the rest: two menus built from bare `ContextMenuItem`s with icons added by hand, three width rules, headings in three menus and none in eight, no menu showing a single keyboard shortcut, and a policy reason that stretched a menu to 363 px for a nine-letter label.

## Consequences

- **The vocabulary, in order:** `navigate`, `copy`, `view`, `sort`, `filter`, `create`, `edit`, `transfer`, `session`, `danger` — what touches nothing first, what destroys last. Refresh is `view`. `danger` never has a heading; a separator sets it off. Headings appear only when a menu has more than one non-danger section. Adding a section means adding it to `MENU_SECTIONS`, a heading under `contextMenu.section` in both locales and to the map in `ContextActionMenu`; reordering means changing that array, for every menu at once.
- **Every menu has a header.** `MenuSpec.header` is required.
- **The description is evaluated only while the menu is open.** Radix mounts the content lazily; `ContextActionMenu` calls `menu()` inside it. The grid depends on this: a menu per cell must not build a description per render, and the multi-row selection is read through a ref at the moment of the right-click (`GridRowCallbacks.selectedRows`). A description must not call hooks; an entry that needs one is a `custom` entry, which renders a component.
- **Shortcuts are `{ action: ActionId }` or `{ fixed: FixedKey }`, never a string.** A catalogue action shows the user's current binding and nothing when unbound (`useShortcutLabel` now accepts `undefined` so a list can call it unconditionally). `lib/keybindings/fixedKeys.ts` lists the keys answered outside the catalogue with the place that answers each; when one of those handlers moves, that list must follow, or a menu advertises a key that does nothing.
- **Width:** `ContextMenuContent` takes `width: "sm" | "md" | "lg"` (`min-w` 10 / 14 / 18 rem) under a `max-w` of 28 rem. A policy reason under a locked action (`ContextMenuAction`'s `locked`) is `contain: inline-size`, so it wraps inside the width the labels set instead of setting it.
- **The cell menu moved first** (`components/grid/cellMenu.ts`). Two visible changes: Copy shows Ctrl+C, and Insert row / Duplicate row form a **Create** section above **Edit** rather than sharing it with Set NULL.
- **Still to move, each in its own PR:** the explorer's menus (connection, database, schema, table), the grid's blank-space menu, the document field menu, the tab and the environment menus. A contract in `uiContracts.test.ts` will then refuse a `ContextMenuContent` outside `ui/` and this renderer. The same plan retires the ellipsis from labels app-wide, brings the menu bar's dropdowns to the context menu's density (superseding the "denser by design" split recorded in `ui/styles.ts`), and replaces Monaco's native context menu with this one.
