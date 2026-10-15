---
id: 86
type: adr
status: accepted
date: 2026-09-17
tags: [grid, monaco, ux]
triggered_by_external_trap: true
related: []
supersedes: []
superseded_by: null
amends: []
---

# ADR #86: Formatting a cell *on open* must refuse any reformat that changed more than whitespace

The manual "Format" button and the new auto-format-on-open preferences call two different functions on purpose. `tryFormat` (`src/lib/grid/detectContentType.ts`) is the raw formatter and rewrites content freely; `autoFormatOnOpen` (`src/lib/grid/autoFormat.ts`) formats, verifies that only whitespace outside quoted literals and CDATA moved, and **discards its own output** when it did not. The difference exists because the formatted text becomes the editor's save baseline, so on the automatic path a lossy reformat is a silent write of a value the database never held.

**External trap behind it:** JSON.parse + JSON.stringify is a value round trip, not a whitespace transform: large integers lose precision, 1.0 becomes 1, duplicate keys vanish, integer-like keys are reordered and escapes are normalised.

**Decision:** `autoFormatOnOpen` formats, verifies only whitespace outside quoted literals and CDATA changed, and discards its output otherwise; the manual Format button stays ungated, SQL auto-format defaults off, JSON/XML default on.

**Alternatives rejected:**

- Gating the manual Format button too — deliberately not done, since the click is the user accepting a rewrite.
- A whitespace guard for SQL — rejected because sql-formatter upper-cases keywords so every input would fail; the SQL toggle ships off instead.
- Shipping JSON/XML flags off — rejected because it would remove existing preview formatting from every install.
- Formatting on restoreParked/moveToSidePanel — rejected because formatXml is not idempotent and would drift.
- Importing sql-formatter behind a dynamic import() — rejected because an await in loadFresh opens a window against a half-loaded buffer.
- Using `format()` with a language string — rejected because it pulls every dialect into the bundle; formatDialect with five imported dialects is used.
- Re-running the formatter when the language dropdown changes — rejected because it would dirty a clean buffer.

## Detail

**`JSON.parse` + `JSON.stringify` is a value round trip, not a whitespace transform.** This is the whole reason the module exists. `10000000000000000001` comes back `10000000000000000000` because an `f64` cannot hold it; `1.0` becomes `1` and `1e3` becomes `1000`; `{"a":1,"a":2}` loses a key; `{"b":1,"2":2}` becomes `{"2":2,"b":1}` because `JSON.stringify` hoists and sorts integer-like keys; `"A"` becomes `"A"`. All of that has always been true behind the Format button, where the click *is* the user accepting a rewrite, and nobody ever reported it. What changed is that on open the result is what `Ctrl+S` writes — "open the row with the Snowflake id, press save, silently store a different number". The guard is applied to the automatic path only; leaving the manual button ungated is deliberate, not an oversight.

**The guard's promise is total for JSON and partial for XML, and the asymmetry is stated rather than papered over.** `condense` walks both strings dropping whitespace, copying anything inside `"…"`, `'…'` or `<![CDATA[…]]>` verbatim (backslash escapes included, so `"A"` and `"A"` do not compare equal), and compares. Whitespace outside string literals is insignificant in JSON, so identical condensations *are* identical values. In XML they are not: whitespace between elements is itself text in mixed content, and `formatXml` reindents it. The guard proves no non-whitespace character was lost, moved or invented and that attribute values and CDATA survived — it does not promise mixed-content spacing. That rewrite predates this feature (the preview panel and the Format button have always done it to the same text); the guard exists to stop the new failure mode, not to retroactively fix the old one.

**SQL is exempt because it cannot pass, and that exemption is why it ships off.** `sql-formatter` upper-cases keywords by design, so every SQL reformat fails a whitespace-only test. Rather than a guard that rejects 100% of its inputs, the SQL toggle defaults off and its Settings description says outright that it rewrites the statement rather than only its spacing — an opt-in with the cost named.

**JSON and XML default *on*, against the repo's "a new flag starts off" convention, and off would not have been the neutral choice.** `CellPreview` has formatted unconditionally since it was written, and unifying the three surfaces onto one preference means that surface now reads it. Shipping the flags off would therefore have *removed* preview formatting from every existing install. Same shape as the comment justifying `json_schema_validation`/`completion`/`hover` defaulting on. Note the one behaviour that does change even at the defaults: a JSON value the guard rejects now shows raw in the preview where it used to show a pretty-printed version of a number the database does not hold.

**The formatted text is the baseline, which is what makes opening a cell not an edit.** `SideEditorPanel.loadFresh` assigns `baselineRef.current = seed` (the formatted text), not `next.value`. So `valueRef.current !== baselineRef.current` is false straight after a load: no unsaved-changes guard on close, no discard prompt when the user clicks the next cell. The trade — saving afterwards writes the formatted text — is exactly what the losslessness check makes acceptable.

**`restoreParked` and `moveToSidePanel` deliberately do not format, and `formatXml`'s non-idempotence is why that matters.** Both hand over a *live buffer* rather than a value freshly read from the grid. `formatXml` splits on `><`, which its own indented output no longer contains, and its closing-tag test `/^<\/.+>/` does not match a line with leading spaces — so a second pass indents differently from the first, and a session parked and restored a few times drifts further each round. `CellEditorTarget.preformatted` is the flag that says "this is a handover, seed from it as-is"; `autoFormat.test.ts` pins the non-idempotence with an explicit `not.toBe` so that rewriting `formatXml` on a real parser fails the test rather than silently invalidating the reasoning.

**`loadFresh` reads the stores imperatively, not through hooks.** `selectEditorPrefs(usePreferences.getState())` and `resolveConnectionDriver(useConnections.getState().profiles, …)`. It is a one-shot imperative load that itself calls `setTarget(next)`, so a subscription keyed on the target it is in the middle of installing is a render-order tangle for a value needed only at that instant. The same reasoning is why `loadFresh` stayed **synchronous**, which in turn is why `sql-formatter` is imported statically rather than behind a dynamic `import()`: an `await` there opens a window in which the user can type, park the session on a tab switch, or hit the capture-phase `Ctrl+S` handler, all against a half-loaded buffer whose `baselineRef` has not been assigned yet.

**Only five dialects are imported by name, via `formatDialect` rather than `format`.** `format(sql, { language: "postgresql" })` takes the dialect as a string, which makes the whole string→dialect map reachable from the entry point and pulls all twenty-odd dialects into the bundle. `formatDialect` takes the dialect object, so tree-shaking keeps only PostgreSQL, MySQL, SQLite, T-SQL and standard SQL — measured at ~109 KB raw / ~30 KB gzipped on top of a chunk that already carries Monaco. `src/lib/grid/formatSql.ts` is the only file that imports the package, so moving it behind a lazy path later is a one-file change. Its `SQL_DIALECT` is a total `Record<Driver, DialectOptions>`, so adding a driver is a compile error here rather than a silent fall-through to generic SQL.

**The language dropdown does not re-run the formatter.** It exists to correct a wrong detection, not to transform text — and re-formatting on change would dirty a clean side-panel buffer, since the baseline is fixed at load, so changing syntax highlighting would start raising the unsaved-changes guard on close. The Format button is the control immediately to its right.
