/**
 * @vitest-environment jsdom
 *
 * The policy editor against a mocked backend. What matters: the form and the
 * JSON are one draft; a draft that is not valid cannot be saved; a machine
 * that cannot write the share gets a read-only editor that says why; a
 * conflict keeps the user's text instead of overwriting someone else's save;
 * and an unmanaged machine starts from a template that keeps its author in.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@/lib/i18n";

const api = vi.hoisted(() => ({
  policyOpenForEdit: vi.fn(),
  policyValidate: vi.fn(),
  policySave: vi.fn(),
  policyCreate: vi.fn(),
  listDatabases: vi.fn(async () => []),
  listTables: vi.fn(async () => []),
}));
vi.mock("@/lib/tauri", () => ({ api }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn(async () => null) }));
// Monaco does not run in jsdom; a textarea is the same contract (value in,
// onChange out).
vi.mock("@monaco-editor/react", () => ({
  default: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea aria-label="json" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));
// `readFromClipboard` because the JSON pane's editor menu imports it.
const clipboard = vi.hoisted(() => ({
  copyToClipboard: vi.fn(async () => {}),
  readFromClipboard: vi.fn(async () => null),
}));
vi.mock("@/lib/clipboard", () => clipboard);
const confirm = vi.hoisted(() => ({ confirmDestructive: vi.fn(async (_message: string) => true) }));
vi.mock("@/lib/confirmDestructive", () => confirm);

import { PolicyEditorDialog } from "./PolicyEditorDialog";
import type { PolicyEditDoc, PolicyStatus } from "@/types";

const POLICY = `${JSON.stringify(
  {
    version: 1,
    defaultRole: "none",
    users: { ana: "sales" },
    roles: { none: {}, sales: { rules: [{ endpoint: "*", human: ["select"], ai: ["select"] }] } },
    unmanagedConnections: "deny",
  },
  null,
  2,
)}\n`;

function fileDoc(over: Partial<PolicyEditDoc> = {}): PolicyEditDoc {
  return {
    anchor: { kind: "file", path: "\\\\srv\\it\\huginn-policy.json", origin: "HKLM\\…\\PolicySource", error: null },
    text: POLICY,
    base: { sha256: "abc", mtime: null },
    writable: { exists: true, writable: true, reason: null },
    readError: null,
    validation: { error: null, warnings: [] },
    ...over,
  };
}

const status = { user: "ana", state: "active", roles: [] } as unknown as PolicyStatus;

function renderEditor() {
  const onSaved = vi.fn();
  render(
    <PolicyEditorDialog open onOpenChange={() => {}} status={status} onSaved={onSaved} />,
  );
  return onSaved;
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  api.policyValidate.mockImplementation(async (text: string) => ({
    validation: { error: text.includes("selct") ? "unknown variant `selct`" : null, warnings: [] },
    preview: null,
  }));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("PolicyEditorDialog", () => {
  it("edits one draft from the form and from the JSON", async () => {
    api.policyOpenForEdit.mockResolvedValue(fileDoc());
    renderEditor();
    fireEvent.click(await screen.findByText("Accounts"));
    // Add an account in the form…
    fireEvent.change(screen.getByLabelText("Account"), { target: { value: "bob" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByText("bob")).toBeTruthy();
    // …and it is in the JSON.
    fireEvent.click(screen.getByText("JSON"));
    const json = screen.getByLabelText("json") as HTMLTextAreaElement;
    expect(JSON.parse(json.value).users).toEqual({ ana: "sales", bob: "none" });
  });

  it("asks before removing a rule, and keeps it on a no", async () => {
    api.policyOpenForEdit.mockResolvedValue(fileDoc());
    renderEditor();
    fireEvent.click(await screen.findByText("sales"));
    confirm.confirmDestructive.mockResolvedValueOnce(false);
    fireEvent.click(screen.getByRole("button", { name: "Remove rule" }));
    await waitFor(() => expect(confirm.confirmDestructive).toHaveBeenCalledTimes(1));
    expect(confirm.confirmDestructive.mock.calls[0]![0]).toContain("sales");
    fireEvent.click(screen.getByText("JSON"));
    expect(JSON.parse((screen.getByLabelText("json") as HTMLTextAreaElement).value).roles.sales.rules).toHaveLength(1);
    // A yes removes it.
    fireEvent.click(screen.getByText("Roles"));
    fireEvent.click(screen.getByText("sales"));
    fireEvent.click(screen.getByRole("button", { name: "Remove rule" }));
    fireEvent.click(await screen.findByText("JSON"));
    await waitFor(() =>
      expect(JSON.parse((screen.getByLabelText("json") as HTMLTextAreaElement).value).roles.sales.rules).toHaveLength(0),
    );
  });

  it("will not save a draft the parser rejects", async () => {
    api.policyOpenForEdit.mockResolvedValue(fileDoc());
    renderEditor();
    fireEvent.click(await screen.findByText("JSON"));
    const json = screen.getByLabelText("json");
    fireEvent.change(json, { target: { value: POLICY.replace('"select"', '"selct"') } });
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    expect(await screen.findByText("unknown variant `selct`")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save…" }) as HTMLButtonElement).disabled).toBe(true);
    // And while the text is not JSON at all, the form says so instead of guessing.
    fireEvent.change(json, { target: { value: "{ nope" } });
    fireEvent.click(screen.getByText("Roles"));
    expect(screen.getByText(/The JSON is not valid/)).toBeTruthy();
  });

  it("is read-only, with Windows' reason, where the share refuses a write", async () => {
    api.policyOpenForEdit.mockResolvedValue(
      fileDoc({ writable: { exists: true, writable: false, reason: "Access is denied." } }),
    );
    renderEditor();
    expect(await screen.findByText(/Access is denied\./)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add role" })).toBeNull();
    expect((screen.getByRole("button", { name: "Save…" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps the user's text on a conflict instead of overwriting the other save", async () => {
    api.policyOpenForEdit.mockResolvedValue(fileDoc());
    api.policySave.mockResolvedValue({ status: "conflict", text: POLICY, base: { sha256: "def", mtime: null } });
    const onSaved = renderEditor();
    fireEvent.click(await screen.findByText("Accounts"));
    fireEvent.change(screen.getByLabelText("Account"), { target: { value: "bob" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(screen.getByRole("button", { name: "Save…" }));
    // The confirmation, then the save.
    const confirm = await screen.findAllByRole("button", { name: "Save…" });
    fireEvent.click(confirm[confirm.length - 1]!);
    await waitFor(() => expect(api.policySave).toHaveBeenCalledWith(expect.any(String), "abc"));
    expect(await screen.findByText(/changed on the share since you opened it/)).toBeTruthy();
    expect(clipboard.copyToClipboard).toHaveBeenCalledWith(expect.stringContaining('"bob"'));
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("starts an unmanaged machine from a template that keeps its author in", async () => {
    api.policyOpenForEdit.mockResolvedValue(
      fileDoc({ anchor: { kind: "none", path: null, origin: null, error: null }, text: "", base: null, writable: null }),
    );
    renderEditor();
    expect(await screen.findByText("Create a policy")).toBeTruthy();
    fireEvent.click(screen.getByText("JSON"));
    const draft = JSON.parse((screen.getByLabelText("json") as HTMLTextAreaElement).value);
    expect(draft.users).toEqual({ ana: "admin" });
    expect(draft.defaultRole).toBe("none");
    // Nowhere to write it yet: Create waits for a path.
    expect((screen.getByRole("button", { name: "Create…" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
