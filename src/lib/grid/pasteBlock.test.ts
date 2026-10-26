import { describe, expect, it } from "vitest";
import { isBlockText, parsePasteBlock } from "./pasteBlock";

describe("isBlockText", () => {
  it("keeps one value — even with the line break a spreadsheet appends — a single cell", () => {
    expect(isBlockText("hello")).toBe(false);
    expect(isBlockText("hello\n")).toBe(false);
    expect(isBlockText("hello\r\n")).toBe(false);
  });

  it("calls tabs or several lines a block", () => {
    expect(isBlockText("a\tb")).toBe(true);
    expect(isBlockText("a\nb")).toBe(true);
    expect(isBlockText("a\r\nb\r\n")).toBe(true);
  });
});

describe("parsePasteBlock", () => {
  it("reads rows and cells, dropping the trailing line break", () => {
    expect(parsePasteBlock("a\tb\nc\td\n")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
    expect(parsePasteBlock("a\tb\r\nc\td\r\n")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("keeps empty cells, at the edges too", () => {
    expect(parsePasteBlock("\tb\t\n\t\t")).toEqual([
      ["", "b", ""],
      ["", "", ""],
    ]);
  });

  it("unquotes a cell holding a tab, a line break or a quote", () => {
    expect(parsePasteBlock('"line 1\nline 2"\tx\n"say ""hi"""\t"a\tb"')).toEqual([
      ["line 1\nline 2", "x"],
      ['say "hi"', "a\tb"],
    ]);
  });

  it("reads a quote that does not wrap the whole cell literally", () => {
    expect(parsePasteBlock('"5" screen\tok')).toEqual([['"5" screen', "ok"]]);
    expect(parsePasteBlock('12" pipe\tok')).toEqual([['12" pipe', "ok"]]);
  });
});
