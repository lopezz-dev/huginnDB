/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hasActiveGrid,
  noteGridFocus,
  registerGridSizing,
  runGridSizing,
  type GridSizingGesture,
} from "./gridSizing";

/** jsdom lays nothing out, so `getClientRects` is always empty there — stub
 *  it per element to say which grids are on screen. */
function grid(visible: boolean) {
  const root = document.createElement("div");
  const cell = document.createElement("button");
  root.appendChild(cell);
  document.body.appendChild(root);
  root.getClientRects = () =>
    (visible ? [{}] : []) as unknown as DOMRectList;
  const calls: GridSizingGesture[] = [];
  const unregister = registerGridSizing(root, (g) => {
    calls.push(g);
    return true;
  });
  cleanups.push(unregister);
  return { root, cell, calls, unregister };
}

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
  document.body.innerHTML = "";
});

describe("runGridSizing", () => {
  it("declines when no grid is registered", () => {
    expect(hasActiveGrid()).toBe(false);
    expect(runGridSizing("fitContent")).toBe(false);
  });

  it("answers with the grid that holds the focus, visible or not", () => {
    const a = grid(true);
    const b = grid(false);
    noteGridFocus(a.root);
    b.cell.focus();
    expect(runGridSizing("fitWidth")).toBe(true);
    expect(b.calls).toEqual(["fitWidth"]);
    expect(a.calls).toEqual([]);
  });

  it("falls back to the visible grid touched last (the palette's case)", () => {
    const a = grid(true);
    const b = grid(true);
    noteGridFocus(b.root);
    noteGridFocus(a.root);
    expect(runGridSizing("fitContent")).toBe(true);
    expect(a.calls).toEqual(["fitContent"]);
    expect(b.calls).toEqual([]);
  });

  it("skips a grid touched last that is no longer on screen", () => {
    const a = grid(true);
    const hidden = grid(false);
    noteGridFocus(a.root);
    noteGridFocus(hidden.root);
    runGridSizing("fitContent");
    expect(a.calls).toEqual(["fitContent"]);
    expect(hidden.calls).toEqual([]);
  });

  it("uses the only visible grid even if nobody touched it", () => {
    const a = grid(true);
    grid(false);
    expect(runGridSizing("fitWidth")).toBe(true);
    expect(a.calls).toEqual(["fitWidth"]);
  });

  it("refuses to guess between two untouched visible grids", () => {
    grid(true);
    grid(true);
    expect(hasActiveGrid()).toBe(false);
    expect(runGridSizing("fitWidth")).toBe(false);
  });

  it("forgets a grid once it unregisters", () => {
    const a = grid(true);
    a.unregister();
    expect(runGridSizing("fitContent")).toBe(false);
  });

  it("passes the grid's own decline through", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    root.getClientRects = () => [{}] as unknown as DOMRectList;
    const run = vi.fn(() => false);
    cleanups.push(registerGridSizing(root, run));
    expect(runGridSizing("fitContent")).toBe(false);
    expect(run).toHaveBeenCalledWith("fitContent");
  });
});
