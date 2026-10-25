/**
 * @vitest-environment jsdom
 *
 * Settings → Policy renders what `policy_status` reports, for each state a
 * machine can be in. The panel is read-only, so the tests are about what a
 * user is *told*: who they are, which role, what each connection allows, and
 * — the case that matters most — that a broken policy blocks every connection, for people and the AI.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import "@/lib/i18n";
import { PolicySection } from "./PolicySection";
import { useConnections } from "@/stores/session/connections";
import type { ConnectionProfile, GrantScript, PolicyStatus } from "@/types";

const policyStatus = vi.fn<() => Promise<PolicyStatus>>();
const policyGenerateGrants =
  vi.fn<(connectionId: string, role: string) => Promise<GrantScript>>();

vi.mock("@/lib/tauri", () => ({
  api: {
    policyStatus: () => policyStatus(),
    policyGenerateGrants: (id: string, role: string) =>
      policyGenerateGrants(id, role),
  },
}));

afterEach(() => {
  cleanup();
  policyStatus.mockReset();
});

function status(over: Partial<PolicyStatus> = {}): PolicyStatus {
  return {
    state: "active",
    source: "\\\\srv\\it\\huginn.json (named by C:\\Program Files\\HuginnDB\\managed-policy.json)",
    error: null,
    warnings: [],
    user: "ana",
    role: "sales",
    unmanagedConnections: "deny",
    roles: [
      { name: "none", members: [] },
      { name: "sales", members: ["ana"] },
    ],
    connections: [
      {
        id: "erp",
        name: "ERP",
        unmatched: false,
        leftAlone: false,
        dbUser: "ana",
        rules: [
          {
            databases: ["billing"],
            allow: ["invoices", "v_invoice_*"],
            deny: ["v_invoice_cards"],
            human: ["select", "insert", "update"],
            ai: ["select"],
            freeSql: false,
            columns: { insert: null, update: null },
          },
        ],
      },
      {
        id: "hr",
        name: "HR",
        unmatched: true,
        leftAlone: false,
        dbUser: null,
        rules: [],
      },
    ],
    ...over,
  };
}

describe("PolicySection", () => {
  it("shows the account, the role and what each connection allows", async () => {
    policyStatus.mockResolvedValue(status());
    render(<PolicySection />);

    expect(await screen.findByText("sales")).toBeTruthy();
    expect(screen.getByText("ana")).toBeTruthy();
    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.getByText(/1 with rules · 1 without/)).toBeTruthy();
    // One line per connection until it is opened.
    expect(
      screen.getByText("People: select, insert, update · AI: select · free SQL: no"),
    ).toBeTruthy();
    expect(screen.queryByText("invoices, v_invoice_*")).toBeNull();

    fireEvent.click(screen.getByText("ERP"));
    expect(screen.getByText("billing")).toBeTruthy();
    // The database user the policy signs this person in as.
    expect(screen.getByText(/Database user/)).toBeTruthy();
    expect(screen.getByText("invoices, v_invoice_*")).toBeTruthy();
    expect(screen.getByText("v_invoice_cards")).toBeTruthy();
    // What the AI gets and what the person gets, told apart.
    expect(screen.getByText("select")).toBeTruthy();
    expect(screen.getByText("select, insert, update")).toBeTruthy();
    expect(screen.getByText(/^disabled/)).toBeTruthy();
    // And the panel is honest about phase 1.
    expect(screen.getByText(/applies the policy as a guardrail/)).toBeTruthy();
  });

  it("opens on the connections a rule names, the rest one click away", async () => {
    policyStatus.mockResolvedValue(status());
    render(<PolicySection />);

    expect(await screen.findByText("ERP")).toBeTruthy();
    expect(screen.queryByText("HR")).toBeNull();

    fireEvent.click(screen.getByText("Without (1)"));
    expect(screen.getByText("HR")).toBeTruthy();
    // Under `deny`, a connection no rule names is out of reach.
    expect(screen.getByText("no rule — blocked")).toBeTruthy();
    expect(screen.queryByText("ERP")).toBeNull();
  });

  it("stays usable with many connections", async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      id: `c${i}`,
      name: `Client ${String(i).padStart(2, "0")}`,
      unmatched: i >= 3,
      leftAlone: false,
      dbUser: null,
      rules:
        i < 3
          ? [
              {
                databases: null,
                allow: null,
                deny: [],
                human: ["select"],
                ai: ["select"],
                freeSql: true,
                columns: { insert: null, update: null },
              },
            ]
          : [],
    }));
    policyStatus.mockResolvedValue(status({ connections: many }));
    render(<PolicySection />);

    expect(
      await screen.findByText("25 connections · 3 with rules · 22 without"),
    ).toBeTruthy();
    // Only the three a rule names are listed to begin with.
    expect(screen.getAllByText(/^Client /)).toHaveLength(3);

    fireEvent.click(screen.getByText("All"));
    expect(screen.getAllByText(/^Client /)).toHaveLength(25);

    fireEvent.change(screen.getByPlaceholderText("Filter connections"), {
      target: { value: "client 2" },
    });
    // "Client 20" … "Client 24", matched without regard to case.
    expect(screen.getAllByText(/^Client /)).toHaveLength(5);

    fireEvent.change(screen.getByPlaceholderText("Filter connections"), {
      target: { value: "nothing like it" },
    });
    expect(screen.getByText("No connection matches.")).toBeTruthy();
  });

  it("says a broken policy blocks every connection, and why", async () => {
    policyStatus.mockResolvedValue(
      status({
        state: "broken",
        error: "the policy is not valid: unknown field `relatons`",
        role: null,
        unmanagedConnections: null,
        connections: [],
      }),
    );
    render(<PolicySection />);

    expect(await screen.findByText("Could not be applied")).toBeTruthy();
    expect(
      screen.getByText(/no connection can be read or written/),
    ).toBeTruthy();
    expect(screen.getByText(/unknown field `relatons`/)).toBeTruthy();
    // Nothing about connections is shown when there is no policy in force.
    expect(screen.queryByText("ERP")).toBeNull();
  });

  it("explains an unmanaged machine instead of showing an empty table", async () => {
    policyStatus.mockResolvedValue(
      status({
        state: "unmanaged",
        source: null,
        role: null,
        unmanagedConnections: null,
        connections: [],
      }),
    );
    render(<PolicySection />);

    expect(await screen.findByText("Not managed")).toBeTruthy();
    expect(screen.getByText(/HKLM\\SOFTWARE\\Policies\\HuginnDB/)).toBeTruthy();
  });

  it("surfaces the warnings a valid policy carries", async () => {
    policyStatus.mockResolvedValue(
      status({
        warnings: [
          'role "sales", rule 1: `ai` grants something `human` does not; the AI never gets more than the person, so the extra is ignored',
        ],
      }),
    );
    render(<PolicySection />);

    expect(await screen.findByText("Warnings")).toBeTruthy();
    expect(screen.getByText(/the extra is ignored/)).toBeTruthy();
  });

  it("generates a role's grants against a connected server, and only shows them", async () => {
    policyStatus.mockResolvedValue(status());
    policyGenerateGrants.mockResolvedValue({
      language: "sql",
      roleName: "huginn_sales",
      script: "CREATE ROLE IF NOT EXISTS 'huginn_sales';",
      warnings: ["Roles need MySQL 8.0 or MariaDB 10.0.5 or later."],
    });
    useConnections.setState({
      profiles: [
        { id: "erp", name: "ERP", driver: "mysql" } as unknown as ConnectionProfile,
        { id: "local", name: "Local file", driver: "sqlite" } as unknown as ConnectionProfile,
      ],
      active: new Set(["erp", "local"]),
    });
    render(<PolicySection />);

    fireEvent.click(await screen.findByText("Generate grants"));
    // The user's own role is the one picked first; SQLite is not offered.
    expect(screen.queryByRole("option", { name: "Local file" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));

    expect(await screen.findByText("CREATE ROLE IF NOT EXISTS 'huginn_sales';")).toBeTruthy();
    expect(policyGenerateGrants).toHaveBeenCalledWith("erp", "sales");
    expect(screen.getByText(/MariaDB 10.0.5/)).toBeTruthy();
  });
});
