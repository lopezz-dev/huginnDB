/**
 * @vitest-environment jsdom
 *
 * Nothing behind the wall mounts before the lock has answered, and nothing
 * mounts while it says "locked" (ADR #118). The backend refuses regardless;
 * this is the interface's half — the part that decides whether the app's
 * stores, bridges and restored tabs are even created.
 */
import { StrictMode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "@/lib/i18n";
import type { LockStatus } from "@/types";
import { LockGate } from "./LockGate";

const vaultStatus = vi.fn<() => Promise<LockStatus>>();
const vaultUnlock = vi.fn();
const vaultActivity = vi.fn(() => Promise.resolve());

vi.mock("@/lib/tauri", () => ({
  api: {
    vaultStatus: () => vaultStatus(),
    vaultUnlock: (password: string) => vaultUnlock(password),
    vaultActivity: () => vaultActivity(),
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve(() => {}),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    label: "main",
    title: () => Promise.resolve("HuginnDB"),
    isMaximized: () => Promise.resolve(false),
    onResized: () => Promise.resolve(() => {}),
  }),
}));

function status(mode: LockStatus["mode"], extra: Partial<LockStatus> = {}): LockStatus {
  return {
    mode,
    problem: null,
    retryAfterMs: 0,
    idleMinutes: 15,
    sessionWatch: true,
    language: "en",
    minPasswordChars: 12,
    ...extra,
  };
}

function mount() {
  return render(
    <StrictMode>
      <LockGate>
        <p>behind the wall</p>
      </LockGate>
    </StrictMode>,
  );
}

beforeEach(() => {
  // Reduced motion: the wall hands over without waiting for the padlock to
  // swing open, so the tests do not depend on animation timers.
  window.matchMedia = ((query: string) => ({
    matches: query.includes("reduce"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
  vaultStatus.mockReset();
  vaultUnlock.mockReset();
  vaultActivity.mockClear();
});
afterEach(cleanup);

describe("LockGate", () => {
  it("renders nothing of the app until the lock has answered", () => {
    vaultStatus.mockReturnValue(new Promise(() => {}));
    mount();
    expect(screen.queryByText("behind the wall")).toBeNull();
  });

  it("shows only the wall while locked", async () => {
    vaultStatus.mockResolvedValue(status("locked"));
    mount();
    expect(await screen.findByText("HuginnDB is locked")).toBeTruthy();
    expect(screen.queryByText("behind the wall")).toBeNull();
  });

  it("offers only the reset when the vault is broken", async () => {
    vaultStatus.mockResolvedValue(status("broken", { problem: "vault.json is missing" }));
    mount();
    expect(await screen.findByText("vault.json is missing")).toBeTruthy();
    expect(screen.queryByPlaceholderText("Master password")).toBeNull();
    expect(screen.getByText("Delete the secrets and reset")).toBeTruthy();
  });

  it("mounts the app once the right password opens the vault", async () => {
    let opened = false;
    vaultStatus.mockImplementation(() => Promise.resolve(status(opened ? "unlocked" : "locked")));
    vaultUnlock.mockImplementation(() => {
      opened = true;
      return Promise.resolve({ opened: true, failures: 0, retryAfterMs: 0 });
    });
    mount();
    const field = await screen.findByPlaceholderText("Master password");
    fireEvent.change(field, { target: { value: "correct horse battery" } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    expect(await screen.findByText("behind the wall")).toBeTruthy();
    expect(vaultUnlock).toHaveBeenCalledWith("correct horse battery");
  });

  it("says how long to wait after repeated failures", async () => {
    vaultStatus.mockResolvedValue(status("locked"));
    vaultUnlock.mockResolvedValue({ opened: false, failures: 3, retryAfterMs: 4_000 });
    mount();
    const field = await screen.findByPlaceholderText("Master password");
    fireEvent.change(field, { target: { value: "wrong guess here" } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    // The wait is said where the status goes, and the field is closed for it.
    expect(await screen.findByText(/Try again in 4 seconds/, {}, { timeout: 2000 })).toBeTruthy();
    expect((screen.getByPlaceholderText("Master password") as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByText("behind the wall")).toBeNull();
  });

  it("renders the app with the lock off, and reports activity once unlocked", async () => {
    vaultStatus.mockResolvedValue(status("unlocked"));
    mount();
    expect(await screen.findByText("behind the wall")).toBeTruthy();
    fireEvent.keyDown(window, { key: "a" });
    fireEvent.keyDown(window, { key: "b" });
    await waitFor(() => expect(vaultActivity).toHaveBeenCalledTimes(1));
  });
});
