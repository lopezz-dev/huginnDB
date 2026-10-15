/**
 * Cursor-position scanner for a `mongosh`-style statement, feeding the query
 * tab's Mongo completion provider (`src/lib/monaco/monacoMongoQuery.ts`)
 * enough context to answer "what is the user about to type here?".
 *
 * Same rule as its sibling `completionContext.ts`: this is **not** a parser
 * (ADR #33). It never validates, never builds an AST, and gives up with
 * the most conservative answer on anything it doesn't recognise — the text
 * that reaches the backend is untouched and still parsed exactly once, in
 * Rust. All it tracks is which lexical context the cursor sits in (string,
 * comment, argument list), how deep the parentheses go, and the dotted chain
 * typed at depth zero. It never looks past the cursor: everything after
 * `offset` is unwritten as far as this scan is concerned.
 *
 * The chain rules mirror `shell.rs`'s own splitting, not JavaScript's:
 *
 * - the collection is everything between `db.` and the **last** dot before
 *   the first `(`, so `db.my.coll.find(` is the collection `my.coll`;
 * - `db.getCollection("name").method(…)` is the second accepted form, and
 *   its first call is the *collection*, not the method;
 * - after the primary call closes, a dot opens a **cursor modifier**
 *   (`.sort(…)`, `.limit(…)`, …) rather than another method.
 *
 * Because "is `db.my.` a finished collection or half of `my.coll`?" cannot be
 * answered from the text alone, {@link shellSlotAt} takes the live collection
 * list and reports the ambiguous case as its own slot rather than guessing.
 */

/** What the cursor is about to write. */
export type ShellSlot =
  /** Nothing useful — inside a string, a comment, or an unrecognised shape. */
  | { kind: "none" }
  /** The statement has not reached its first dot yet: `db` itself is the
   *  suggestion (plus the whole-statement snippet). */
  | { kind: "root" }
  /**
   * A collection name. `prefix` is the dotted head already typed (empty right
   * after `db.`) — `shell.rs` splits the collection at the **last** dot before
   * the first `(`, so `db.logs.` may still be growing into `logs.2024`, and
   * the caller offers only the remainder after `prefix`.
   */
  | { kind: "collection"; prefix: string }
  /** Right after `db.<collection>.` — a collection method. */
  | { kind: "method"; collection: string }
  /** Right after `db.<prefix>.` where `<prefix>` is both a known collection
   *  *and* the start of a dotted one: both a method and the remaining
   *  collection names are legitimate here. */
  | { kind: "collectionOrMethod"; collection: string; prefix: string }
  /** Right after a closed call's dot — one of the four cursor modifiers. */
  | { kind: "modifier" }
  /**
   * Inside an argument list. `argStart` is the offset just past the call's
   * own `(`, so the caller can run `completionPositionAt` over exactly the
   * argument text and reuse the pipeline editor's key/value reasoning.
   */
  | {
      kind: "argument";
      /** The statement's collection, when it has been typed. */
      collection: string | null;
      /** The call the cursor is inside — the primary method, or a chained
       *  modifier such as `sort`. */
      call: string | null;
      /** The primary method, even when `call` is a modifier. */
      method: string | null;
      argStart: number;
    };

const IDENT_CHAR = /[A-Za-z0-9_$]/;

/** Raw facts the scan collects; {@link shellSlotAt} turns them into a slot. */
interface ScanState {
  /** Dot-separated identifiers typed at paren depth 0 since the statement
   *  began. `tokens[0]` is `db` in a well-formed statement, and a trailing
   *  `""` means the cursor sits right after a dot. */
  tokens: string[];
  depth: number;
  /** Offset just past the opening `(` of the outermost call currently open;
   *  `-1` when no call is open. */
  argStart: number;
  /** Top-level `(…)` groups already closed in this statement. */
  closedCalls: number;
  /** The `db.getCollection("…")` name, once its string literal is typed. */
  getCollectionName: string | null;
  /** Collection / method resolved when the primary call opened, so a chained
   *  `.sort({…})` still knows which collection its fields come from. */
  resolvedCollection: string | null;
  resolvedMethod: string | null;
  /** Name of the innermost open top-level call. */
  call: string | null;
  /** True when the cursor landed inside an unterminated comment. */
  inComment: boolean;
  /**
   * True when the cursor landed inside an unterminated string. Tracked apart
   * from {@link inComment} because a string is opaque to the *chain* but not
   * to the *arguments*: `distinct("fie|` and `find({ "na|` are both places
   * where a field name is exactly what belongs.
   */
  inString: boolean;
}

function freshStatement(): ScanState {
  return {
    tokens: [],
    depth: 0,
    argStart: -1,
    closedCalls: 0,
    getCollectionName: null,
    resolvedCollection: null,
    resolvedMethod: null,
    call: null,
    inComment: false,
    inString: false,
  };
}

/**
 * Scan `text` up to `offset`, resetting at every top-level `;` so only the
 * statement the cursor is in is described. Strings and comments are skipped
 * as opaque spans, and a cursor that lands *inside* one is reported as such.
 */
function scan(text: string, offset: number): ScanState {
  const end = Math.min(offset, text.length);
  let st = freshStatement();
  /** The token the next identifier characters append to; `null` when the
   *  previous character ended one. */
  let open = false;

  const pushDot = () => {
    st.tokens.push("");
    open = true;
  };

  let i = 0;
  while (i < end) {
    const c = text[i];

    // Comments — both forms, because this grammar is JavaScript-shaped and
    // `//` is what Ctrl+/ writes in a Mongo query tab.
    if (c === "/" && text[i + 1] === "/") {
      while (i < end && text[i] !== "\n") i += 1;
      if (i >= end) st.inComment = true;
      open = false;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < end && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      if (i >= end) st.inComment = true;
      i += 2;
      open = false;
      continue;
    }

    if (c === '"' || c === "'") {
      const quote = c;
      const start = i;
      i += 1;
      while (i < end && text[i] !== quote) {
        if (text[i] === "\\") i += 1;
        i += 1;
      }
      const closed = i < end && text[i] === quote;
      // `db.getCollection("name")` — the only string this scan reads rather
      // than merely skipping, because it *is* the collection name.
      if (
        st.depth === 1 &&
        st.closedCalls === 0 &&
        st.tokens[1] === "getCollection" &&
        st.getCollectionName === null
      ) {
        st.getCollectionName = text.slice(start + 1, i);
      }
      if (!closed) st.inString = true;
      else i += 1;
      open = false;
      continue;
    }

    if (c === "(") {
      if (st.depth === 0) {
        const name = st.tokens[st.tokens.length - 1] ?? null;
        st.argStart = i + 1;
        st.call = name;
        const isGetCollectionCall =
          st.tokens[1] === "getCollection" && st.closedCalls === 0;
        if (!isGetCollectionCall && st.resolvedMethod === null) {
          st.resolvedMethod = name;
          st.resolvedCollection =
            st.getCollectionName ?? st.tokens.slice(1, -1).join(".");
        }
      }
      st.depth += 1;
      open = false;
      i += 1;
      continue;
    }
    if (c === ")") {
      st.depth -= 1;
      if (st.depth <= 0) {
        st.depth = 0;
        st.closedCalls += 1;
        st.argStart = -1;
        st.call = null;
      }
      open = false;
      i += 1;
      continue;
    }

    if (st.depth === 0) {
      if (c === ";") {
        st = freshStatement();
        open = false;
        i += 1;
        continue;
      }
      if (c === ".") {
        pushDot();
        i += 1;
        continue;
      }
      // Whitespace deliberately leaves `open` alone: `db. users` still means
      // the collection `users`, not a token of its own.
      if (c === " " || c === "\t" || c === "\n" || c === "\r") {
        i += 1;
        continue;
      }
      if (IDENT_CHAR.test(c)) {
        const start = i;
        while (i < end && IDENT_CHAR.test(text[i])) i += 1;
        const word = text.slice(start, i);
        if (open) st.tokens[st.tokens.length - 1] += word;
        else st.tokens.push(word);
        open = true;
        continue;
      }
      open = false;
      i += 1;
      continue;
    }

    i += 1;
  }

  return st;
}

/**
 * Describe the completion slot at `offset`.
 *
 * `collections` is the live collection list — used only to tell a finished
 * collection name from the first segment of a dotted one, never fetched here.
 */
export function shellSlotAt(
  text: string,
  offset: number,
  collections: ReadonlyArray<string> = [],
): ShellSlot {
  const st = scan(text, offset);
  if (st.inComment) return { kind: "none" };

  if (st.depth > 0) {
    return {
      kind: "argument",
      collection: st.resolvedCollection || null,
      call: st.call,
      method: st.resolvedMethod,
      argStart: st.argStart,
    };
  }

  // Nothing typed yet, or a bare word with no dot — `db` itself is the
  // suggestion. Also the state right after a `;`, which is what makes the
  // second statement of a script behave like the first.
  if (st.inString) return { kind: "none" };

  // `db` itself is offered even when it is already fully typed: the reported
  // symptom this whole provider exists for was typing `db` and getting an
  // empty widget, and an exact-match item plus the whole-statement snippet is
  // the shape that answers it.
  if (st.tokens.length <= 1) return { kind: "root" };
  if (st.tokens[0] !== "db") return { kind: "none" };

  // A dot after the primary call closed can only open a cursor modifier. The
  // `getCollection` form spends its first call on the collection, so its
  // primary call is the second one.
  const primaryCallIndex = st.tokens[1] === "getCollection" ? 1 : 0;
  if (st.closedCalls > primaryCallIndex) return { kind: "modifier" };

  if (st.tokens[1] === "getCollection") {
    return st.closedCalls === 1
      ? { kind: "method", collection: st.getCollectionName ?? "" }
      : { kind: "none" };
  }

  const prefix = st.tokens.slice(1, -1).join(".");
  if (!prefix) return { kind: "collection", prefix: "" };

  const isCollection = collections.includes(prefix);
  const isDottedPrefix = collections.some((c) => c.startsWith(`${prefix}.`));
  if (isCollection && isDottedPrefix)
    return { kind: "collectionOrMethod", collection: prefix, prefix };
  if (isDottedPrefix) return { kind: "collection", prefix };
  // Unknown prefix (schema not loaded yet, or a collection created since the
  // last refresh): methods are the overwhelmingly likelier intent, and
  // offering them is what makes the editor useful before the tree is warm.
  return { kind: "method", collection: prefix };
}
