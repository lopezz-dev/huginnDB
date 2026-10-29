# `components/ui/` — the primitive layer

Presentational primitives. Everything here is reusable across every domain in
the app, carries no copy of its own, and can be rendered in a test without a
store, a mock, or an IPC boundary.

## The dependency rule

This is the frontier that keeps the layer reusable, and it is the one rule here
a test enforces (`uiContracts.test.ts`) rather than trusting to discipline.

| Layer           | May import                                                                                           | Must not import                                         |
| --------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `ui/`           | `react`, `@radix-ui/*`, `lucide-react`, `class-variance-authority`, `@/lib/utils` (`cn`), `./styles` | `@/stores/*`, `@/lib/tauri`, `react-i18next`, `@/types` |
| `common/`       | all of the above, plus `react-i18next`, `@/types`, pure `@/lib/*`                                    | `@/lib/tauri`, `@/stores/*`                             |
| a domain folder | anything                                                                                             | —                                                       |

It gives an objective answer to the question that used to be settled by feel:

- **A primitive that needs its own words belongs in `common/`, not here.**
  `ConfirmDialog` (`t("common.cancel")`) and `PasswordInput` (the show/hide
  toggle's `aria-label`) both live there for exactly this reason. A shared
  component that takes its labels as props stays here.
- **A component that does IO belongs in its domain.** `FkCombobox` sat here for
  a long time while importing `@/lib/tauri` and a grid store — 375 lines, a
  quarter of the directory, that no other domain could ever use. It is
  `grid/FkCombobox.tsx` now.
- **No primitive reads a store.** This also neuters gotcha #1 (unstable Zustand
  selectors) by construction: a selector bug inside a primitive would arrive in
  a hundred call sites at once. There is exactly one real temptation — making
  the tooltip delay a preference — and the answer is to pass `delayDuration` to
  the `TooltipProvider` at each of the three window roots, which are components
  that already reach stores. See the note in `tooltip.tsx`.

## Conventions

- `React.forwardRef` for anything wrapping a DOM element, with
  `React.ElementRef<typeof X>` / `ComponentPropsWithoutRef<typeof X>` and the
  `displayName` inherited from the Radix primitive.
- `...props` always spread. A primitive with a closed prop list cannot be a
  tooltip target or an `asChild` slot.
- **`className` is always the last argument to `cn`**, so `tailwind-merge` lets
  the consumer win. `uiContracts.test.ts` asserts the behaviour rather than the
  spelling.
- **The size prop is `size`.** Where the native HTML attribute collides (`input`,
  `select`), `Omit` it from the props type — do not rename the prop.
- **Density vocabulary is `xs` / `sm` / `md`**: `h-7 text-xs` / `h-8 text-xs` /
  `h-9 text-sm`. `size="icon"` is a _shape_, not a density.
- **`brand` is the action colour, `primary` is not.** `--primary` is near-black
  in light themes and near-white in dark ones; `--brand` is the app's one
  saturated colour. Checkboxes, links and active states take `brand`.
- Repeated class fragments live in `styles.ts`, which takes only fragments with
  two or more consumers _in this directory_. New shared chrome is created on
  first adoption, never speculatively.

## What's here

| File                  | Exports                                | Notes                                                                                                       |
| --------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `button.tsx`          | `Button`, `buttonVariants`             | `cva`; the base every other control borrows from. `icon` takes the component, `loading` owns the busy state, `flat` drops the hairline edge |
| `icon-button.tsx`     | `IconButton`                           | square, dense, `label` required and `title` omitted from the type; `revealOnHover` implies `flat`            |
| `input.tsx`           | `Input`, `inputVariants`               | `cva`; the density canon                                                                                    |
| `textarea.tsx`        | `Textarea`                             | shares the field focus language                                                                             |
| `checkbox.tsx`        | `Checkbox`                             | the native input, with `indeterminate` via ref; no wrapper unless given a `label`                           |
| `native-select.tsx`   | `NativeSelect`, `nativeSelectVariants` | the OS dropdown, themed; holds the WebView2 popup fix                                                       |
| `select.tsx`          | `Select*`                              | Radix; `focus`, not `focus-visible` — its trigger is a `<button>`                                           |
| `search-field.tsx`    | `SearchField`                          | magnifier + input + optional clear, geometry paired by `size`                                               |
| `label.tsx`           | `Label`                                | Radix passthrough                                                                                           |
| `switch.tsx`          | `Switch`                               | Radix passthrough                                                                                           |
| `segmented.tsx`       | `Segmented`                            | generic over the value union; single-choice toggle strip                                                    |
| `fold-row.tsx`        | `FoldRow`                              | a picker's collapsible group header: chevron, label, `(count)`; `open` drives `aria-expanded`. The button only — its select-all checkbox stays at the call site |
| `tabs.tsx`            | `Tabs*`                                | Radix                                                                                                       |
| `badge.tsx`           | `Badge`, `badgeVariants`               | `tone` names the meaning, not a colour                                                                      |
| `spinner.tsx`         | `Spinner`                              | `aria-hidden` unless given a `label`                                                                        |
| `kbd.tsx`             | `Kbd`                                  |                                                                                                             |
| `separator.tsx`       | `Separator`                            | the hairline between groups on one line: `default` (`h-4`) between controls, `sm` (`h-3`) between text runs; no margin — the row's `gap` spaces it |
| `dialog.tsx`          | `Dialog*`                              | Radix; `DialogContent` supplies the overlay and the close button                                            |
| `dialog-actions.tsx`  | `DialogActions`                        | the Cancel/confirm footer pair; separate file so Dialog's consumers don't pull in `Button`                  |
| `dropdown.tsx`        | `DropdownMenu*`                        | Radix; `text-sm`, `min-w-[8rem]`                                                                            |
| `context-menu.tsx`    | `ContextMenu*`, `ContextMenuAction`    | Radix; denser than the dropdown by design                                                                   |
| `tooltip.tsx`         | `Tooltip*`, `SimpleTooltip`            | read its docstring before replacing a native `title=`                                                       |
| `nav-rail.tsx`        | `NavRailItem`                          | a workbench rail entry: icon, label, description, 2px edge when active                                      |
| `styles.ts`           | class fragments                        | strings and lookups only, no `cva`, no JSX                                                                  |
| `uiContracts.test.ts` | —                                      | the drift guards, with the rejected rules listed and reasoned                                               |
| `uiAdoption.test.ts`  | —                                      | the migration ratchet: per-file budgets for the two patterns that cannot be contracts yet                   |

## Where behaviour is decided

This directory answers "what does a control look like". It deliberately does not
answer "what does the app _say_ when something is happening" — that spans
primitives, stores and domain components at once, so it lives in `CONTRIBUTING.md`
under **Feedback and transition state**: how an async transition is modelled,
when a control reads as destructive, who owns the busy state, and which writes
get confirmed. Read it before adding a `loading`, a `tone="destructive"`, or a
new spinner; each of those rules exists because the decision had already been
made somewhere else in the app and was re-made differently.

## Contracts vs. budgets

Two test files guard this layer and they answer different questions.

`uiContracts.test.ts` holds **contracts**: a violation is a bug, every allowlist
is empty, and that emptiness is its stated admission rule — a rule needing
exceptions is a matter of taste and does not belong there.

`uiAdoption.test.ts` holds **budgets**: a per-file count of a pattern a
primitive already replaces, seeded with today's real number and asserted
exactly, so debt cannot grow and a cleanup has to come and lower the number.
Today it counts 140 raw `<button>` elements and 81 native `title=` attributes
outside this directory. The failure output is the delta, so it names the file
and the transition (`"…/StatusBar.tsx": "5 -> 6"`) rather than diffing two
seventy-key objects.

The two are not in tension: a budget exists precisely for a rule that _cannot_
be a contract yet. When a budget empties, the rule graduates into
`uiContracts.test.ts` with an empty allowlist and leaves the ratchet; when both
have graduated, `uiAdoption.test.ts` is deleted.

`ui/` has no barrel `index.ts`, deliberately. Call sites import by path
(`@/components/ui/button`), which is what lets a file move inside this directory
without touching its own imports — the invariant convention #28 asks to keep. A
barrel would also add a second import path to diverge, for no gain across the
200-plus `Button` call sites.
