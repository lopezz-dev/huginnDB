/**
 * The seam's contract, which is easy to regress into the exact bug it exists
 * to fix (ADR #63): both halves must go through the Tauri plugin, and
 * `navigator.clipboard` must only ever be the outside-the-shell fallback.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const pluginWriteText = vi.fn();
const pluginReadText = vi.fn();
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: (...args: unknown[]) => pluginWriteText(...args),
  readText: (...args: unknown[]) => pluginReadText(...args),
}));

const navWriteText = vi.fn();
const navReadText = vi.fn();
Object.defineProperty(globalThis, "navigator", {
  value: { clipboard: { writeText: navWriteText, readText: navReadText } },
  configurable: true,
});

const { copyToClipboard, readFromClipboard } = await import("./clipboard");

beforeEach(() => {
  pluginWriteText.mockReset().mockResolvedValue(undefined);
  pluginReadText.mockReset().mockResolvedValue("");
  navWriteText.mockReset().mockResolvedValue(undefined);
  navReadText.mockReset().mockResolvedValue("");
});

describe("copyToClipboard", () => {
  it("writes through the plugin, not the webview", async () => {
    await copyToClipboard("hello");

    expect(pluginWriteText).toHaveBeenCalledWith("hello");
    expect(navWriteText).not.toHaveBeenCalled();
  });

  it("falls back to the webview when the plugin has no IPC to talk to", async () => {
    pluginWriteText.mockRejectedValue(new Error("no tauri"));

    await copyToClipboard("hello");

    expect(navWriteText).toHaveBeenCalledWith("hello");
  });

  it("stays silent when both paths fail", async () => {
    pluginWriteText.mockRejectedValue(new Error("no tauri"));
    navWriteText.mockRejectedValue(new Error("denied"));

    await expect(copyToClipboard("hello")).resolves.toBeUndefined();
  });
});

describe("readFromClipboard", () => {
  it("reads through the plugin, so the webview never prompts", async () => {
    pluginReadText.mockResolvedValue("pasted");

    await expect(readFromClipboard()).resolves.toBe("pasted");
    expect(navReadText).not.toHaveBeenCalled();
  });

  it("falls back to the webview outside the Tauri shell", async () => {
    pluginReadText.mockRejectedValue(new Error("no tauri"));
    navReadText.mockResolvedValue("pasted");

    await expect(readFromClipboard()).resolves.toBe("pasted");
  });

  it("reports an unreadable clipboard as null rather than throwing", async () => {
    pluginReadText.mockRejectedValue(new Error("no tauri"));
    navReadText.mockRejectedValue(new Error("denied"));

    await expect(readFromClipboard()).resolves.toBeNull();
  });
});
