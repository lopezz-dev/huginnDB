---
id: 81
type: adr
status: accepted
date: 2026-09-10
tags: [mongodb, grid, ui]
triggered_by_external_trap: false
related: [29, 82]
supersedes: []
superseded_by: null
amends: []
---

# ADR #81: MongoDB's filterable fields are a sample of the page, not a catalog — and a query path must not carry an array index

The advanced filter could only name a top-level field, because its field list is `infer_columns`' output and that list is also the data grid's column list. The nested paths now offered come from the page on screen (`QueryResult.rows` + `row_types`), which makes them a *sample* — so the control that shows them has to accept a hand-typed path — and they deliberately drop the array index the list view's paths carry. Since 1.28.0 the advanced-filter dialog is gone and these conditions are edited in the inline query panel; see the addendum for what that changed.

**Decision:** The filter's nested field suggestions are walked from the page's rows and BSON type trees (lib/grid/fieldPaths.ts) without array indexes, offered in a combobox that accepts hand-typed paths, with text matching mapped per array element and the suggestion panel positioned fixed with measured offsets.

**Alternatives rejected:**

- Widening infer_columns to report nested fields: rejected because its output is also the grid's column list and the structure view's rows.
- A closed Select of known fields: rejected because the page is only a sample.
- Keeping the array index in filter paths: rejected because it would narrow every array filter to the first element.
- Absolute, in-flow, or body-portalled suggestion panels: rejected (clipped by the scroller, resizes the dialog, unclickable under a modal Radix Dialog).
- fixed positioning with auto top/left: rejected because the static position ignores the list's scroll.
- Giving the bulk-update $set half the picker: rejected because writing a path creates it where missing.
- Guessing types from display JSON: rejected because it would relabel Int64 as int.

## Detail

**The gap was visible from inside the product.** The list view renders, types and edits every nested field of a document; the advanced filter two panels away could not name one. `customData.format` was a thing you could see, edit and copy, but not filter on.

- **The catalog could not be widened, because it is not only a catalog.** `db::mongo::schema::infer_columns` samples 100 documents and reports their top-level fields. That same `Vec<ColumnInfo>` is the grid's column list and the structure view's row list, so teaching it about nesting would change what a *column* means in two other surfaces to fix a third. The filter's field list had to come from somewhere else.
- **It comes from the page, and that is a sample.** `lib/grid/fieldPaths.ts` walks the rows already on screen with the BSON type trees the backend shipped alongside them — the same material `flattenDocument` renders — so there is no extra round trip and every path offered is one the user can see. The cost is that a field only *older* documents carry is not in the list. That single fact is why the field control is a combobox rather than a `Select`: the suggestions are help, the dotted path is the interface, and Mongo resolves an unknown path server-side as "matches nothing" rather than as an error. A closed list here would have been a lie about what is filterable.
- **Types are merged the way the backend merges a column's**: first non-null wins, a disagreement is `"mixed"`, all-null stays `"null"`. Not decoration — the type drives `coerceFilterValue`, and a `string` "183" never matches a stored `int32` 183 (ADR #29's family). Guessing from the display JSON would relabel an `Int64` as an int on every edit.
- **The same type trees answer two different questions, and the answers differ.** A list-view path carries the array index (`tags.2`) because it is a `$set`/`$unset` target and has to name one element. A filter path must **not** (`items.sku`, never `items.0.sku`) because BSON query paths traverse arrays implicitly, and "any element whose `sku` is X" is what someone filtering documents means. Two walks over one structure; conflating them would silently narrow every filter through an array to its first element.
- **Offering those paths reopened a closed blind spot one level down.** `text_match_branches` exists because a bare `$regex` silently answers zero rows on a non-string field, so it pairs the indexed regex with an `$expr` that stringifies the field first. A field path *through an array* resolves to an array of values, and `$convert` folds that to `""` via `onError` — so `contains` on `items.qty` was exactly the silent-zero-rows failure the function was written to prevent. Branch 2 now maps over the field (`$isArray` → `$map` → `$anyElementTrue`) and asks per element. Checked against a live server, because `$convert`'s behaviour on an array and on a missing path is not something the docs state.
- **The suggestion panel took three attempts, and each failure is a property of where it lives.** *Absolute* inside the row is clipped: the dialog's condition list is `overflow-y-auto`, and a scroll container clips its positioned descendants, so the panel was cut at that box's edge and read as rendering *behind* the "Add condition" button. *In the flow* (a disclosure, like the `in`/`not_in` editor) is never clipped but resizes the dialog every time it opens. *Portalled to `document.body`* escapes the clip and is then unclickable, because the surrounding Radix `Dialog` is modal and puts `pointer-events: none` on everything outside its own content. What works is `position: fixed` inside the row: clipping follows the containing-block chain, and a fixed box's containing block is its nearest *transformed* ancestor — `DialogContent`, centred with a `translate`, which sits above the scroller and clips nothing.
- **`fixed` with `top`/`left` left `auto` is a trap that survives a first look.** Those offsets resolve to the box's *static position*, which put the panel exactly under its input — until the condition list was scrolled, at which point it opened as many pixels too low as the list had scrolled, because the static position is computed in the unscrolled flow and then read as an offset from the containing block. The offsets are measured instead (`fixedOrigin` finds the containing block the way CSS defines it, padding box included), and so is the width, since `width: 100%` on a fixed box resolves against the dialog rather than the input. Being out of the flow it follows neither the list nor the window, so a scroll or a resize closes it. All of this was found by rendering the real dialog in the browser — the layout is not something jsdom can answer.
- **Escape and Enter belong to the dialog, and the picker has to give them back.** The panel lives inside a modal that closes on Escape. A suggestion list that let the key bubble would throw away every condition the user had built, so both keys are stopped *while the panel is open* and released the moment it closes — the behaviour with its own regression test, since it is invisible until it costs someone their work.
- **The `$set` half of the bulk-update dialog deliberately does not get this.** Its match half does (it is the same `FilterConditionRow`, and letting the two dialogs disagree about what is filterable is how they drifted before). Writing `a.b` on every matching document *creates* that path where it is missing, which is a bigger promise than a picker making the path easy to reach should make on its own.

## Addendum (2026-10-15): the filter left the dialog, and the dialog lost its transform

The decision stands: suggested paths come from the page, carry no array index, and are offered in a combobox that accepts typed paths. Two later changes moved the ground under the Detail above, which describes the advanced-filter dialog as it was on 2026-09-10.

- **The advanced-filter dialog no longer exists** (`0811423`, 2026-09-23, released in 1.28.0). `AdvancedFilterDialog` was deleted, not kept beside its replacement, because only one surface may edit the active server filters. The same `FilterConditionRow`, `filterConditions.ts` helpers and `FilterFieldPicker` now render in two places:
  - **`QueryPanel`** (`src/components/grid/QueryPanel.tsx`), the inline section between the grid toolbar and the rows. It is not modal. Its condition list is still an `overflow-auto` scroller, so the clipping argument for `position: fixed` holds unchanged. The *portalled to `document.body`* failure mode does not arise here, because there is no modal `Dialog` disabling pointer events outside it.
  - **The match half of `BulkUpdateDialog`**, still a modal `panel`-tier dialog with an `overflow-y-auto` condition list. Every failure mode listed above still applies there as written, including Escape and Enter belonging to the dialog.
- **The panel's containing block is now the viewport, not `DialogContent`** (`c628dcf`, 2026-09-11). Dialogs are centred by their flex container instead of a `translate`, so that `tailwindcss-animate`'s `enter` keyframe can own `transform`. The bullet above that says the fixed panel's containing block is "`DialogContent`, centred with a `translate`" is therefore out of date. The conclusion is not: the viewport also sits above the scroller and clips nothing, and the panel is still a DOM descendant of whatever contains it, so pointer events, click-outside and focus management keep working. `fixedOrigin` already handles both cases, because it walks the ancestors the way CSS does and falls back to the viewport origin. `FilterFieldPicker`'s own header comment is the current description.
- **Unchanged:** the `$set` half of `BulkUpdateDialog` still uses a closed `Select` of known fields, for the reason given above. `text_match_branches` (`db/mongo/query.rs`) still maps over array-valued paths.

