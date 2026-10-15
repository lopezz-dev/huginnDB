import { describe, expect, it, vi } from "vitest";
import {
  ensureMongoQueryProviders,
  registerMongoQueryEditor,
  type MongoQueryEntry,
} from "./monacoMongoQuery";

/**
 * End-to-end characterization of the query tab's Mongo completion provider,
 * against the same hand-rolled Monaco stand-in `monacoMongo.test.ts` uses —
 * `shellContext.test.ts` already pins the cursor scanner in isolation, and the
 * bug this provider exists to fix ("type `db`, get an empty widget") lived in
 * the *wiring*, not in any scanner.
 *
 * The mock implements only what the provider calls: word boundary, one line of
 * text, the whole buffer, and an offset↔position conversion, all derived from
 * a single flat string exactly as a real model would answer.
 */

interface Position {
  lineNumber: number;
  column: number;
}

const linesOf = (text: string) => text.split("\n");

function positionAt(text: string, offset: number): Position {
  const lines = linesOf(text.slice(0, offset));
  return { lineNumber: lines.length, column: lines[lines.length - 1].length + 1 };
}

function offsetAt(text: string, position: Position): number {
  const lines = linesOf(text);
  let offset = 0;
  for (let i = 0; i < position.lineNumber - 1; i++) offset += lines[i].length + 1;
  return offset + position.column - 1;
}

/** Monaco's default word pattern: `$` is a separator, which is exactly the
 *  boundary the provider's `hasDollar` compensation relies on. */
function wordUntilPosition(text: string, position: Position) {
  const line = linesOf(text)[position.lineNumber - 1];
  const col = position.column - 1;
  let start = col;
  while (start > 0 && /[A-Za-z0-9_]/.test(line[start - 1])) start -= 1;
  return { word: line.slice(start, col), startColumn: start + 1, endColumn: col + 1 };
}

function mockModel(text: string, uri = "test://mongo-query") {
  return {
    getWordUntilPosition: (position: Position) => wordUntilPosition(text, position),
    getValueInRange: (range: {
      startLineNumber: number;
      startColumn: number;
      endColumn: number;
    }) =>
      linesOf(text)[range.startLineNumber - 1].slice(
        range.startColumn - 1,
        range.endColumn - 1,
      ),
    getValue: () => text,
    getOffsetAt: (position: Position) => offsetAt(text, position),
    uri: { toString: () => uri },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mockMonaco(): { monaco: any; getProvider: () => any; lensLanguages: string[] } {
  let provider: unknown;
  const lensLanguages: string[] = [];
  const monaco = {
    Emitter: class {
      event = () => ({ dispose: () => {} });
      fire() {}
    },
    editor: { registerCommand: () => {} },
    languages: {
      register: () => {},
      setLanguageConfiguration: () => {},
      setMonarchTokensProvider: () => {},
      registerCompletionItemProvider: (_id: string, p: unknown) => {
        provider = p;
      },
      registerCodeLensProvider: (id: string) => {
        lensLanguages.push(id);
      },
      CompletionItemKind: {
        Snippet: 1,
        Function: 2,
        Constructor: 3,
        Field: 4,
        Class: 5,
        Method: 6,
        Variable: 7,
      },
      CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
    },
  };
  return { monaco, getProvider: () => provider, lensLanguages };
}

const FIELDS: Record<string, string[]> = {
  users: ["_id", "email", "createdAt"],
  orders: ["_id", "total"],
};

const requested: string[] = [];

const entry: MongoQueryEntry = {
  getCollections: () => ["users", "orders", "logs", "logs.2024"],
  getFields: (c) => FIELDS[c],
  requestFields: (c) => {
    requested.push(c);
  },
};

const { monaco, getProvider, lensLanguages } = mockMonaco();
ensureMongoQueryProviders(monaco);
registerMongoQueryEditor("test://mongo-query", entry);

/** Complete at the `|` in `source`, returning the suggestion labels. */
function complete(source: string, triggerCharacter?: string): string[] {
  const offset = source.indexOf("|");
  const text = source.replace("|", "");
  const model = mockModel(text);
  const result = getProvider().provideCompletionItems(
    model,
    positionAt(text, offset < 0 ? text.length : offset),
    { triggerCharacter },
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return result.suggestions.map((s: any) => s.label);
}

/** The whole suggestion objects, for the cases where the insertion matters. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function completeItems(source: string, triggerCharacter?: string): any[] {
  const offset = source.indexOf("|");
  const text = source.replace("|", "");
  return getProvider().provideCompletionItems(
    mockModel(text),
    positionAt(text, offset < 0 ? text.length : offset),
    { triggerCharacter },
  ).suggestions;
}

describe("the run lens", () => {
  it("is registered for the Mongo query language, not only for sql", () => {
    expect(lensLanguages).toContain("mongodb-query");
  });
});

describe("the chain", () => {
  it("answers a bare `db` instead of an empty widget", () => {
    // The reported symptom, pinned: typing `db` used to fuzzy-match ~70 SQL
    // keywords, hit none, and show nothing at all.
    expect(complete("db|")).toContain("db");
  });

  it("offers collections after `db.`", () => {
    expect(complete("db.|", ".")).toEqual(
      expect.arrayContaining(["users", "orders", "logs"]),
    );
  });

  it("offers only the remainder of a dotted collection name", () => {
    const labels = complete("db.logs.|", ".");
    expect(labels).toContain("2024");
    expect(labels).not.toContain("logs.2024");
  });

  it("offers methods after a collection, as runnable snippets", () => {
    const items = completeItems("db.users.|", ".");
    const find = items.find((s) => s.label === "find");
    expect(find.insertText).toBe("find({$1})");
    expect(items.map((s) => s.label)).toEqual(
      expect.arrayContaining(["findOne", "aggregate", "updateOne", "drop"]),
    );
  });

  it("marks a write method as one", () => {
    const items = completeItems("db.users.|", ".");
    expect(items.find((s) => s.label === "deleteMany").detail).toContain("write");
  });

  it("offers exactly the four cursor modifiers after a closed call", () => {
    expect(complete("db.users.find({}).|", ".").sort()).toEqual(
      ["limit", "project", "projection", "skip", "sort"].sort(),
    );
  });
});

describe("arguments", () => {
  it("offers field names inside a filter", () => {
    expect(complete("db.users.find({ |})")).toEqual(
      expect.arrayContaining(["email", "createdAt"]),
    );
  });

  it("offers query operators after a `$`", () => {
    const labels = complete("db.users.find({ age: { $|} })", "$");
    expect(labels).toEqual(expect.arrayContaining(["$gt", "$in", "$exists"]));
  });

  it("carries the `$` in the label, or Monaco filters the item away", () => {
    const items = completeItems("db.users.find({ age: { $g|} })");
    const gt = items.find((s) => s.label === "$gt");
    expect(gt.label.startsWith("$")).toBe(true);
    // The replaced span reaches back over the `$` the user already typed.
    expect(gt.range.endColumn - gt.range.startColumn).toBe(2);
  });

  it("adds update operators only for the methods that take an update document", () => {
    expect(complete("db.users.updateOne({}, { $|})", "$")).toContain("$set");
    expect(complete("db.users.find({ a: { $|} })", "$")).not.toContain("$set");
  });

  it("keeps operators out of a sort spec", () => {
    expect(complete("db.users.find({}).sort({ $|})", "$")).not.toContain("$gt");
  });

  it("offers aggregation stages inside `aggregate([{ … }])`", () => {
    expect(complete("db.users.aggregate([{ $|}])", "$")).toEqual(
      expect.arrayContaining(["$match", "$group", "$project"]),
    );
  });

  it("does not offer stages inside a plain find filter", () => {
    expect(complete("db.users.find({ $|})", "$")).not.toContain("$match");
  });

  it("offers BSON constructors as bare values", () => {
    expect(complete("db.users.find({ _id: Obj| })")).toContain("ObjectId");
  });

  it("offers field names inside distinct's string argument", () => {
    expect(complete('db.users.distinct("em|')).toContain("email");
  });

  it("requests a collection's fields once when they are not cached", () => {
    requested.length = 0;
    complete("db.logs.find({ |})");
    complete("db.logs.find({ x|})");
    expect(requested).toEqual(["logs", "logs"]);
    // Two calls, because deduping is the *caller's* job (ADR #57) — the
    // provider cannot await and must stay synchronous.
  });
});

describe("dead positions", () => {
  it("suggests nothing inside a comment", () => {
    expect(complete("// db.users.|")).toEqual([]);
  });

  it("suggests nothing when no editor is registered for the model", () => {
    const text = "db.";
    const result = getProvider().provideCompletionItems(
      mockModel(text, "test://unregistered"),
      positionAt(text, text.length),
      {},
    );
    expect(result.suggestions).toEqual([]);
  });
});

describe("registration", () => {
  it("unregisters the model's entry on dispose", () => {
    const dispose = registerMongoQueryEditor("test://temp", {
      getCollections: () => ["temp"],
      getFields: () => undefined,
      requestFields: vi.fn(),
    });
    const text = "db.";
    const read = () =>
      getProvider().provideCompletionItems(
        mockModel(text, "test://temp"),
        positionAt(text, text.length),
        { triggerCharacter: "." },
      ).suggestions.length;
    expect(read()).toBe(1);
    dispose();
    expect(read()).toBe(0);
  });
});
