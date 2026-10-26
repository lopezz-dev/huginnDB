/**
 * @vitest-environment jsdom
 *
 * The aggregation preview's own "expand every nested object".
 *
 * It exists as a separate test because this surface is the one place the list
 * view is mounted *without* a `DataGrid` around it: there is no footer here to
 * hang the gesture on, so `PipelineOutput` owns the `ExpandAllSignal` itself.
 * That wiring is what can rot independently of the grid's — the shared piece
 * (what a card does with an epoch) is covered next door in
 * `grid/DocumentListView.test.tsx`.
 *
 * Mounted under `StrictMode`, exactly as `main.tsx` does, for the reason ADR
 * gotcha #85 records: a component that adjusts state during render behaves
 * differently when the body runs twice, and the version of this feature that
 * shipped broken passed every non-strict test.
 */
import { StrictMode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "@/lib/i18n";
import { PipelineOutput } from "./PipelineOutput";
import type { QueryResult } from "@/types";

vi.mock("@/lib/tauri", () => ({
  // The preferences store schedules a debounced save on every setter.
  api: { updatePreferences: () => Promise.resolve() },
}));

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

/** jsdom has no layout, so the list's virtualizer would window nothing —
 *  `virtual-core` reads these properties, not `getBoundingClientRect`.
 *  Same shims, and the same reasoning, as `DocumentListView.test.tsx`. */
function stubSize(
  prop: "offsetHeight" | "offsetWidth" | "clientHeight" | "clientWidth",
  value: number,
) {
  Object.defineProperty(HTMLElement.prototype, prop, {
    configurable: true,
    get: () => value,
  });
}

const nested = {
  columns: [
    { name: "_id", data_type: "objectId" },
    { name: "info", data_type: "object" },
  ],
  rows: [["a-1", { key: "STOP_TIME_REASON", userId: "SYSTEM" }]],
  elapsed_ms: 1,
  total: 1,
} as unknown as QueryResult;

/** A `$group` that projects scalars: nothing nests, so nothing to unfold. */
const flat = {
  columns: [
    { name: "_id", data_type: "string" },
    { name: "count", data_type: "int" },
  ],
  rows: [["stopTime", 12]],
  elapsed_ms: 1,
  total: 1,
} as unknown as QueryResult;

const EXPAND = "Expand every nested object, in every document";
const COLLAPSE = "Collapse every nested object, in every document";

function mount(result: QueryResult) {
  return render(
    <StrictMode>
      <PipelineOutput result={result} emptyLabel="empty" />
    </StrictMode>,
  );
}

beforeEach(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??=
    NoopResizeObserver;
  stubSize("offsetHeight", 400);
  stubSize("offsetWidth", 600);
  stubSize("clientHeight", 400);
  stubSize("clientWidth", 600);
});

afterEach(() => {
  // Explicit because this project's vitest config sets no `globals`, so
  // testing-library never registers its automatic cleanup.
  cleanup();
});

describe("the aggregation preview's expand-all", () => {
  it("unfolds every document in the preview", () => {
    mount(nested);
    expect(screen.queryByText("userId")).toBeNull();

    fireEvent.click(screen.getByLabelText(EXPAND));
    expect(screen.getByText("userId")).toBeTruthy();
  });

  it("folds them back, and re-expands on a second press", () => {
    // The second press carries the same `expanded: true` as the first: it is
    // the epoch, not the value, that makes it a fresh gesture (gotcha #85).
    mount(nested);
    fireEvent.click(screen.getByLabelText(EXPAND));
    fireEvent.click(screen.getByLabelText(COLLAPSE));
    expect(screen.queryByText("userId")).toBeNull();

    fireEvent.click(screen.getByLabelText(EXPAND));
    expect(screen.getByText("userId")).toBeTruthy();
  });

  it("offers no control when the pipeline projects only scalars", () => {
    mount(flat);
    expect(screen.queryByLabelText(EXPAND)).toBeNull();
  });
});
