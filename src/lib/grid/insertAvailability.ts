/**
 * Whether a table tab can begin an insert, and if not, why (#267).
 *
 * The Insert button used to be withheld whenever this was false, so it simply
 * vanished: on a table without a primary key, a projection hiding the key, or
 * a policy lock, the user saw nothing and could not tell which. It is now
 * shown disabled with the reason instead — the same "locked, not hidden" rule
 * ADR #96 set for policy locks. Like those locks it is advisory: the backend
 * still refuses whatever it refuses.
 *
 * A **view** is not among the reasons. A view never takes rows from the grid,
 * whoever looks at it, so there is nothing to explain and Insert is not
 * offered at all (ADR #136); the table source decides that before asking here.
 *
 * One decision, consumed by the toolbar's Insert button, the empty grid's
 * context menu and its `EmptyState`, so the three cannot disagree.
 */

/** Why an insert cannot begin. Checked in this order — see `insertAvailability`. */
export type InsertBlock =
  | { kind: "noPk" }
  | { kind: "policy"; reason: string }
  | { kind: "pkHidden" };

export interface InsertInputs {
  /** How many columns the table's primary key has. */
  pkColumnCount: number;
  /**
   * Every key column is in the current result. False under a projection that
   * leaves one out: the new row could be written, but not addressed after.
   */
  pkInResult: boolean;
  /** The managed policy's reason, when it forbids inserting here. */
  policyLock: string | null;
}

/**
 * `null` when an insert can begin, otherwise the first reason it cannot.
 *
 * The order goes from what the user cannot change to what they can, so the
 * reason shown is the one that matters: naming the projection would be useless
 * advice on a table that has no key at all, and lifting the policy would not
 * give a keyless table a key.
 */
export function insertAvailability(i: InsertInputs): InsertBlock | null {
  if (i.pkColumnCount === 0) return { kind: "noPk" };
  if (i.policyLock) return { kind: "policy", reason: i.policyLock };
  if (!i.pkInResult) return { kind: "pkHidden" };
  return null;
}

/** The i18n key for each structural reason; a policy brings its own text. */
export const INSERT_BLOCK_KEYS = {
  noPk: "dataGrid.insertBlocked.noPk",
  pkHidden: "dataGrid.insertBlocked.pkHidden",
} as const;

/** The sentence to show for `block`, translated by `t`. */
export function insertBlockReason(
  block: InsertBlock,
  t: (key: string) => string,
): string {
  return block.kind === "policy" ? block.reason : t(INSERT_BLOCK_KEYS[block.kind]);
}
