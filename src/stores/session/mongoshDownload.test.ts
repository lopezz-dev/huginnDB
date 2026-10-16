import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/tauri", () => ({
  api: {
    terminalMongoshDownload: vi.fn(),
    terminalMongoshCancelDownload: vi.fn(() => Promise.resolve()),
    terminalMongoshDownloadRunning: vi.fn(),
  },
}));

import { api } from "@/lib/tauri";
import { useMongoshDownload } from "./mongoshDownload";

const download = vi.mocked(api.terminalMongoshDownload);
const running = vi.mocked(api.terminalMongoshDownloadRunning);

beforeEach(() => {
  vi.useFakeTimers();
  useMongoshDownload.setState({ status: { phase: "idle" }, revision: 0 });
  download.mockReset();
  running.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("mongosh download store", () => {
  it("a finished install bumps the revision so detection runs again", async () => {
    download.mockResolvedValue({ version: "2.13.0", path: "/x/mongosh" });
    await useMongoshDownload.getState().start();
    const s = useMongoshDownload.getState();
    expect(s.status).toEqual({ phase: "idle" });
    expect(s.revision).toBe(1);
  });

  it("a cancelled install is not an error and changes nothing", async () => {
    download.mockResolvedValue(null);
    await useMongoshDownload.getState().start();
    const s = useMongoshDownload.getState();
    expect(s.status).toEqual({ phase: "idle" });
    expect(s.revision).toBe(0);
  });

  it("a failure is kept until it is dismissed", async () => {
    download.mockRejectedValue("terminal error: checksum mismatch");
    await useMongoshDownload.getState().start();
    expect(useMongoshDownload.getState().status).toEqual({
      phase: "failed",
      error: "terminal error: checksum mismatch",
    });
    useMongoshDownload.getState().dismiss();
    expect(useMongoshDownload.getState().status).toEqual({ phase: "idle" });
  });

  it("'already being downloaded' means in progress elsewhere, not a failure", async () => {
    download.mockRejectedValue("terminal error: mongosh is already being downloaded");
    running.mockResolvedValue(true);
    await useMongoshDownload.getState().start();
    const status = useMongoshDownload.getState().status;
    expect(status.phase).toBe("running");
    expect(status.phase === "running" && status.attached).toBe(true);
  });

  it("an attached download ends, and is detected, when the backend stops reporting it", async () => {
    running.mockResolvedValueOnce(true); // attach
    running.mockResolvedValueOnce(true); // first poll: still going
    running.mockResolvedValue(false); // second poll: done
    await useMongoshDownload.getState().attach();
    expect(useMongoshDownload.getState().status.phase).toBe("running");
    await vi.advanceTimersByTimeAsync(1500);
    expect(useMongoshDownload.getState().status.phase).toBe("running");
    await vi.advanceTimersByTimeAsync(1500);
    const s = useMongoshDownload.getState();
    expect(s.status).toEqual({ phase: "idle" });
    expect(s.revision).toBe(1);
  });

  it("attaching with nothing running does nothing", async () => {
    running.mockResolvedValue(false);
    await useMongoshDownload.getState().attach();
    expect(useMongoshDownload.getState().status).toEqual({ phase: "idle" });
  });
});
