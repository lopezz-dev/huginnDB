/**
 * A Monaco language for the **query tab's** `mongosh` source — `db.users
 * .find({ … }).sort({ … })` — registered ONCE per Monaco instance and served
 * per model, exactly like `monacoSql.ts` and `monacoMongo.ts` (gotcha #9).
 *
 * ## Why a third language
 *
 * The query tab used to hand a MongoDB connection the `"sql"` language,
 * literally and with no driver branch. `keywordsFor("mongodb")` already
 * returned Mongo vocabulary, so the *words* were roughly right, but
 * everything around them was SQL: a Monarch grammar that highlights `SELECT`,
 * a comment configuration where the line comment is `--` (so a `//` note tokenised as an
 * operator, and Ctrl+/ inserted a `--` the Mongo grammar does not know), and
 * a flat completion list with no trigger characters and no idea
 * what a chain is. Typing `db` produced an empty widget, because `"db"` is in
 * no catalogue and Monaco had ~70 unrelated items to fuzzy-match it against.
 *
 * `mongodb-pipeline` is not the answer either: that grammar begins *inside* a
 * stage's `{`, and nothing in it knows what `db.` means.
 *
 * Like its sibling, this language needs no worker (Monarch only — ADR #2):
 * `javascript` would need the TypeScript worker this app deliberately does
 * not bundle, and `json` would flag every legal thing the relaxed grammar
 * allows as an error.
 *
 * ## What the provider understands
 *
 * `shellSlotAt` (a cursor scanner, never a parser — ADR #33) answers where
 * the cursor is, and the catalogues in `shellCatalog.ts` — mirrors of
 * `src-tauri/src/db/mongo/shell.rs` — answer what belongs there:
 *
 * - at the start of a statement → `db`, plus a whole-statement snippet;
 * - after `db.` → collection names from the live schema;
 * - after `db.<collection>.` → the methods `build_op` accepts, inserted as
 *   real snippets (`find({})`, not a bare `find`), because a bare method name
 *   is never a runnable statement;
 * - after a closed call's `.` → the four cursor modifiers `finish` accepts,
 *   and only those — anything else there is a guaranteed parse error;
 * - inside an argument list → field names and the `$`-operators that fit the
 *   call: query operators in a filter, update operators in an update
 *   document, and the full aggregation catalogues inside `aggregate([…])`.
 *
 * The stage/accumulator/expression reasoning deliberately is *not* shared with
 * `monacoMongo.ts` even though the catalogues are. That provider is written
 * against a stage body, whose cursor path starts inside the stage's own `{`;
 * here the same catalogues are reached one frame deeper, through an argument
 * list. Sharing would mean parameterising precisely the arithmetic that
 * differs, which is how both would end up wrong.
 *
 * Field suggestions never fetch from inside the provider (it cannot `await`):
 * they read what `MongoQueryEntry.getFields` has cached and fire
 * `requestFields` at most once per collection per session (ADR #57). The
 * same ADR puts dotted nested paths and "fields after this stage" out of
 * scope on purpose, and nothing here reaches for them.
 */

import type { Monaco } from "@monaco-editor/react";
import { STAGE_CATALOG } from "@/lib/mongo/stages";
import { ACCUMULATOR_CATALOG } from "@/lib/mongo/accumulators";
import { completionPositionAt } from "@/lib/mongo/completionContext";
import { shellSlotAt } from "@/lib/mongo/shellContext";
import {
  BSON_CONSTRUCTORS,
  CURSOR_MODIFIERS,
  QUERY_OPERATORS,
  SHELL_METHODS,
  UPDATE_METHODS,
  UPDATE_OPERATORS,
  type ShellMethodSpec,
} from "@/lib/mongo/shellCatalog";
import { EXPRESSION_OPERATORS } from "@/lib/monaco/monacoMongo";
import { ensureRunLensProvider } from "@/lib/monaco/monacoSql";

export const MONGO_QUERY_LANGUAGE = "mongodb-query";

/** Calls whose arguments are field *keys* and nothing else — no operator
 *  belongs in a sort spec or an index key document. */
const FIELD_ONLY_CALLS: ReadonlySet<string> = new Set([
  "sort",
  "projection",
  "project",
  "createIndex",
  "distinct",
]);

/** Live data one query editor offers the shared completion provider. */
export interface MongoQueryEntry {
  /** Every collection in the database the tab is scoped to. */
  getCollections: () => string[];
  /** Cached first-level field names for `collection`, or `undefined` when
   *  they have not been sampled yet (an empty-but-loaded collection is `[]`). */
  getFields: (collection: string) => string[] | undefined;
  /** Fire-and-forget request for a collection's fields; callers dedupe. */
  requestFields: (collection: string) => void;
}

/** Per-model live data, keyed by `model.uri.toString()` (gotcha #9). */
const registry = new Map<string, MongoQueryEntry>();

/** Register one editor's live data. Returns a disposer that unregisters it. */
export function registerMongoQueryEditor(
  uri: string,
  entry: MongoQueryEntry,
): () => void {
  registry.set(uri, entry);
  return () => {
    registry.delete(uri);
  };
}

let installed: Monaco | null = null;

/** Register the language, its grammar, its completions and its "▶ Run"
 *  CodeLens. Idempotent per Monaco instance. */
export function ensureMongoQueryProviders(monaco: Monaco) {
  // The lens provider is registered per *language*, so a Mongo query tab
  // needs its own — without this the "▶ Run" gutter icon simply stops being
  // offered, silently, the moment the model leaves `"sql"`.
  ensureRunLensProvider(monaco, MONGO_QUERY_LANGUAGE);

  if (installed === monaco) return;
  installed = monaco;

  monaco.languages.register({ id: MONGO_QUERY_LANGUAGE });

  monaco.languages.setLanguageConfiguration(MONGO_QUERY_LANGUAGE, {
    // `//` and `/* */`, which is what makes Ctrl+/ insert a comment this
    // grammar's parser actually skips instead of a SQL `--`.
    comments: { lineComment: "//", blockComment: ["/*", "*/"] },
    brackets: [
      ["{", "}"],
      ["[", "]"],
      ["(", ")"],
    ],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: '"', close: '"', notIn: ["string"] },
      { open: "'", close: "'", notIn: ["string"] },
    ],
    surroundingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
    ],
  });

  monaco.languages.setMonarchTokensProvider(MONGO_QUERY_LANGUAGE, {
    defaultToken: "",
    // Same token names every theme in `monaco-themes.ts` already styles, so a
    // user-picked Monaco theme colours this language without knowing it
    // exists.
    methods: [...SHELL_METHODS, ...CURSOR_MODIFIERS].map((m) => m.name),
    constructors: [...BSON_CONSTRUCTORS],
    tokenizer: {
      root: [
        [/\/\/.*$/, "comment"],
        [/\/\*/, "comment", "@blockComment"],

        // The `db` handle itself — the one identifier that means something on
        // its own in this grammar.
        [/\bdb\b/, "predefined"],

        // A call: a known method or modifier reads as a keyword, a known BSON
        // constructor as a type, anything else as a plain identifier.
        [
          /[A-Za-z_][\w$]*(?=\s*\()/,
          {
            cases: {
              "@methods": "keyword",
              "@constructors": "type",
              "@default": "identifier",
            },
          },
        ],

        // Keys. An operator key is a keyword; anything else is a field name.
        // Checked before the value rules so the trailing `:` decides
        // key-vs-value rather than the quoting, same as the pipeline grammar.
        [/\$[A-Za-z_][\w$]*(?=\s*:)/, "keyword"],
        [/"\$[^"\\]*"(?=\s*:)/, "keyword"],
        [/'\$[^'\\]*'(?=\s*:)/, "keyword"],
        [/[A-Za-z_][\w$]*(?=\s*:)/, "identifier"],
        [/"(?:[^"\\]|\\.)*"(?=\s*:)/, "identifier"],
        [/'(?:[^'\\]|\\.)*'(?=\s*:)/, "identifier"],

        // Values. A `$`-prefixed string is a field path or system variable,
        // not text — inside `aggregate([…])` that distinction is the whole
        // ballgame.
        [/"\$\$?(?:[^"\\]|\\.)*"/, "predefined"],
        [/'\$\$?(?:[^'\\]|\\.)*'/, "predefined"],
        [/"(?:[^"\\]|\\.)*"/, "string"],
        [/'(?:[^'\\]|\\.)*'/, "string"],

        [/\b(?:true|false|null|undefined|new)\b/, "keyword"],
        [/-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/, "number"],

        [/[{}[\]()]/, "delimiter"],
        [/[,:;.]/, "delimiter"],
      ],
      blockComment: [
        [/[^/*]+/, "comment"],
        [/\*\//, "comment", "@pop"],
        [/[/*]/, "comment"],
      ],
    },
  });

  monaco.languages.registerCompletionItemProvider(MONGO_QUERY_LANGUAGE, {
    // `.` is the one that matters: every structural position in this grammar
    // opens right after a dot, and without it Monaco waits for a word
    // character that, at `db.|`, never comes. `$` and `"` mirror the pipeline
    // provider — operators are typed sigil-first, and Monaco's default
    // `quickSuggestions` never fires inside a string literal, which is where
    // `distinct("field")` wants a field name.
    triggerCharacters: [".", "$", '"'],
    provideCompletionItems: (model, position, context) => {
      const text = model.getValue();
      const offset = model.getOffsetAt(position);
      const word = model.getWordUntilPosition(position);
      const line = model.getValueInRange({
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: 1,
        endColumn: position.column,
      });

      // Monaco's word boundary stops at `$`, so an item inserted at
      // `word.startColumn` would leave the `$` the user typed in front of it.
      // Extend the replaced span back over it when it's there — and carry the
      // `$` in the *label* too, because Monaco filters the label against the
      // text the range spans and would otherwise discard the item before it
      // ever reached the widget (`monacoMongo.ts` documents the same trap).
      const hasDollar = line.endsWith(`$${word.word}`);
      const dollarRange = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn - (hasDollar ? 1 : 0),
        endColumn: word.endColumn,
      };
      const plainRange = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };

      const entry = registry.get(model.uri.toString());
      const collections = entry?.getCollections() ?? [];
      const slot = shellSlotAt(text, offset, collections);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const suggestions: any[] = [];
      const kinds = monaco.languages.CompletionItemKind;
      const asSnippet =
        monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;

      const pushMethods = (
        specs: ReadonlyArray<ShellMethodSpec>,
        sortTier: string,
      ) => {
        specs.forEach((m, i) => {
          suggestions.push({
            label: m.name,
            kind: kinds.Method,
            insertText: m.insertSnippet,
            insertTextRules: asSnippet,
            detail: m.aliasOf
              ? `${m.signature} · alias of ${m.aliasOf}`
              : m.write
                ? `${m.signature} · write`
                : m.signature,
            sortText: `${sortTier}${String(i).padStart(2, "0")}`,
            range: plainRange,
          });
        });
      };

      const pushCollections = (prefix: string, sortTier: string) => {
        const head = prefix ? `${prefix}.` : "";
        for (const name of collections) {
          if (head && !name.startsWith(head)) continue;
          const remainder = name.slice(head.length);
          if (!remainder) continue;
          suggestions.push({
            label: remainder,
            kind: kinds.Class,
            insertText: remainder,
            detail: "collection",
            sortText: `${sortTier}_${remainder}`,
            range: plainRange,
          });
        }
      };

      /** Field names for `collection`, or a single fire-and-forget request
       *  when they aren't cached yet. `prefix` carries the `$` for a field
       *  *reference* (aggregate expressions) and is empty for a plain key. */
      const pushFields = (
        collection: string | null,
        range: typeof plainRange,
        prefix: string,
      ) => {
        if (!collection || !entry) return;
        const fields = entry.getFields(collection);
        if (fields === undefined) {
          entry.requestFields(collection);
          return;
        }
        for (const f of fields) {
          suggestions.push({
            label: `${prefix}${f}`,
            kind: kinds.Field,
            insertText: `${prefix}${f}`,
            detail: "field",
            sortText: `0_${f}`,
            range,
          });
        }
      };

      /** A BSON constructor is a legitimate bare *value* anywhere in this
       *  grammar (`_id: ObjectId("…")`), so it is offered throughout an
       *  argument list rather than being gated on a slot or on a typed `$`. */
      const pushConstructors = () => {
        for (const name of BSON_CONSTRUCTORS) {
          suggestions.push({
            label: name,
            kind: kinds.Constructor,
            insertText: `${name}("$1")`,
            insertTextRules: asSnippet,
            detail: "BSON",
            sortText: `2${name}`,
            range: dollarRange,
          });
        }
      };

      const pushOperators = (
        ops: ReadonlyArray<string>,
        detail: string,
        sortTier: string,
      ) => {
        for (const op of ops) {
          suggestions.push({
            label: op,
            kind: kinds.Function,
            insertText: `${op}: `,
            detail,
            sortText: `${sortTier}${op}`,
            range: dollarRange,
          });
        }
      };

      switch (slot.kind) {
        case "none":
          break;

        case "root":
          suggestions.push(
            {
              label: "db",
              kind: kinds.Variable,
              insertText: "db.",
              detail: "the current database",
              sortText: "00",
              range: plainRange,
            },
            {
              label: "db.collection.find",
              kind: kinds.Snippet,
              insertText: "db.${1:collection}.find({$2})",
              insertTextRules: asSnippet,
              detail: "statement",
              sortText: "01",
              range: plainRange,
            },
          );
          break;

        case "collection":
          pushCollections(slot.prefix, "0");
          break;

        case "method":
          pushMethods(SHELL_METHODS, "0");
          break;

        case "collectionOrMethod":
          // Both readings are legal here (`logs` is a collection *and* the
          // head of `logs.2024`), so both are offered — methods first,
          // because a finished collection name is the commoner case.
          pushMethods(SHELL_METHODS, "0");
          pushCollections(slot.prefix, "1");
          break;

        case "modifier":
          pushMethods(CURSOR_MODIFIERS, "0");
          break;

        case "argument": {
          const argText = text.slice(slot.argStart, offset);
          const cursor = completionPositionAt(argText, argText.length);
          const innermost = cursor.path[cursor.path.length - 1];
          const parentFrame = cursor.path[cursor.path.length - 2];
          const dollarContext = hasDollar || context.triggerCharacter === "$";
          const call = slot.call ?? "";

          if (slot.method === "aggregate") {
            // Pipeline semantics. One frame deeper than the aggregation tab's
            // own editor, because here the array literal is an argument: the
            // stage body's top level is [root, `[`, `{`] rather than
            // [root, `{`].
            if (dollarContext) {
              const atStage =
                innermost.type === "object" && parentFrame?.type === "array";
              if (atStage) {
                STAGE_CATALOG.forEach((stage, i) => {
                  suggestions.push({
                    label: stage.operator,
                    kind: kinds.Snippet,
                    insertText: stage.insertSnippet,
                    insertTextRules: asSnippet,
                    detail: "stage",
                    documentation: { value: "```js\n" + stage.snippet + "\n```" },
                    sortText: `0${String(i).padStart(3, "0")}`,
                    range: dollarRange,
                  });
                });
              }

              // An accumulator is never valid bare, so it carries its own
              // `{ … }` unless the braces are already open at the cursor —
              // the same two insertions `monacoMongo.ts` documents.
              const bareAccumulatorSlot =
                cursor.slot === "value" &&
                cursor.forKey &&
                cursor.forKey !== "_id" &&
                (innermost.key === "$group" || innermost.key === "output");
              const bracedAccumulatorSlot =
                cursor.slot === "key" &&
                innermost.type === "object" &&
                innermost.key !== null &&
                innermost.key !== "_id" &&
                (parentFrame?.key === "$group" || parentFrame?.key === "output");
              if (bareAccumulatorSlot || bracedAccumulatorSlot) {
                ACCUMULATOR_CATALOG.forEach((acc, i) => {
                  suggestions.push({
                    label: acc.operator,
                    kind: kinds.Function,
                    insertText: bracedAccumulatorSlot
                      ? acc.insertSnippet
                      : `{ ${acc.insertSnippet} }`,
                    insertTextRules: asSnippet,
                    detail: "accumulator",
                    sortText: `0${String(i).padStart(2, "0")}`,
                    range: dollarRange,
                  });
                });
              }

              // An expression operator is always a key; at a value slot the
              // one thing that belongs is a field reference.
              if (cursor.slot !== "value")
                pushOperators(EXPRESSION_OPERATORS, "expression", "1");
            }
            if (dollarContext) pushFields(slot.collection, dollarRange, "$");
            else if (cursor.slot === "key")
              pushFields(slot.collection, plainRange, "");
            pushConstructors();
            break;
          }

          if (dollarContext) {
            if (!FIELD_ONLY_CALLS.has(call)) {
              pushOperators(QUERY_OPERATORS, "query operator", "0");
              // `updateOne`/`updateMany` take a filter *and* an update
              // document, and nothing short of counting top-level commas
              // would tell them apart — which is parsing. Offering both sets
              // is the honest answer: an operator in the wrong argument is an
              // error the backend names precisely.
              if (UPDATE_METHODS.has(slot.method ?? ""))
                pushOperators(UPDATE_OPERATORS, "update operator", "1");
            }
          } else if (cursor.slot !== "value" || call === "distinct") {
            // No `$` typed: field names, wherever a key (or a bare string, as
            // in `distinct("…")`) is what belongs.
            pushFields(slot.collection, plainRange, "");
          }
          pushConstructors();
          break;
        }
      }

      return { suggestions };
    },
  });
}
