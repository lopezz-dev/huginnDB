import { describe, expect, it } from "vitest";
import type { ConnectionAccess, RelationAccess } from "@/types";
import { columnLimitFor, lockFor } from "./access";

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

const invoices: RelationAccess = {
  visible: true,
  verbs: ["select"],
  export: false,
  columns: { insert: null, update: null },
};

describe("lockFor", () => {
  it("locks nothing it has no answer for, or on an unmanaged machine", () => {
    expect(lockFor("unknown", null, undefined, undefined, "delete")).toBeNull();
    expect(lockFor("active", null, undefined, undefined, "delete")).toBeNull();
    expect(lockFor("unmanaged", null, sales, invoices, "delete")).toBeNull();
  });

  it("locks everything while the policy is pending or broken", () => {
    expect(lockFor("broken", "no share", undefined, undefined, "read")).toEqual({
      kind: "state",
      state: "broken",
      reason: "no share",
    });
    expect(lockFor("pending", null, sales, invoices, "read")?.kind).toBe("state");
  });

  it("locks a connection the role may not use", () => {
    const hidden = { ...sales, visible: false, reason: "refused" };
    expect(lockFor("active", null, hidden, undefined, "read")).toEqual({
      kind: "connection",
      reason: "refused",
    });
  });

  it("leaves a connection the policy does not govern alone", () => {
    const loose = { ...sales, managed: false, verbs: [] };
    expect(lockFor("active", null, loose, undefined, "ddl")).toBeNull();
  });

  it("checks the connection's upper bound, then the relation", () => {
    expect(lockFor("active", null, sales, undefined, "insert")).toBeNull();
    expect(lockFor("active", null, sales, undefined, "delete")).toEqual({
      kind: "need",
      need: "delete",
    });
    // The connection allows insert, but this relation does not.
    expect(lockFor("active", null, sales, invoices, "insert")?.kind).toBe("need");
    expect(lockFor("active", null, sales, invoices, "read")).toBeNull();
    expect(lockFor("active", null, sales, undefined, "freeSql")?.kind).toBe("need");
    expect(lockFor("active", null, sales, undefined, "monitor")?.kind).toBe("need");
    expect(lockFor("active", null, sales, undefined, "export")?.kind).toBe("need");
  });
});

describe("columnLimitFor", () => {
  it("has no limit without an answer, and reads the verb's own list", () => {
    expect(columnLimitFor(undefined, "update")).toBeNull();
    const orders: RelationAccess = {
      ...invoices,
      verbs: ["select", "insert", "update"],
      columns: { insert: ["customer", "status"], update: ["status"] },
    };
    expect(columnLimitFor(orders, "update")).toEqual(["status"]);
    expect(columnLimitFor(orders, "insert")).toEqual(["customer", "status"]);
    expect(columnLimitFor(invoices, "update")).toBeNull();
  });
});
