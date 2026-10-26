/**
 * @vitest-environment jsdom
 *
 * Regression test for `DocumentCard`'s `memo()` actually bailing out.
 * `DataGrid` passes `onExpandField` as an inline arrow (a fresh function
 * identity on every one of its own renders) and `onFieldSave`/
 * `onFieldDelete`/`onDeleteRow` as plain function declarations from
 * `TableDataTab` — all four used to be read as ordinary props by
 * `DocumentCard`, which defeated its `memo()` on every render regardless of
 * whether that row's own data had changed. `DocumentListView` now mirrors
 * them through a ref (`callbacksRef`) and passes `DocumentCard` only
 * booleans, `rowValues`/`columns`/`types`, and the ref itself — all stable
 * across a re-render that doesn't touch this row.
 *
 * `t("dataGrid.fieldsCount", …)` is the probe: it's called directly in
 * `DocumentCard`'s own render body (never inside `flattenDocument`, which is
 * shielded by its own `useMemo` regardless of the outer `memo()` — spying on
 * that would pass even with the bug present — and never inside `FieldRow`,
 * which no longer takes `t` at all). So a second call to it after a
 * `DocumentListView` re-render is proof `DocumentCard`'s function body ran
 * again, i.e. that the memo did NOT bail out.
 */
import { StrictMode, useRef } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import i18n from "i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "@/lib/i18n";
import { DocumentListView } from "./DocumentListView";
import type { CellValue, ColumnFilter, ColumnMeta, SortSpec } from "@/types";

// Module-level so both renders in a test see the exact same array
// references — a fresh `[]` per render would (correctly) invalidate the
// memo for an unrelated reason and defeat the point of the test.
const columns: ColumnMeta[] = [{ name: "name", data_type: "text" }];
const rows: CellValue[][] = [["alice"]];

/** A page-sized batch, for the windowing test below. */
const manyRows: CellValue[][] = Array.from({ length: 500 }, (_, i) => [
  `row-${i}`,
]);

function Harness({
  onExpandField,
  rows: rowsProp = rows,
}: {
  onExpandField: () => void;
  rows?: CellValue[][];
}) {
  // The list windows its cards against this element. jsdom reports a zero-size
  // rect for it, which is enough: the virtualizer still renders the first index
  // plus its overscan, and one card is all this test needs.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  return (
    <div ref={scrollRef} style={{ overflow: "auto", height: 400 }}>
      <DocumentListView
        scrollRef={scrollRef}
        columns={columns}
        rows={rowsProp}
        nullDisplay="NULL"
        zebraStripes={false}
        expandNested={false}
        showTypes={false}
        lineNumbers={false}
        onExpandField={onExpandField}
        copyToClipboard={() => {}}
        emptyLabel="empty"
      />
    </div>
  );
}

// `vi.spyOn(i18n, "t")` doesn't typecheck cleanly against i18next's heavily
// overloaded `t` signature, so this wraps it by hand — the same effect
// without fighting the type constraint.
type AnyFn = (...args: unknown[]) => unknown;
let calls: unknown[][] = [];
let originalT: typeof i18n.t;

/**
 * jsdom has no layout, so the list's virtualizer measures its scroll container
 * as 0-high and windows nothing — the probe below would read zero and this test
 * would "pass" its memo assertion while proving nothing.
 *
 * It has to be these properties specifically, not `getBoundingClientRect`:
 * `virtual-core` sizes the scroll container from `clientHeight`/`clientWidth`
 * (since 3.19; `offsetHeight`/`offsetWidth` before) and measures each item
 * from `offsetHeight`/`offsetWidth`, so stubbing the rect (the obvious move)
 * changes nothing at all. Both pairs are stubbed. The shims live here rather
 * than as an `initialRect` escape hatch in the component, which would be
 * production code existing for jsdom's benefit.
 */
function stubSize(
  prop: "offsetHeight" | "offsetWidth" | "clientHeight" | "clientWidth",
  value: number,
) {
  Object.defineProperty(HTMLElement.prototype, prop, {
    configurable: true,
    get: () => value,
  });
}

/**
 * The other half of the same gap: the virtualizer watches its scroll element
 * with a `ResizeObserver`, which jsdom does not implement, so without this it
 * never learns the element has a size and windows nothing however big the rect
 * says it is. A no-op observer is enough — the rect stub above supplies the
 * measurement this would otherwise deliver.
 */
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??=
    NoopResizeObserver;
  stubSize("offsetHeight", 400);
  stubSize("offsetWidth", 600);
  stubSize("clientHeight", 400);
  stubSize("clientWidth", 600);
  calls = [];
  originalT = i18n.t.bind(i18n);
  i18n.t = ((...args: unknown[]) => {
    calls.push(args);
    return (originalT as unknown as AnyFn)(...args);
  }) as unknown as typeof i18n.t;
});

afterEach(() => {
  i18n.t = originalT;
  // `globals` is off in `vitest.config.ts`, so testing-library never registers
  // its automatic cleanup — without this the previous test's cards stay in the
  // document and every `screen` query below finds two of everything.
  cleanup();
});

function fieldsCountCalls() {
  return calls.filter(([key]) => key === "dataGrid.fieldsCount").length;
}

describe("DocumentCard memoization", () => {
  it("does not re-render a row when the parent passes a brand-new onExpandField", () => {
    const { rerender } = render(<Harness onExpandField={() => {}} />);
    const afterMount = fieldsCountCalls();
    expect(afterMount).toBeGreaterThan(0);

    // A fresh arrow every time, exactly like DataGrid's inline onExpandField.
    rerender(<Harness onExpandField={() => {}} />);
    expect(fieldsCountCalls()).toBe(afterMount);
  });
});

describe("the list windows its cards", () => {
  it("renders a handful of a 500-document page, not all of it", () => {
    // The reason this view is virtualised at all: a page here is a page of
    // *documents*, each expanded to one line per field, so at the largest page
    // size the unwindowed version built thousands of nodes in one synchronous
    // commit. That is the pause when switching from table to list.
    const { container } = render(
      <Harness onExpandField={() => {}} rows={manyRows} />,
    );
    const cards = container.querySelectorAll("[data-index]");
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.length).toBeLessThan(manyRows.length);
  });

  it("windows against the container it is rendered inside", () => {
    // Regression: the scroll element is a `<div>` this component sits *in*, and
    // React attaches host refs bottom-up alongside layout effects — so the
    // virtualizer's own setup ran before the parent ref existed and windowed
    // against `null`, leaving an empty container of the right height. Nothing
    // re-rendered afterwards to make it look again.
    const { container } = render(
      <Harness onExpandField={() => {}} rows={manyRows} />,
    );
    expect(container.querySelectorAll("[data-index]").length).toBeGreaterThan(
      0,
    );
  });
});

/**
 * "Show me everything in this document", the gesture Compass has and this view
 * did not: a document whose interesting values are two levels down had to be
 * unfolded one chevron at a time, per level, per document.
 *
 * What makes it worth a test is that it cannot be expressed as a set of
 * toggles. A container hidden inside a folded ancestor contributes no line, so
 * its path is not in `fields` and there is nothing to toggle — which is why
 * `DocumentCard` flips the *base* its folds are a diff from instead. These
 * tests assert exactly that: the grandchild, invisible and unaddressable when
 * the press happens, comes out expanded too.
 */
const nestedColumns: ColumnMeta[] = [
  { name: "_id", data_type: "objectId" },
  { name: "processInfo", data_type: "object" },
];
const nestedRows: CellValue[][] = [
  ["42517f60", { "61": { state: "running", retries: 2 } }],
];

/**
 * Every case below mounts under `StrictMode`, exactly as `main.tsx` does, and
 * that is not decoration.
 *
 * The grid-wide gesture shipped broken in a way no non-strict test could see:
 * the card tracked the last epoch it had applied in a *ref*, and StrictMode
 * runs a component body twice and discards the first pass. The ref mutation
 * survived that discard, the second pass therefore saw "already applied", and
 * the only `setState` that had been queued belonged to the render React threw
 * away — a card that had seen the gesture and stayed folded. Outside
 * StrictMode the body runs once and the bug is invisible, which is precisely
 * how it reached a build.
 */
function NestedHarness({
  expandAll,
}: {
  expandAll?: { epoch: number; expanded: boolean } | null;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  return (
    <div ref={scrollRef} style={{ overflow: "auto", height: 400 }}>
      <DocumentListView
        scrollRef={scrollRef}
        columns={nestedColumns}
        rows={nestedRows}
        nullDisplay="NULL"
        zebraStripes={false}
        expandNested={false}
        expandAll={expandAll}
        showTypes={false}
        lineNumbers={false}
        copyToClipboard={() => {}}
        emptyLabel="empty"
      />
    </div>
  );
}

describe("expand every nested object", () => {
  it("unfolds the whole tree, including containers that had no line to toggle", () => {
    render(
      <StrictMode>
        <NestedHarness />
      </StrictMode>,
    );
    // Collapsed: the nested `61` object is not drawn at all, so neither is the
    // `state` leaf underneath it.
    expect(screen.queryByText("61")).toBeNull();
    expect(screen.queryByText("state")).toBeNull();

    fireEvent.click(
      screen.getByLabelText(
        "Expand every nested object in this document",
      ),
    );
    expect(screen.getByText("61")).toBeTruthy();
    expect(screen.getByText("state")).toBeTruthy();
  });

  it("flips to collapse-all once everything is open, and folds back", () => {
    render(
      <StrictMode>
        <NestedHarness />
      </StrictMode>,
    );
    fireEvent.click(
      screen.getByLabelText("Expand every nested object in this document"),
    );
    fireEvent.click(
      screen.getByLabelText("Collapse every nested object in this document"),
    );
    expect(screen.queryByText("61")).toBeNull();
    expect(screen.queryByText("processInfo")).toBeTruthy();
  });

  it("applies the grid-wide gesture, and re-applies it on a second press", () => {
    // The epoch is the whole point: the second press carries the same
    // `expanded: true` a boolean prop would have, and still has to reach a
    // card the user folded by hand in between.
    const { rerender } = render(
      <StrictMode>
        <NestedHarness expandAll={null} />
      </StrictMode>,
    );
    expect(screen.queryByText("state")).toBeNull();

    rerender(
      <StrictMode>
        <NestedHarness expandAll={{ epoch: 1, expanded: true }} />
      </StrictMode>,
    );
    expect(screen.getByText("state")).toBeTruthy();

    fireEvent.click(
      screen.getByLabelText("Collapse every nested object in this document"),
    );
    expect(screen.queryByText("state")).toBeNull();

    rerender(
      <StrictMode>
        <NestedHarness expandAll={{ epoch: 2, expanded: true }} />
      </StrictMode>,
    );
    expect(screen.getByText("state")).toBeTruthy();
  });

  it("offers no control on a document with nothing to unfold", () => {
    render(<Harness onExpandField={() => {}} />);
    expect(
      screen.queryByLabelText("Expand every nested object in this document"),
    ).toBeNull();
  });
});

/**
 * The list view's field context menu — where "sort by this" lives, since the
 * list has no column headers to click — and the browse path each field maps
 * to. The path is the part worth pinning: the list's own paths carry array
 * indexes (a `$set` needs them) while a sort or filter must not.
 */
const menuColumns: ColumnMeta[] = [
  { name: "code", data_type: "string" },
  { name: "tags", data_type: "array" },
  { name: "meta", data_type: "object" },
];
const menuRows: CellValue[][] = [["IMPCR01", ["press"], { plant: "P1" }]];

function MenuHarness({
  nestedPaths,
  sort,
  onSortChange,
  onAddFilter,
}: {
  nestedPaths: boolean;
  sort?: SortSpec[];
  onSortChange: (next: SortSpec[]) => void;
  onAddFilter: (f: ColumnFilter) => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  return (
    <div ref={scrollRef} style={{ overflow: "auto", height: 400 }}>
      <DocumentListView
        scrollRef={scrollRef}
        columns={menuColumns}
        rows={menuRows}
        nullDisplay="NULL"
        zebraStripes={false}
        expandNested
        showTypes={false}
        lineNumbers={false}
        copyToClipboard={() => {}}
        emptyLabel="empty"
        sort={sort}
        onSortChange={onSortChange}
        onAddFilter={onAddFilter}
        nestedPaths={nestedPaths}
      />
    </div>
  );
}

function openMenuOn(text: string) {
  fireEvent.contextMenu(screen.getByText(text));
}

describe("field context menu", () => {
  it("sorts by the field alone, replacing the sort", () => {
    const onSortChange = vi.fn();
    render(
      <MenuHarness
        nestedPaths
        sort={[{ column: "ts", desc: true }]}
        onSortChange={onSortChange}
        onAddFilter={() => {}}
      />,
    );
    openMenuOn('"IMPCR01"');
    fireEvent.click(screen.getByText("Sort descending by code"));
    expect(onSortChange).toHaveBeenCalledWith([{ column: "code", desc: true }]);
  });

  it("offers to drop a field that is already in the sort, keeping the rest", () => {
    const onSortChange = vi.fn();
    render(
      <MenuHarness
        nestedPaths
        sort={[
          { column: "code", desc: false },
          { column: "ts", desc: true },
        ]}
        onSortChange={onSortChange}
        onAddFilter={() => {}}
      />,
    );
    openMenuOn('"IMPCR01"');
    fireEvent.click(screen.getByText("Remove code from the sort"));
    expect(onSortChange).toHaveBeenCalledWith([{ column: "ts", desc: true }]);
  });

  it("filters an array element by its array, not by its index", () => {
    const onAddFilter = vi.fn();
    render(
      <MenuHarness
        nestedPaths
        onSortChange={() => {}}
        onAddFilter={onAddFilter}
      />,
    );
    openMenuOn('"press"');
    fireEvent.click(screen.getByText("Filter by this value"));
    expect(onAddFilter).toHaveBeenCalledWith({
      column: "tags",
      op: "eq",
      value: "press",
    });
  });

  it("addresses a nested field by its dotted path on MongoDB", () => {
    const onSortChange = vi.fn();
    render(
      <MenuHarness
        nestedPaths
        onSortChange={onSortChange}
        onAddFilter={() => {}}
      />,
    );
    openMenuOn('"P1"');
    fireEvent.click(screen.getByText("Sort ascending by meta.plant"));
    expect(onSortChange).toHaveBeenCalledWith([
      { column: "meta.plant", desc: false },
    ]);
  });

  it("offers neither sort nor filter below the top level on SQL", () => {
    render(
      <MenuHarness
        nestedPaths={false}
        onSortChange={() => {}}
        onAddFilter={() => {}}
      />,
    );
    openMenuOn('"P1"');
    expect(screen.queryByText(/Sort ascending/)).toBeNull();
    expect(screen.queryByText("Filter by this value")).toBeNull();
    // The menu itself still opens: copying a value is not a column operation.
    expect(screen.getByText("Copy")).toBeTruthy();
  });
});
