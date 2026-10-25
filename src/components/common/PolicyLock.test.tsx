/**
 * @vitest-environment jsdom
 *
 * The locked shapes, rendered against a store already holding the backend's
 * answers (the store's own batching is `policyAccess.test.ts`). The cases that
 * matter: a tab restored from a previous session is locked by the same gate
 * as one opened now, an unmanaged machine locks nothing, and a locked menu
 * item says why instead of just greying out.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@/lib/i18n";

vi.mock("@/lib/tauri", () => ({
  api: {
    policyAccess: vi.fn(() => new Promise(() => {})),
    policyRelationAccess: vi.fn(() => new Promise(() => {})),
  },
}));

import { Table2 } from "lucide-react";
import {
  PolicyGate,
  PolicyVerbNotice,
} from "@/components/common/PolicyLock";
import {
  ContextMenu,
  ContextMenuAction,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { tabNeed, usePolicyLock } from "@/lib/policy/access";
import {
  resetPolicyAccessForTests,
  usePolicyAccess,
} from "@/stores/session/policyAccess";
import type { ConnectionAccess } from "@/types";

const sales: ConnectionAccess = {
  id: "erp",
  managed: true,
  visible: true,
  freeSql: false,
  verbs: ["select", "insert"],
  export: false,
  monitor: false,
  columns: { insert: null, update: null },
  reason: null,
};

beforeEach(() => {
  resetPolicyAccessForTests();
});
afterEach(cleanup);

function RestoredQueryTab() {
  const { need, relation } = tabNeed({ kind: "query" });
  return (
    <PolicyGate connectionId="erp" need={need} relation={relation}>
      <div>editor</div>
    </PolicyGate>
  );
}

describe("PolicyGate", () => {
  it("mounts the tab on an unmanaged machine", () => {
    usePolicyAccess.setState({ state: "unmanaged" });
    render(<RestoredQueryTab />);
    expect(screen.getByText("editor")).toBeTruthy();
  });

  it("replaces a query tab when free SQL is off, restored or not", () => {
    usePolicyAccess.setState({ state: "active", connections: { erp: sales } });
    render(<RestoredQueryTab />);
    expect(screen.queryByText("editor")).toBeNull();
    expect(screen.getByText("Locked by your organization's policy")).toBeTruthy();
    expect(
      screen.getByText(
        "Your organization's policy doesn't allow free-form queries here",
      ),
    ).toBeTruthy();
  });

  it("locks every tab while the policy is broken", () => {
    usePolicyAccess.setState({ state: "broken", reason: "cannot read" });
    const { need, relation } = tabNeed({ kind: "table", table: "invoices" });
    render(
      <PolicyGate connectionId="erp" need={need} relation={relation}>
        <div>grid</div>
      </PolicyGate>,
    );
    expect(screen.queryByText("grid")).toBeNull();
    expect(
      screen.getByText("The managed policy could not be applied"),
    ).toBeTruthy();
  });
});

describe("PolicyVerbNotice", () => {
  it("names the row actions the policy removed, and nothing otherwise", () => {
    const { container, rerender } = render(
      <PolicyVerbNotice
        locked={{ insert: false, update: false, delete: false }}
      />,
    );
    expect(container.textContent).toBe("");
    rerender(
      <PolicyVerbNotice locked={{ insert: false, update: true, delete: true }} />,
    );
    expect(
      screen.getByText(
        "Your organization's policy doesn't allow editing rows and deleting rows in this table",
      ),
    ).toBeTruthy();
  });

  it("names the columns a limited verb may write", () => {
    render(
      <PolicyVerbNotice
        locked={{ insert: false, update: false, delete: true }}
        columns={{ insert: [], update: ["Estado", "Observaciones"] }}
      />,
    );
    const note = screen.getByRole("note");
    expect(note.textContent).toBe(
      "Your organization's policy doesn't allow deleting rows in this table · " +
        "You can only change Estado and Observaciones · New rows can't fill any column",
    );
  });
});

function DropMenu() {
  const lock = usePolicyLock("erp", "ddl");
  return (
    <ContextMenu>
      <ContextMenuTrigger>row</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuAction
          icon={Table2}
          label="Drop table"
          locked={lock}
          onSelect={() => {}}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
}

describe("ContextMenuAction locked", () => {
  it("disables the item and says why under its label", () => {
    usePolicyAccess.setState({ state: "active", connections: { erp: sales } });
    render(<DropMenu />);
    fireEvent.contextMenu(screen.getByText("row"));
    const item = screen.getByRole("menuitem");
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(item.textContent).toContain(
      "Your organization's policy doesn't allow changing the structure here",
    );
  });
});
