/**
 * The store's one non-obvious job is batching: every locked control that finds
 * its answer missing queues it, and one microtask later the queue goes out as
 * one call. A regression here does not break anything visibly — it turns a
 * table listing into one `policy_relation_access` call per row — so it is
 * pinned by counting calls. The other thing worth pinning is that nothing is
 * asked about relations on an unmanaged machine.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionAccess, PolicyAccess, RelationAccess } from "@/types";

const policyAccess = vi.fn<(ids: string[]) => Promise<PolicyAccess>>();
const policyRelationAccess =
  vi.fn<
    (
      id: string,
      rels: { schema: string | null; name: string }[],
    ) => Promise<RelationAccess[]>
  >();

vi.mock("@/lib/tauri", () => ({
  api: {
    policyAccess: (ids: string[]) => policyAccess(ids),
    policyRelationAccess: (
      id: string,
      rels: { schema: string | null; name: string }[],
    ) => policyRelationAccess(id, rels),
  },
}));

import {
  relationKey,
  resetPolicyAccessForTests,
  usePolicyAccess,
} from "./policyAccess";

function conn(id: string, managed = true): ConnectionAccess {
  return {
    id,
    managed,
    visible: true,
    freeSql: false,
    verbs: ["select"],
    export: false,
    monitor: false,
    columns: { insert: null, update: null },
    reason: null,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  resetPolicyAccessForTests();
  policyAccess.mockReset();
  policyRelationAccess.mockReset();
});

describe("policyAccess store", () => {
  it("asks for every missing connection in one call", async () => {
    policyAccess.mockResolvedValue({
      state: "active",
      reason: null,
      connections: [conn("a"), conn("b")],
    });
    const { request } = usePolicyAccess.getState();
    request(["a"]);
    request(["b"]);
    request(["a"]);
    await flush();
    expect(policyAccess).toHaveBeenCalledTimes(1);
    expect(policyAccess).toHaveBeenCalledWith(["a", "b"]);
    expect(usePolicyAccess.getState().state).toBe("active");
    expect(usePolicyAccess.getState().connections.b?.verbs).toEqual(["select"]);

    // Cached: asking again costs nothing.
    request(["a", "b"]);
    await flush();
    expect(policyAccess).toHaveBeenCalledTimes(1);
  });

  it("asks for a listing's relations in one call per connection", async () => {
    usePolicyAccess.setState({ state: "active", connections: { a: conn("a") } });
    policyRelationAccess.mockImplementation(async (_id, rels) =>
      rels.map((r) => ({
        visible: r.name !== "payroll",
        verbs: r.name === "payroll" ? [] : ["select"],
        export: false,
        columns: { insert: null, update: null },
      })),
    );
    const { requestRelations } = usePolicyAccess.getState();
    requestRelations("a", [{ schema: null, name: "invoices" }]);
    requestRelations("a", [{ schema: null, name: "payroll" }]);
    await flush();
    expect(policyRelationAccess).toHaveBeenCalledTimes(1);
    const rels = usePolicyAccess.getState().relations;
    expect(rels[relationKey("a", null, "invoices")]?.visible).toBe(true);
    expect(rels[relationKey("a", null, "payroll")]?.visible).toBe(false);
  });

  it("asks nothing about relations the policy cannot narrow", async () => {
    const { requestRelations } = usePolicyAccess.getState();
    usePolicyAccess.setState({ state: "unmanaged" });
    requestRelations("a", [{ schema: null, name: "t" }]);
    usePolicyAccess.setState({
      state: "active",
      connections: { b: conn("b", false) },
    });
    requestRelations("b", [{ schema: null, name: "t" }]);
    await flush();
    expect(policyRelationAccess).not.toHaveBeenCalled();
  });

  it("drops an answer to a question asked before the policy changed", async () => {
    let answer!: (v: PolicyAccess) => void;
    policyAccess.mockReturnValueOnce(new Promise((r) => (answer = r)));
    policyAccess.mockResolvedValue({
      state: "broken",
      reason: "cannot read",
      connections: [{ ...conn("a"), visible: false }],
    });
    usePolicyAccess.getState().request(["a"]);
    await flush();
    usePolicyAccess.getState().invalidate();
    // The stale answer arrives after the invalidation…
    answer({ state: "active", reason: null, connections: [conn("a")] });
    await flush();
    // …and the fresh one wins.
    expect(policyAccess).toHaveBeenCalledTimes(2);
    expect(usePolicyAccess.getState().state).toBe("broken");
    expect(usePolicyAccess.getState().connections.a?.visible).toBe(false);
  });
});
