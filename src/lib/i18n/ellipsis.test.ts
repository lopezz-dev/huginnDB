/**
 * No action label ends in "…" (convention #144).
 *
 * The ellipsis used to mean "this opens a dialog", and it was applied by hand,
 * so it drifted: some menu items that opened a dialog had one, others did not,
 * and the same action could carry it in one menu and not in the next. HuginnDB
 * dropped it from every action — menu items, buttons, dialog titles — and kept
 * it for the three things it still means everywhere: an input's placeholder,
 * work in progress, and text that was cut.
 *
 * There is deliberately **no list of exceptions**. Whether a string may end in
 * "…" is decided by its key, so a new string is classified the moment it is
 * named, and renaming a key is the only way to change its class:
 *
 * - a **placeholder** key's last segment ends in `placeholder`
 *   (`filterPlaceholder`, `searchCatalogPlaceholder`);
 * - an **in-progress** key's last segment has a word ending in `-ing`, or the
 *   word `pending` / `progress` (`saving`, `checkingReferences`,
 *   `exactCountRunning`, `chordPending`, `progress`);
 * - **elided** text is not caught at all, because its ellipsis is not
 *   action-shaped: it opens the string (`… and 3 more rows`), sits inside
 *   brackets (`ObjectId(…)`, `[…]`) or closes a list (`Cursor, …)`).
 *
 * "Action-shaped" is an ellipsis right after a word that ends the value, comes
 * before a closing quote (a label quoted in prose), or before ` (` (a label
 * followed by its hint, as in `Filter rows… (Enter)`). Three ASCII dots count
 * the same as "…", so the rule cannot be dodged by typing them.
 */

import { describe, expect, it } from "vitest";
import en from "./locales/en.json";
import es from "./locales/es.json";
import { localeEntries } from "./localeEntries";


const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

/** An ellipsis after a word or `)`, at the end, before a closing quote, or before ` (`. */
const ACTION_SHAPED = /[\p{L}\p{N})](?:…|\.\.\.)(?=$|["”»'’]|\s+\()/u;

/** The key's own name, split into lower-case camelCase words. */
function lastWords(key: string): string[] {
  const last = key.split(".").pop()!.replace(PLURAL_SUFFIX, "");
  return last.split(/(?=[A-Z])/).map((w) => w.toLowerCase());
}

function mayEndInEllipsis(key: string): boolean {
  const words = lastWords(key);
  if (words[words.length - 1] === "placeholder") return true;
  return words.some((w) => w.endsWith("ing") || w === "pending" || w === "progress");
}

function offenders(locale: unknown): string[] {
  return localeEntries(locale)
    .filter(([key, value]) => ACTION_SHAPED.test(value) && !mayEndInEllipsis(key))
    .map(([key, value]) => `${key}  ${JSON.stringify(value)}`);
}

describe("ellipsis on labels (convention #144)", () => {
  it("the key rule tells the three allowed cases from an action", () => {
    expect(mayEndInEllipsis("schema.filterPlaceholder")).toBe(true);
    expect(mayEndInEllipsis("ai.placeholder")).toBe(true);
    expect(mayEndInEllipsis("connectionDialog.saving")).toBe(true);
    expect(mayEndInEllipsis("schema.drop.checkingReferences")).toBe(true);
    expect(mayEndInEllipsis("tableData.exactCountRunning")).toBe(true);
    expect(mayEndInEllipsis("statusBar.chordPending")).toBe(true);
    expect(mayEndInEllipsis("transfer.import.progress")).toBe(true);
    expect(mayEndInEllipsis("schema.context.editStructure")).toBe(false);
    expect(mayEndInEllipsis("menu.file.newConnection")).toBe(false);
    expect(mayEndInEllipsis("policyEditor.save")).toBe(false);
  });

  it("the shape test ignores elision and catches a label", () => {
    expect(ACTION_SHAPED.test("Edit structure…")).toBe(true);
    expect(ACTION_SHAPED.test("Filter rows… (Enter)")).toBe(true);
    expect(ACTION_SHAPED.test('use "Add from file…" in Preferences')).toBe(true);
    expect(ACTION_SHAPED.test("Rename...")).toBe(true);
    expect(ACTION_SHAPED.test("… and {{count}} more rows")).toBe(false);
    expect(ACTION_SHAPED.test("ObjectId(…), ISODate(…)")).toBe(false);
    expect(ACTION_SHAPED.test("they end in […]")).toBe(false);
    expect(ACTION_SHAPED.test("(Claude Code, Cursor, …)")).toBe(false);
    expect(ACTION_SHAPED.test("TRY…CATCH")).toBe(false);
  });

  it("no English action label ends in an ellipsis", () => {
    expect(offenders(en)).toEqual([]);
  });

  it("no Spanish action label ends in an ellipsis", () => {
    expect(offenders(es)).toEqual([]);
  });
});
