import { describe, expect, it } from "vitest";
import { runTarget, type EditorSnapshot } from "./runTarget";

const BUF = "SELECT 1;\n\nSELECT 2;\nSELECT 3";
const at = (
  line: number,
  selection: string | null = null,
  startLine = 1,
): EditorSnapshot => ({
  source: BUF,
  selection: selection === null ? null : { text: selection, startLine },
  line,
  dialect: "sql",
});
const text = (snap: EditorSnapshot, scope: Parameters<typeof runTarget>[1]) =>
  runTarget(snap, scope)?.text ?? null;

describe("runTarget", () => {
  it("cursor: the statement under the caret when nothing is selected", () => {
    expect(text(at(1), "cursor")).toBe("SELECT 1;");
    expect(text(at(3), "cursor")).toBe("SELECT 2;");
  });

  it("cursor: the selection wins over the statement", () => {
    expect(text(at(1, "SELECT 2;\nSELECT 3"), "cursor")).toBe("SELECT 2;\nSELECT 3");
  });

  it("cursor: a blank selection counts as none", () => {
    expect(text(at(4, "   "), "cursor")).toBe("SELECT 3");
  });

  it("cursor: past the last statement is still in it", () => {
    // The trailing statement keeps its trailing whitespace; the run trims.
    expect(text({ ...at(9), source: "SELECT 1\n\n" }, "cursor")?.trim()).toBe("SELECT 1");
  });

  it("cursor: a caret between two statements names nothing", () => {
    expect(runTarget(at(2), "cursor")).toBeNull();
  });

  it("selection and statement are each only themselves", () => {
    expect(runTarget(at(1), "selection")).toBeNull();
    expect(text(at(1, "SELECT 9"), "selection")).toBe("SELECT 9");
    expect(text(at(1, "SELECT 9"), "statement")).toBe("SELECT 1;");
  });

  it("all: the whole buffer, or nothing when it is blank", () => {
    expect(text(at(1), "all")).toBe(BUF);
    expect(runTarget({ ...at(1), source: " \n " }, "all")).toBeNull();
  });

  it("says which editor line the text starts on", () => {
    expect(runTarget(at(3), "cursor")?.firstLine).toBe(3);
    expect(runTarget(at(1, "SELECT 2;", 3), "cursor")?.firstLine).toBe(3);
    expect(runTarget(at(4), "all")?.firstLine).toBe(1);
  });

  it("follows the dialect: a MongoDB line break ends a statement", () => {
    const snap: EditorSnapshot = {
      source: "db.a.find({})\ndb.b.find({})",
      selection: null,
      line: 2,
      dialect: "mongo",
    };
    expect(runTarget(snap, "cursor")).toEqual({ text: "db.b.find({})", firstLine: 2 });
  });
});
