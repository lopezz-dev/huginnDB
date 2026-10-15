/**
 * A Monaco language for MongoDB aggregation source, registered ONCE per Monaco
 * instance (same rationale as `monacoSql.ts`: language providers are global,
 * not per editor — gotcha #9), plus a per-model registry so the completion
 * provider can also offer *live* collection/field suggestions (the
 * Compass-style "$lookup shows you the fields" behaviour) without knowing
 * about any particular editor.
 *
 * Why not reuse an existing language? `json` runs a validator that would mark
 * every legal thing this grammar allows — unquoted keys, single quotes,
 * `ObjectId("…")`, comments — as an error, and `javascript` needs the
 * TypeScript worker we deliberately don't bundle. So the aggregation editors
 * get their own small Monarch grammar, which also lets the two things that
 * actually carry meaning in a pipeline be coloured apart:
 *
 * - an **operator key** (`$match`, `$sum`) reads as a keyword, and
 * - a **field reference** (`"$customerId"`, `"$$NOW"`) reads as a predefined
 *   name — distinct from a plain string, because mistaking one for the other
 *   is the classic pipeline bug.
 *
 * Token names are the ones every theme in `monaco-themes.ts` already styles
 * (`keyword`, `string`, `number`, `type`, `identifier`, `predefined`,
 * `delimiter`, `comment`), so a custom theme colours pipelines correctly
 * without knowing this language exists.
 *
 * The live suggestions never touch the network from inside the provider: they
 * read whatever `MongoCompletionEntry.getFields` already has cached
 * (`useSchema`, populated by `list_columns`/`infer_columns` exactly like the
 * schema tree) and, when a collection's fields aren't loaded yet, fire
 * `requestFields` once and return without them — the next keystroke picks
 * them up once the fetch lands. No parsing of the pipeline happens here
 * either: `completionPositionAt` (ADR #33's sibling) only tracks cursor
 * position, never the document's meaning.
 *
 * Two things make this behave like Compass rather than a flat word list:
 *
 * - **A stage operator is only offered at the stage body's own top-level
 *   key** (`cursor.path.length === 2` — the virtual root plus the one `{`
 *   the body itself opens). Typing `$` inside a nested value (say, a field
 *   reference inside `$match`) used to also dump all 28 stage names into the
 *   list, which is noise Compass never shows.
 * - **Picking a stage inserts its whole structure as a real Monaco snippet**
 *   (`StageSpec.insertSnippet`, tabstop syntax, `InsertAsSnippet`), not just
 *   the bare operator name — Tab walks `_id`, the accumulator, the field
 *   name, exactly like Compass's stage autocomplete. Likewise, an
 *   accumulator (`$sum`, `$avg`, …) picked while defining an output field
 *   inside `$group`/`$bucket`/`$bucketAuto`/`$setWindowFields` inserts the
 *   whole `{ $op: expr }` object (`ACCUMULATOR_CATALOG`) rather than the bare
 *   name — an accumulator is never valid unwrapped, so a bare insert always
 *   needed a second pass by hand.
 */

import type { Monaco } from "@monaco-editor/react";
import { STAGE_CATALOG } from "@/lib/mongo/stages";
import { ACCUMULATOR_CATALOG } from "@/lib/mongo/accumulators";
import { completionPositionAt, siblingStringValue } from "@/lib/mongo/completionContext";
import { BSON_CONSTRUCTORS } from "@/lib/mongo/shellCatalog";

export const MONGO_PIPELINE_LANGUAGE = "mongodb-pipeline";

/** Expression operators offered after `$` inside a stage body. Not exhaustive
 *  by design — the common ones, so the list stays scannable. The group
 *  accumulators (`$sum`, `$avg`, `$first`, …) are deliberately absent —
 *  they're never valid bare, so they live in `ACCUMULATOR_CATALOG` and get
 *  their own contextual, snippet-shaped branch below instead. */
export const EXPRESSION_OPERATORS = [
  "$abs", "$add", "$and", "$arrayElemAt", "$ceil",
  "$concat", "$concatArrays", "$cond", "$dateAdd", "$dateDiff",
  "$dateFromString", "$dateToString", "$dateTrunc", "$dayOfMonth", "$divide",
  "$eq", "$exists", "$expr", "$filter", "$floor", "$gt", "$gte",
  "$ifNull", "$in", "$inc", "$isArray", "$let", "$literal", "$lt",
  "$lte", "$map", "$month", "$multiply",
  "$ne", "$nin", "$not", "$or", "$reduce", "$regex", "$regexMatch",
  "$round", "$size", "$slice", "$split", "$strLenCP", "$subtract",
  "$switch", "$toDate", "$toDouble", "$toInt", "$toLong", "$toObjectId",
  "$toString", "$toUpper", "$toLower", "$trim", "$type", "$year",
];

/** BSON constructors the Rust parser accepts. The list itself lives in
 *  `shellCatalog.ts` alongside the rest of the shell grammar's mirror of
 *  `db/mongo/shell.rs`, so the pipeline editor and the query editor cannot
 *  drift apart. */
const CONSTRUCTORS = BSON_CONSTRUCTORS;

/** Live data one editor instance offers the shared completion provider. */
export interface MongoCompletionEntry {
  /** Every collection name in the current database — for `$lookup.from` and
   *  its siblings. */
  getCollections: () => string[];
  /** The pipeline's own source collection — the default field list for a
   *  bare `$` reference or a `$match`/`$project`-style key. */
  sourceCollection: () => string;
  /** Cached field names for `collection`, or `undefined` when they haven't
   *  been sampled yet (never an empty-but-loaded array's absence — that's
   *  `[]`). */
  getFields: (collection: string) => string[] | undefined;
  /** Ask for `collection`'s fields to be loaded. Fire-and-forget: the
   *  provider does not await it, so a miss just means this call's
   *  suggestions are missing them — the next keystroke has them once the
   *  fetch resolves. Callers are expected to dedupe repeat requests for a
   *  collection already loading. */
  requestFields: (collection: string) => void;
}

/** Per-model live data, keyed by `model.uri.toString()` — same shape as
 *  `monacoSql.ts`'s registry, and for the same reason (gotcha #9). */
const registry = new Map<string, MongoCompletionEntry>();

/** Register one editor's live data. Returns a disposer that unregisters it. */
export function registerMongoEditor(uri: string, entry: MongoCompletionEntry): () => void {
  registry.set(uri, entry);
  return () => {
    registry.delete(uri);
  };
}

let installed: Monaco | null = null;

/** Register the language, its grammar and its completions. Idempotent. */
export function ensureMongoLanguage(monaco: Monaco) {
  if (installed === monaco) return;
  installed = monaco;

  monaco.languages.register({ id: MONGO_PIPELINE_LANGUAGE });

  monaco.languages.setLanguageConfiguration(MONGO_PIPELINE_LANGUAGE, {
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

  monaco.languages.setMonarchTokensProvider(MONGO_PIPELINE_LANGUAGE, {
    defaultToken: "",
    constructors: CONSTRUCTORS,
    tokenizer: {
      root: [
        [/\/\/.*$/, "comment"],
        [/\/\*/, "comment", "@blockComment"],

        // A constructor call — the only "function" shape in the grammar.
        [
          /[A-Za-z_][\w$]*(?=\s*\()/,
          { cases: { "@constructors": "type", "@default": "identifier" } },
        ],

        // Keys. An operator key is a keyword; anything else is a field name.
        // Both forms (bare and quoted) are checked before the value rules, so
        // the trailing `:` decides key-vs-value rather than the quoting.
        [/\$[A-Za-z_][\w$]*(?=\s*:)/, "keyword"],
        [/"\$[^"\\]*"(?=\s*:)/, "keyword"],
        [/'\$[^'\\]*'(?=\s*:)/, "keyword"],
        [/[A-Za-z_][\w$]*(?=\s*:)/, "identifier"],
        [/"(?:[^"\\]|\\.)*"(?=\s*:)/, "identifier"],
        [/'(?:[^'\\]|\\.)*'(?=\s*:)/, "identifier"],

        // Values. A string that starts with `$` is a field path or a system
        // variable (`$$NOW`), not text — the distinction this grammar exists
        // for.
        [/"\$\$?(?:[^"\\]|\\.)*"/, "predefined"],
        [/'\$\$?(?:[^'\\]|\\.)*'/, "predefined"],
        [/"(?:[^"\\]|\\.)*"/, "string"],
        [/'(?:[^'\\]|\\.)*'/, "string"],

        [/\b(?:true|false|null|undefined)\b/, "keyword"],
        [/-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/, "number"],

        [/[{}[\]()]/, "delimiter"],
        [/[,:]/, "delimiter"],
      ],
      blockComment: [
        [/[^/*]+/, "comment"],
        [/\*\//, "comment", "@pop"],
        [/[/*]/, "comment"],
      ],
    },
  });

  monaco.languages.registerCompletionItemProvider(MONGO_PIPELINE_LANGUAGE, {
    // `$` opens the list without waiting for a word character, which is how a
    // pipeline is actually typed. `"` does the same for the collection/field
    // suggestions below, which are typed inside string literals — Monaco's
    // default `quickSuggestions` doesn't fire inside strings, so without this
    // the menu would only ever appear on an explicit Ctrl+Space there.
    triggerCharacters: ["$", '"'],
    provideCompletionItems: (model, position, context) => {
      const word = model.getWordUntilPosition(position);
      const line = model.getValueInRange({
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: 1,
        endColumn: position.column,
      });
      // Monaco's word boundary stops at `$`, so a suggestion inserted at
      // `word.startColumn` would leave the `$` the user already typed in front
      // of it. Extend the replaced range back over it when it's there.
      const hasDollar = line.endsWith(`$${word.word}`);
      const dollarRange = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn - (hasDollar ? 1 : 0),
        endColumn: word.endColumn,
      };
      // For a bare suggestion (a collection or field name with no leading
      // `$`), only the word itself is replaced.
      const plainRange = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const suggestions: any[] = [];

      // `getModel()`'s value is the live buffer including everything after
      // the cursor; `completionPositionAt` only looks at the slice up to
      // `offset`, so what's typed later can never affect this result. Needed
      // below regardless of whether a live `entry` is registered — the
      // stage/accumulator gating is static, schema-agnostic context.
      const text = model.getValue();
      const offset = model.getOffsetAt(position);
      const cursor = completionPositionAt(text, offset);
      const innermost = cursor.path[cursor.path.length - 1];

      // The frame directly enclosing `innermost` — used both to recognise a
      // nested sub-pipeline's stage doc and to tell a $group/$bucket/…
      // accumulator slot from an unrelated nested object.
      const parentFrame = cursor.path[cursor.path.length - 2];

      const dollarContext = hasDollar || context.triggerCharacter === "$";
      if (dollarContext) {
        // A stage operator only makes sense at the stage body's own
        // top-level key — `path.length === 2` is [virtual root, the body's
        // own `{`] — or at the root of a *nested* pipeline's stage doc
        // ($lookup's `pipeline`, $facet's branches, $unionWith's `pipeline`:
        // in every case an array element that is itself an object is a fresh
        // stage). One level deeper than that (inside $match's filter,
        // $group's accumulator, …) it would just be noise alongside the
        // field/expression suggestions that actually apply there.
        const atNestedPipelineStage =
          innermost.type === "object" && parentFrame?.type === "array";
        if (cursor.path.length === 2 || atNestedPipelineStage) {
          suggestions.push(
            ...STAGE_CATALOG.map((stage, i) => ({
              label: stage.operator,
              kind: monaco.languages.CompletionItemKind.Snippet,
              // The whole stage structure, as a real snippet — Tab walks
              // `_id`, the accumulator, the field name, same as Compass.
              insertText: stage.insertSnippet,
              insertTextRules:
                monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              detail: "stage",
              documentation: { value: "```js\n" + stage.snippet + "\n```" },
              sortText: `0${String(i).padStart(3, "0")}`,
              range: dollarRange,
            })),
          );
        }

        // An accumulator is never valid bare (`count: $sum: 1` isn't legal —
        // only `count: { $sum: 1 }` is), so it needs one of two different
        // insertions depending on whether the wrapping object already
        // exists at the cursor:
        //  - bare slot   `count: $su|`   → the whole `{ $op: expr }`, built
        //    here by wrapping `ACCUMULATOR_CATALOG`'s bare fragment.
        //  - braced slot `count: { $su|` → the braces are already there —
        //    either hand-typed, or, the common case, the accumulator
        //    tabstop a $group/$bucket/… stage snippet itself seeded — so
        //    only the bare fragment goes in.
        // Offered only while defining an output field's value inside
        // $group, or the `output: { … }` object $bucket/$bucketAuto/
        // $setWindowFields wrap theirs in — never for $group's own `_id`
        // (an expression, not a reduction).
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
          suggestions.push(
            ...ACCUMULATOR_CATALOG.map((acc, i) => ({
              label: acc.operator,
              kind: monaco.languages.CompletionItemKind.Function,
              insertText: bracedAccumulatorSlot
                ? acc.insertSnippet
                : `{ ${acc.insertSnippet} }`,
              insertTextRules:
                monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              detail: "accumulator",
              sortText: `0${String(i).padStart(2, "0")}`,
              range: dollarRange,
            })),
          );
        }

        // An expression operator is always an object *key* ($concat, $cond,
        // … only ever appear as `{ $op: … }`) — never a bare value. Offering
        // the whole 50-odd-entry list at a plain field-reference slot like
        // $group's `_id: "$|"` buried the one thing that actually belongs
        // there (a real field name) under operator noise. `slot === "key"`
        // covers both the stage's own top level (before `atNestedPipelineStage`
        // narrows it further above) and a freshly-opened nested expression
        // object ($project's `total: { $|`); `slot === "value"` is exactly
        // the field-reference position this must stay out of.
        if (cursor.slot !== "value") {
          suggestions.push(
            ...EXPRESSION_OPERATORS.map((op) => ({
              label: op,
              kind: monaco.languages.CompletionItemKind.Function,
              insertText: `${op}: `,
              detail: "expression",
              sortText: `1${op}`,
              range: dollarRange,
            })),
          );
        }
        // A BSON constructor call, unlike an operator, *is* a legitimate bare
        // value (`_id: ObjectId("…")`), so it stays available regardless of
        // slot.
        suggestions.push(
          ...CONSTRUCTORS.map((name) => ({
            label: name,
            kind: monaco.languages.CompletionItemKind.Constructor,
            insertText: `${name}("$1")`,
            insertTextRules:
              monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            detail: "BSON",
            sortText: `2${name}`,
            range: dollarRange,
          })),
        );
      }

      const entry = registry.get(model.uri.toString());
      if (entry) {
        const insideLookup = innermost.key === "$lookup";

        const pushFields = (
          collection: string,
          range: typeof plainRange,
          prefix: string,
        ) => {
          const fields = entry.getFields(collection);
          if (fields === undefined) {
            entry.requestFields(collection);
            return;
          }
          suggestions.push(
            ...fields.map((f) => ({
              // Monaco filters each item by comparing its own label against
              // whatever text `range` currently spans — for the `"$"`-prefix
              // call (a bare field-reference value, e.g. $group's own `_id:
              // "$|"`) that span already includes the `$` the user typed, so
              // a bare `label: f` silently failed to match ("$en" fuzzy-match
              // "entity"? no) and Monaco discarded the item before it ever
              // reached the widget — even though `insertText` was already
              // correct. The label has to carry the same prefix as the text
              // being replaced.
              label: `${prefix}${f}`,
              kind: monaco.languages.CompletionItemKind.Field,
              insertText: `${prefix}${f}`,
              detail: "field",
              sortText: `0_${f}`,
              range,
            })),
          );
        };

        if (cursor.slot === "value" && insideLookup && cursor.forKey === "from") {
          suggestions.push(
            ...entry.getCollections().map((name) => ({
              label: name,
              kind: monaco.languages.CompletionItemKind.Class,
              insertText: name,
              detail: "collection",
              sortText: `0_${name}`,
              range: plainRange,
            })),
          );
        } else if (
          cursor.slot === "value" &&
          insideLookup &&
          cursor.forKey === "localField"
        ) {
          pushFields(entry.sourceCollection(), plainRange, "");
        } else if (
          cursor.slot === "value" &&
          insideLookup &&
          cursor.forKey === "foreignField"
        ) {
          const fromValue = siblingStringValue(text, innermost, "from");
          if (fromValue) pushFields(fromValue, plainRange, "");
        } else if (dollarContext) {
          pushFields(entry.sourceCollection(), dollarRange, "$");
        } else if (cursor.slot === "key" && !insideLookup) {
          pushFields(entry.sourceCollection(), plainRange, "");
        }
      }

      return { suggestions };
    },
  });
}
