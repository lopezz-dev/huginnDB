import { describe, expect, it } from "vitest";
import { runTarget, type EditorSnapshot } from "./runTarget";

const BUF = "SELECT 1;\n\nSELECT 2;\nSELECT 3";
const at = (line: number, selection: string | null = null): EditorSnapshot => ({
  source: BUF,
  selection,
  line,
  dialect: "sql",
});

describe("runTarget", () => {
  it("cursor: the statement under the caret when nothing is selected", () => {
    expect(runTarget(at(1), "cursor")).toBe("SELECT 1;");
    expect(runTarget(at(3), "cursor")).toBe("SELECT 2;");
  });

  it("cursor: the selection wins over the statement", () => {
    expect(runTarget(at(1, "SELECT 2;\nSELECT 3"), "cursor")).toBe(
      "SELECT 2;\nSELECT 3",
    );
  });

  it("cursor: a blank selection counts as none", () => {
    expect(runTarget(at(4, "   "), "cursor")).toBe("SELECT 3");
  });

  it("cursor: past the last statement is still in it", () => {
    // The trailing statement keeps its trailing whitespace; the run trims.
    expect(runTarget({ ...at(9), source: "SELECT 1\n\n" }, "cursor")?.trim()).toBe(
      "SELECT 1",
    );
  });

  it("cursor: a caret between two statements names nothing", () => {
    expect(runTarget(at(2), "cursor")).toBeNull();
  });

  it("selection and statement are each only themselves", () => {
    expect(runTarget(at(1), "selection")).toBeNull();
    expect(runTarget(at(1, "SELECT 9"), "selection")).toBe("SELECT 9");
    expect(runTarget(at(1, "SELECT 9"), "statement")).toBe("SELECT 1;");
  });

  it("all: the whole buffer, or nothing when it is blank", () => {
    expect(runTarget(at(1), "all")).toBe(BUF);
    expect(runTarget({ ...at(1), source: " \n " }, "all")).toBeNull();
  });

  it("follows the dialect: a MongoDB line break ends a statement", () => {
    const snap: EditorSnapshot = {
      source: "db.a.find({})\ndb.b.find({})",
      selection: null,
      line: 2,
      dialect: "mongo",
    };
    expect(runTarget(snap, "cursor")).toBe("db.b.find({})");
  });
});
