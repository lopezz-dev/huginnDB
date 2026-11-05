/**
 * @vitest-environment jsdom
 *
 * `TimePicker` is three spin segments. What these pin down: it always renders
 * a 24-hour clock whatever the OS locale, typing fills a segment and moves on
 * (early when the first digit can only start one value), the arrows wrap, and
 * the emitted string keeps the native input's `HH:MM[:SS]` shape.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { TimePicker, parseTime } from "./time-picker";

afterEach(() => {
  cleanup();
});

const LABELS = { hours: "Hours", minutes: "Minutes", seconds: "Seconds" };

let last = "";
function Harness({ initial, seconds }: { initial: string; seconds?: boolean }) {
  const [value, setValue] = useState(initial);
  return (
    <TimePicker
      value={value}
      onChange={(v) => {
        last = v;
        setValue(v);
      }}
      labels={LABELS}
      seconds={seconds}
    />
  );
}

const seg = (name: string) => screen.getByRole("spinbutton", { name }) as HTMLInputElement;

describe("parseTime", () => {
  it("reads HH:MM and HH:MM:SS, clamping out-of-range parts", () => {
    expect(parseTime("09:05")).toEqual({ h: 9, m: 5, s: 0 });
    expect(parseTime("23:59:59")).toEqual({ h: 23, m: 59, s: 59 });
    expect(parseTime("27:75:99")).toEqual({ h: 23, m: 59, s: 59 });
    expect(parseTime("nonsense")).toEqual({ h: 0, m: 0, s: 0 });
  });
});

describe("TimePicker", () => {
  it("shows a 24-hour clock", () => {
    render(<Harness initial="18:46:33" />);
    expect([seg("Hours").value, seg("Minutes").value, seg("Seconds").value]).toEqual([
      "18",
      "46",
      "33",
    ]);
    expect(document.body.textContent).not.toMatch(/AM|PM/);
  });

  it("commits two typed digits and moves to the next segment", () => {
    render(<Harness initial="10:00:00" />);
    seg("Hours").focus();
    fireEvent.change(seg("Hours"), { target: { value: "1" } });
    expect(seg("Hours").value).toBe("1");
    fireEvent.change(seg("Hours"), { target: { value: "14" } });
    expect(last).toBe("14:00:00");
    expect(document.activeElement).toBe(seg("Minutes"));
  });

  it("moves on after one digit that no second digit could follow", () => {
    render(<Harness initial="10:00:00" />);
    seg("Minutes").focus();
    fireEvent.change(seg("Minutes"), { target: { value: "7" } });
    expect(last).toBe("10:07:00");
    expect(document.activeElement).toBe(seg("Seconds"));
  });

  it("commits a single pending digit on blur", () => {
    render(<Harness initial="10:00:00" />);
    seg("Hours").focus();
    fireEvent.change(seg("Hours"), { target: { value: "2" } });
    fireEvent.blur(seg("Hours"));
    expect(last).toBe("02:00:00");
  });

  it("steps with the arrows and wraps", () => {
    render(<Harness initial="23:59:00" />);
    fireEvent.keyDown(seg("Hours"), { key: "ArrowUp" });
    expect(last).toBe("00:59:00");
    fireEvent.keyDown(seg("Minutes"), { key: "ArrowDown" });
    expect(last).toBe("00:58:00");
  });

  it("emits HH:MM without a seconds segment", () => {
    render(<Harness initial="08:30" seconds={false} />);
    expect(screen.queryByRole("spinbutton", { name: "Seconds" })).toBeNull();
    fireEvent.keyDown(seg("Minutes"), { key: "ArrowUp" });
    expect(last).toBe("08:31");
  });
});
