/**
 * Open a query tab.
 *
 * Seven call sites assembled the `useTabs.open({ kind: "query", … })` payload
 * themselves, and the five that open an *empty* query each carried the seed text
 * as a raw English literal — `"-- write a SQL query and press Ctrl+Enter\n"` —
 * so a Spanish user got an English comment in a brand-new tab five different
 * ways. The seed is now an i18n key.
 *
 * `resolveTarget` routes the tab through `useTabs.queryTargetFor`, which lands
 * it on the database the user is currently looking at rather than the parent
 * connection. That is what every "new query here" affordance wants, so it is the
 * default — but `StatusBar`'s history menu passes `false` deliberately: it
 * reopens a *past* query on the connection it was originally run against, and
 * redirecting that to whichever database happens to be in front of the user
 * would reopen it against the wrong data.
 */

import i18n from "i18next";

import { useTabs } from "@/stores/session/tabs";
import { useConnections } from "@/stores/session/connections";
import { resolveConnectionDriver } from "@/lib/connectionLabel";
import { usePendingRuns } from "@/stores/query/pendingRuns";

export interface OpenQueryTabOptions {
  /** SQL to seed the tab with. Omitted means a new, empty query. */
  sql?: string;
  /** Tab title. Defaults to the generic query-file name. */
  title?: string;
  /** Route through `queryTargetFor`. Defaults to `true`. */
  resolveTarget?: boolean;
  /** Run the buffer once the tab mounts, through the tab's own runner — a
   *  batch goes down the batch path (ADR #137). The history panel's Run. */
  run?: boolean;
}

/**
 * Default title + seed text for a brand-new query tab, driver-aware.
 *
 * MongoDB's query tab does not run SQL — it runs a bounded `mongosh`-style
 * command (`db.<collection>.<method>(...)`, see
 * `src-tauri/src/db/mongo/shell.rs`). Defaulting to `"query.sql"` and a `--`
 * comment regardless of driver is what caused real confusion (issues reported
 * by the team mistaking this tab for a SQL surface against Mongo).
 *
 * **A Mongo tab opens empty, with no seeded comment.** It used to carry
 * `// db.collection.find({}) — press Ctrl+Enter`, and that line made the tab
 * fail on its first run: `shell::parse` trims whitespace and a trailing `;`
 * and then insists the statement starts with `db.`, so a buffer that begins
 * with a comment is rejected outright with "MongoDB statements must start with
 * `db.`" — a hint that broke the thing it was hinting at. The SQL seed is a
 * `--` comment and stays, because every SQL engine here skips one.
 */
function defaultQuerySeed(connectionId: string): { title: string; query: string } {
  const driver = resolveConnectionDriver(
    useConnections.getState().profiles,
    connectionId,
  );
  if (driver === "mongodb") {
    return { title: i18n.t("tabs.mongoQueryFileName"), query: "" };
  }
  return {
    title: i18n.t("tabs.queryFileName"),
    query: i18n.t("query.newTabPlaceholder"),
  };
}

/** Returns the new tab's id. */
export function openQueryTab(
  connectionId: string,
  opts: OpenQueryTabOptions = {},
): string {
  const tabs = useTabs.getState();
  const fallback = defaultQuerySeed(connectionId);
  const id = tabs.open({
    kind: "query",
    title: opts.title ?? fallback.title,
    connectionId:
      opts.resolveTarget === false
        ? connectionId
        : tabs.queryTargetFor(connectionId),
    query: opts.sql ?? fallback.query,
  });
  if (opts.run) usePendingRuns.getState().mark(id);
  return id;
}
