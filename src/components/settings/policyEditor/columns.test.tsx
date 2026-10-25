/**
 * @vitest-environment jsdom
 *
 * Column limits in the rule editor (ADR #113). What matters: "Only these"
 * writes a list into the rule and "All" removes it (absent is every column,
 * `[]` is none), the catalog says which columns are required or generated, and
 * each warning's button makes the one change that closes it.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@/lib/i18n";

import type { RuleJson } from "@/lib/policy/draft";
import {
  ColumnScopeField,
  ColumnWarnings,
  withColumnLimit,
  type ColumnCatalog,
} from "./columns";

afterEach(cleanup);

const pedidos: ColumnCatalog = {
  columns: [
    { name: "Id", tables: ["dbo.Pedidos"], requiredIn: [], identity: true },
    { name: "Cliente", tables: ["dbo.Pedidos"], requiredIn: ["dbo.Pedidos"], identity: false },
    { name: "Estado", tables: ["dbo.Pedidos"], requiredIn: [], identity: false },
    { name: "Observaciones", tables: ["dbo.Pedidos"], requiredIn: [], identity: false },
  ],
  tables: ["dbo.Pedidos"],
  loading: false,
  reason: null,
};

const rule = (over: Partial<RuleJson> = {}): RuleJson => ({
  endpoint: { driver: "sqlserver", host: "erp" },
  relations: { allow: ["dbo.Pedidos"] },
  human: ["select", "insert", "update"],
  ...over,
});

describe("withColumnLimit", () => {
  it("sets a verb's list and drops `columns` once nothing is limited", () => {
    const limited = withColumnLimit(rule(), "update", ["Estado"]);
    expect(limited.columns).toEqual({ update: ["Estado"] });
    expect(withColumnLimit(limited, "update", []).columns).toEqual({ update: [] });
    expect("columns" in withColumnLimit(limited, "update", undefined)).toBe(false);
  });
});

describe("ColumnScopeField", () => {
  it("limits a verb to the columns picked from the catalog", () => {
    const onChange = vi.fn();
    render(
      <ColumnScopeField
        verb="update"
        rule={rule()}
        catalog={pedidos}
        catalogSource="ERP"
        mssql
        readOnly={false}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "Only these" }));
    expect(onChange).toHaveBeenLastCalledWith(rule({ columns: { update: [] } }));
  });

  it("tags required and generated columns, and generated ones cannot be picked", () => {
    const onChange = vi.fn();
    render(
      <ColumnScopeField
        verb="insert"
        rule={rule({ columns: { insert: ["Estado"] } })}
        catalog={pedidos}
        catalogSource="ERP"
        mssql
        readOnly={false}
        onChange={onChange}
      />,
    );
    expect(screen.getByText("required")).toBeTruthy();
    expect((screen.getByLabelText(/^Id/) as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/^Cliente/));
    expect(onChange).toHaveBeenLastCalledWith(
      rule({ columns: { insert: ["Estado", "Cliente"] } }),
    );
    // On SQL Server the insert limit is HuginnDB's alone, and it says so.
    expect(screen.getByText(/SQL Server has no column-level INSERT/)).toBeTruthy();
  });
});

describe("ColumnWarnings", () => {
  it("is silent when the limits let everything through that they should", () => {
    const { container } = render(
      <ColumnWarnings
        rule={rule({ columns: { insert: ["Cliente", "Estado"], update: ["Estado"] } })}
        catalog={pedidos}
        readOnly={false}
        onChange={() => {}}
      />,
    );
    expect(container.textContent).toBe("");
  });

  it("adds a required column the insert list leaves out", () => {
    const onChange = vi.fn();
    render(
      <ColumnWarnings
        rule={rule({ columns: { insert: ["Estado"] } })}
        catalog={pedidos}
        readOnly={false}
        onChange={onChange}
      />,
    );
    expect(screen.getByText("No row could be added to dbo.Pedidos")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add Cliente" }));
    expect(onChange).toHaveBeenCalledWith(rule({ columns: { insert: ["Estado", "Cliente"] } }));
  });

  it("takes delete away, from the person and the AI, when it would undo the update limit", () => {
    const onChange = vi.fn();
    const limited = rule({
      human: ["select", "insert", "update", "delete"],
      ai: ["select", "delete"],
      columns: { update: ["Estado"] },
    });
    render(
      <ColumnWarnings rule={limited} catalog={pedidos} readOnly={false} onChange={onChange} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove delete" }));
    expect(onChange).toHaveBeenCalledWith({
      ...limited,
      human: ["select", "insert", "update"],
      ai: ["select"],
    });
  });

  it("offers no fix on a read-only policy", () => {
    render(
      <ColumnWarnings
        rule={rule({ columns: { insert: ["Estado"] } })}
        catalog={pedidos}
        readOnly
        onChange={() => {}}
      />,
    );
    expect(screen.queryByRole("button")).toBeNull();
  });
});
