import { describe, expect, it } from "vitest";

import {
  BSON_TYPES,
  defaultText,
  displayValue,
  draftTypeFor,
  LIST_TEXT_CAP,
  flattenDocument,
  isOpaqueType,
  isValidForType,
  nextArrayIndex,
  pathKey,
  typeLabel,
  typeTextFor,
  typeValue,
  type DocField,
} from "./documentTree";

describe("draftTypeFor", () => {
  it("renames BSON's `document` to the picker's `object`", () => {
    expect(draftTypeFor("document")).toBe("object");
  });

  it("passes other types through and defaults an untyped field to string", () => {
    expect(draftTypeFor("long")).toBe("long");
    expect(draftTypeFor(undefined)).toBe("string");
    expect(draftTypeFor("")).toBe("string");
  });
});

describe("typeValue", () => {
  it("keeps a type the picker can write", () => {
    for (const t of BSON_TYPES) expect(typeValue(t)).toBe(t);
  });

  // A type the picker cannot write still needs a valid trigger value; its own
  // label is shown separately. These are the same types that refuse inline
  // editing, because committing their display text would store that text.
  it("maps an unwritable type onto string", () => {
    expect(typeValue("dbPointer")).toBe("string");
    expect(typeValue("mixed")).toBe("string");
    expect(isOpaqueType("dbPointer")).toBe(true);
  });
});

describe("defaultText", () => {
  // Retyping to something incompatible must leave a value that parses, or the
  // next commit fails on an empty numeric field.
  it("gives every scalar type a parseable neutral value", () => {
    for (const t of ["int", "long", "double", "decimal128"] as const) {
      expect(defaultText(t)).toBe("0");
      expect(isValidForType(t, defaultText(t))).toBe(true);
    }
    expect(defaultText("bool")).toBe("false");
    expect(defaultText("object")).toBe("{}");
    expect(defaultText("array")).toBe("[]");
    expect(defaultText("string")).toBe("");
  });

  it("gives a date a parseable instant", () => {
    expect(Number.isNaN(Date.parse(defaultText("date")))).toBe(false);
  });
});

describe("nextArrayIndex", () => {
  const field = (path: string[], childCount?: number): DocField =>
    ({ path, childCount }) as DocField;

  // Read from the container's own childCount, not by counting rendered rows: a
  // collapsed array contributes none, and appending must not land on 0 and
  // overwrite the first element.
  it("appends after the container's existing children", () => {
    const fields = [field(["tags"], 3), field(["tags", "0"])];
    expect(nextArrayIndex(fields, ["tags"])).toBe(3);
  });

  it("is 0 for an unknown or empty container", () => {
    expect(nextArrayIndex([], ["tags"])).toBe(0);
    expect(nextArrayIndex([field(["tags"], 0)], ["tags"])).toBe(0);
  });

  it("matches on the whole path, not the leaf name", () => {
    const fields = [field(["a", "tags"], 2), field(["b", "tags"], 5)];
    expect(nextArrayIndex(fields, ["b", "tags"])).toBe(5);
  });
});

describe("flattenDocument", () => {
  // Characterization for the collapsed-container fix: reading `childCount`
  // must not require walking (or allocating a tuple per element for) the
  // container's children — a collapsed 10,000-element array is the case
  // that used to pay for exactly that on every render of the memo this
  // feeds (DocumentCard).
  it("does not walk a collapsed container's children, only counts them", () => {
    const bigArray = Array.from({ length: 10_000 }, (_, i) => i);
    const out = flattenDocument([{ name: "items" }], [bigArray], undefined, () => false);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      path: ["items"],
      container: "array",
      childCount: 10_000,
      expanded: false,
    });
  });

  it("walks an expanded array's children, keyed by String(index) for $set/$unset", () => {
    const out = flattenDocument([{ name: "items" }], [["a", "b", "c"]], undefined, (key) => key === "items");
    expect(out.map((f) => f.path)).toEqual([["items"], ["items", "0"], ["items", "1"], ["items", "2"]]);
    expect(out[0].childCount).toBe(3);
    expect(out.slice(1).every((f) => f.inArray)).toBe(true);
  });

  it("walks an expanded object's children in key insertion order", () => {
    const out = flattenDocument([{ name: "doc" }], [{ b: 1, a: 2 }], undefined, (key) => key === "doc");
    expect(out.map((f) => f.key)).toEqual(["doc", "b", "a"]);
    expect(out[0].childCount).toBe(2);
    expect(out.slice(1).every((f) => f.inArray)).toBe(false);
  });
});

describe("typeTextFor", () => {
  const field = (overrides: Partial<DocField>): DocField =>
    ({
      path: ["name"],
      key: "name",
      value: "x",
      type: "string",
      depth: 0,
      container: null,
      childCount: 0,
      expanded: false,
      inArray: false,
      editable: true,
      ...overrides,
    }) as DocField;

  it("shows a top-level SQL field's real catalog type", () => {
    const byName = new Map([["name", "varchar(255)"]]);
    expect(typeTextFor(field({}), false, byName)).toBe("varchar(255)");
  });

  it("falls back to the BSON-style label when the column isn't in the map", () => {
    expect(typeTextFor(field({}), false, new Map())).toBe(typeLabel("string"));
  });

  it("always shows the BSON-style label for a nested field, even in SQL mode", () => {
    const byName = new Map([["name", "varchar(255)"]]);
    expect(typeTextFor(field({ path: ["data", "name"], depth: 1 }), false, byName)).toBe(typeLabel("string"));
  });

  it("always shows the BSON-style label in document mode, even at depth 0", () => {
    const byName = new Map([["name", "varchar(255)"]]);
    expect(typeTextFor(field({}), true, byName)).toBe(typeLabel("string"));
  });
});

describe("pathKey", () => {
  // A field is addressed by its dotted path so `$set`/`$unset` take it as-is.
  it("joins with dots", () => {
    expect(pathKey(["customData", "format"])).toBe("customData.format");
    expect(pathKey(["tags", "2"])).toBe("tags.2");
  });
});

describe("displayValue", () => {
  const field = (value: string, type = "string") =>
    ({ value, type, container: null, childCount: 0 }) as unknown as DocField;

  it("quotes a string whole when it fits", () => {
    expect(displayValue(field("hello"), "NULL")).toBe('"hello"');
  });

  it("puts at most the cap of a huge string in the row", () => {
    // A 1.5 MB prompt used to reach the DOM whole, to be laid out and clipped.
    const text = displayValue(field("p".repeat(1_500_000)), "NULL");
    expect(text).toBe(`"${"p".repeat(LIST_TEXT_CAP)}…"`);
  });
});
