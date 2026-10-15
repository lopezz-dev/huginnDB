/**
 * Cursor-position scanner for a pipeline stage body, feeding the Mongo
 * completion provider (`src/lib/monaco/monacoMongo.ts`) enough context to
 * offer field/collection suggestions instead of only the static operator
 * lists.
 *
 * Same rule as `pipeline.ts`'s `firstKeySpan`: this is **not** a JSON parser.
 * It never validates, never builds an AST, and gives up (returns the most
 * conservative answer) on anything it doesn't recognise — the text that
 * actually reaches the backend is untouched, still parsed exactly once, in
 * Rust (ADR #33). What it tracks is only brace/bracket depth and which key
 * immediately precedes the value at a given offset, which is enough to answer
 * "is the cursor inside a `$lookup`'s `from`?" without understanding the rest
 * of the document. It also never looks past the cursor: everything after
 * `offset` is unwritten as far as this scan is concerned, matching what the
 * user has actually typed so far.
 */

export interface Frame {
  type: "object" | "array";
  /** The key, in the parent frame, that this frame is the value of. `null`
   *  for the outermost frame (the stage body itself) and for an array
   *  element. */
  key: string | null;
  /** Offset of this frame's opening `{` or `[`. */
  start: number;
}

export interface CompletionPosition {
  /** Enclosing frames, outermost first. Always has at least one entry — a
   *  virtual root frame with `start: -1`. */
  path: Frame[];
  /** Whether the cursor is about to write an object key, a value, or neither
   *  (an array with no pending key, or before any bracket has opened). */
  slot: "key" | "value" | "unknown";
  /** When `slot === "value"`, the key this value belongs to. `null` when it
   *  couldn't be determined (e.g. an array element). */
  forKey: string | null;
}

const WORD_CHAR = /[A-Za-z0-9_$.]/;

/**
 * Scan `text` up to `offset`, tracking brace/bracket depth and the key each
 * object value belongs to. Strings and comments are skipped as opaque spans
 * so punctuation inside them never perturbs the depth count.
 */
export function completionPositionAt(text: string, offset: number): CompletionPosition {
  const end = Math.min(offset, text.length);
  const stack: Frame[] = [{ type: "object", key: null, start: -1 }];
  // The key most recently read in the current (innermost) frame, pending its
  // `:` and value.
  let pendingKey: string | null = null;
  // True once `:` has been seen for the pending key and no `,`/close has
  // followed it yet — i.e. the cursor, if it lands now, is inside a value.
  let afterColon = false;

  let i = 0;
  while (i < end) {
    const c = text[i];

    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i += 1;
      continue;
    }

    if (c === "/" && text[i + 1] === "/") {
      while (i < end && text[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < end && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }

    if (c === '"' || c === "'") {
      const quote = c;
      const strStart = i;
      i += 1;
      while (i < end && text[i] !== quote) {
        if (text[i] === "\\") i += 1;
        i += 1;
      }
      // Never peek past `end`: a still-open string at the cursor (the
      // common case — the user just typed the opening quote) simply reports
      // whatever was typed so far, rather than looking ahead at an
      // auto-closed quote that sits past the cursor.
      const closedWithinBounds = i < end && text[i] === quote;
      const value = text.slice(strStart + 1, i);
      if (!afterColon) pendingKey = value;
      if (closedWithinBounds) i += 1;
      continue;
    }

    if (c === "{" || c === "[") {
      const key = afterColon ? pendingKey : null;
      stack.push({ type: c === "{" ? "object" : "array", key, start: i });
      pendingKey = null;
      afterColon = false;
      i += 1;
      continue;
    }

    if (c === "}" || c === "]") {
      if (stack.length > 1) stack.pop();
      pendingKey = null;
      afterColon = false;
      i += 1;
      continue;
    }

    if (c === ":") {
      afterColon = true;
      i += 1;
      continue;
    }

    if (c === ",") {
      pendingKey = null;
      afterColon = false;
      i += 1;
      continue;
    }

    if (WORD_CHAR.test(c)) {
      const start = i;
      while (i < end && WORD_CHAR.test(text[i])) i += 1;
      const word = text.slice(start, i);
      if (!afterColon) pendingKey = word;
      continue;
    }

    i += 1;
  }

  const path = stack.slice();
  const innermost = path[path.length - 1];

  if (afterColon) {
    return { path, slot: "value", forKey: pendingKey };
  }
  if (path.length === 1) {
    // Nothing has opened yet — leading whitespace before the stage's own
    // `{`. Not a position we offer suggestions for.
    return { path, slot: "unknown", forKey: null };
  }
  if (innermost.type === "object") {
    return { path, slot: "key", forKey: null };
  }
  return { path, slot: "unknown", forKey: null };
}

/**
 * Read a sibling string value inside `frame`'s own span — e.g. the `from`
 * already typed in the `$lookup` object the cursor is currently inside.
 *
 * A small regex scan bounded to the frame's text, not a parser: good enough
 * for a UI suggestion, and wrong only in the same pathological cases
 * `firstKeySpan` already accepts (e.g. a `from` inside a nested sub-document
 * would also match — vanishingly rare in a `$lookup` shape, and the cost of
 * a miss is "no suggestion", never a wrong query).
 */
export function siblingStringValue(text: string, frame: Frame, key: string): string | null {
  if (frame.start < 0) return null;
  const closeOffset = matchingCloseOffset(text, frame.start);
  const span = text.slice(frame.start, closeOffset ?? text.length);
  const pattern = new RegExp(`["']?${escapeRegExp(key)}["']?\\s*:\\s*["']([^"']*)["']`);
  const match = pattern.exec(span);
  return match ? match[1] : null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Offset just past the `}`/`]` that closes the bracket opened at `openOffset`. */
function matchingCloseOffset(text: string, openOffset: number): number | null {
  const open = text[openOffset];
  const close = open === "{" ? "}" : open === "[" ? "]" : null;
  if (!close) return null;
  let depth = 0;
  let i = openOffset;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const quote = c;
      i += 1;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === "\\") i += 1;
        i += 1;
      }
      i += 1;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    if (c === open) depth += 1;
    else if (c === close) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return null;
}
