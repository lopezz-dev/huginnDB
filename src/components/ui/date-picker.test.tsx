/**
 * @vitest-environment jsdom
 *
 * `Calendar` is a date grid with one day in the Tab order; `DatePicker` is the
 * field that opens it. What these pin down: the grid starts on the selected
 * month with the week starting where it is told to, the keyboard moves across
 * month boundaries, picking emits the ISO date and closes the popover, and
 * Escape hands focus back to the field.
 *
 * Plain DOM assertions rather than jest-dom matchers, as in `button.test.tsx`.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Calendar, DatePicker, formatIsoDate, parseIsoDate } from "./date-picker";

afterEach(() => {
  cleanup();
});

const LABELS = { previousMonth: "Previous month", nextMonth: "Next month" };

function CalendarHarness({ initial, onChange }: { initial: string; onChange?: (v: string) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <Calendar
      value={value}
      onChange={(v) => {
        setValue(v);
        onChange?.(v);
      }}
      labels={LABELS}
      locale="en-GB"
    />
  );
}

const activeDay = () => document.activeElement?.getAttribute("data-day");

describe("parseIsoDate / formatIsoDate", () => {
  it("round-trips a calendar date and rejects impossible ones", () => {
    expect(formatIsoDate(parseIsoDate("2026-11-05")!)).toBe("2026-11-05");
    expect(parseIsoDate("2026-02-29")).toBeNull();
    expect(parseIsoDate("2028-02-29")).not.toBeNull();
    expect(parseIsoDate("05/11/2026")).toBeNull();
    expect(parseIsoDate("")).toBeNull();
  });
});

describe("Calendar", () => {
  it("shows the selected month, starting the week on Monday", () => {
    render(<CalendarHarness initial="2026-11-05" />);
    expect(screen.getByText("November 2026")).toBeTruthy();
    const headers = screen.getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers[0]).toBe("Mon");
    // 1 Nov 2026 is a Sunday: the grid opens on Monday 26 October.
    const first = screen.getAllByRole("gridcell")[0].querySelector("button");
    expect(first?.getAttribute("data-day")).toBe("2026-10-26");
    const selected = screen
      .getAllByRole("gridcell")
      .filter((c) => c.getAttribute("aria-selected") === "true");
    expect(selected.map((c) => c.querySelector("button")?.getAttribute("data-day"))).toEqual([
      "2026-11-05",
    ]);
  });

  it("keeps exactly one day in the Tab order", () => {
    render(<CalendarHarness initial="2026-11-05" />);
    const tabbable = document.querySelectorAll('[data-day][tabindex="0"]');
    expect([...tabbable].map((b) => b.getAttribute("data-day"))).toEqual(["2026-11-05"]);
  });

  it("moves by day, week and month from the keyboard, across month edges", () => {
    render(<CalendarHarness initial="2026-11-30" />);
    const grid = screen.getByRole("grid");
    fireEvent.keyDown(grid, { key: "ArrowRight" });
    expect(activeDay()).toBe("2026-12-01");
    expect(screen.getByText("December 2026")).toBeTruthy();
    fireEvent.keyDown(grid, { key: "ArrowUp" });
    expect(activeDay()).toBe("2026-11-24");
    fireEvent.keyDown(grid, { key: "PageDown" });
    expect(activeDay()).toBe("2026-12-24");
    fireEvent.keyDown(grid, { key: "Home" });
    expect(activeDay()).toBe("2026-12-21"); // Monday
  });

  it("clamps a month step to the shorter month", () => {
    render(<CalendarHarness initial="2026-01-31" />);
    fireEvent.keyDown(screen.getByRole("grid"), { key: "PageDown" });
    expect(activeDay()).toBe("2026-02-28");
  });

  it("emits the ISO date on a click", () => {
    const onChange = vi.fn();
    render(<CalendarHarness initial="2026-11-05" onChange={onChange} />);
    fireEvent.click(document.querySelector('[data-day="2026-11-17"]')!);
    expect(onChange).toHaveBeenCalledWith("2026-11-17");
  });

  it("pages with the arrow buttons", () => {
    render(<CalendarHarness initial="2026-11-05" />);
    fireEvent.click(screen.getByRole("button", { name: "Previous month" }));
    expect(screen.getByText("October 2026")).toBeTruthy();
  });
});

describe("DatePicker", () => {
  function PickerHarness({ onChange }: { onChange?: (v: string) => void }) {
    const [value, setValue] = useState("2026-11-05");
    return (
      <DatePicker
        value={value}
        onChange={(v) => {
          setValue(v);
          onChange?.(v);
        }}
        labels={{ ...LABELS, field: "Date" }}
        locale="en-GB"
      />
    );
  }

  it("shows the value in the locale's short form, not the OS's", () => {
    render(<PickerHarness />);
    expect(screen.getByRole("button", { name: "Date" }).textContent).toBe("05/11/2026");
  });

  it("opens a calendar, picks a day and closes back onto the field", () => {
    const onChange = vi.fn();
    render(<PickerHarness onChange={onChange} />);
    const field = screen.getByRole("button", { name: "Date" });
    fireEvent.click(field);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(activeDay()).toBe("2026-11-05");
    fireEvent.click(document.querySelector('[data-day="2026-11-20"]')!);
    expect(onChange).toHaveBeenCalledWith("2026-11-20");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(field);
    expect(field.textContent).toBe("20/11/2026");
  });

  it("closes on Escape and on a click outside", () => {
    render(
      <>
        <PickerHarness />
        <p>outside</p>
      </>,
    );
    const field = screen.getByRole("button", { name: "Date" });
    fireEvent.click(field);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(field);

    fireEvent.click(field);
    fireEvent.pointerDown(screen.getByText("outside"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
