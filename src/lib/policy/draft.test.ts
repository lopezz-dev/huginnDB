import { describe, expect, it } from "vitest";
import {
  addRole,
  canRemoveRole,
  duplicateUsers,
  expandDbUser,
  formatDraft,
  normaliseUser,
  parseDraft,
  removeRole,
  renameRole,
  roleOf,
  setUser,
  summarizeChanges,
  templatePolicy,
  type PolicyJson,
} from "./draft";

const doc: PolicyJson = {
  version: 1,
  defaultRole: "none",
  users: { "ACME\\ana": "sales", bob: "sales" },
  roles: {
    none: {},
    sales: { rules: [{ endpoint: "*", human: ["select"], ai: ["select"] }] },
  },
  unmanagedConnections: "deny",
  // A field this version does not model rides along untouched.
  futureField: { keep: true },
};

describe("policy draft", () => {
  it("round-trips text without losing fields or key order", () => {
    const text = formatDraft(doc);
    const parsed = parseDraft(text);
    expect(parsed.ok && formatDraft(parsed.doc)).toBe(text);
    expect(Object.keys(doc)).toEqual(Object.keys(parsed.ok ? parsed.doc : {}));
  });

  it("says why text is not a JSON object", () => {
    expect(parseDraft("{ nope").ok).toBe(false);
    expect(parseDraft("[1]")).toEqual({ ok: false, error: "the policy must be a JSON object" });
  });

  it("renames a role together with its users and the default", () => {
    const renamed = renameRole({ ...doc, defaultRole: "sales" }, "sales", "ventas");
    expect(Object.keys(renamed.roles!)).toEqual(["none", "ventas"]);
    expect(renamed.users).toEqual({ "ACME\\ana": "ventas", bob: "ventas" });
    expect(renamed.defaultRole).toBe("ventas");
    // Onto an existing role: refused, the document is unchanged.
    expect(renameRole(doc, "sales", "none")).toBe(doc);
  });

  it("refuses to remove a role someone still depends on", () => {
    expect(canRemoveRole(doc, "sales")).toBe(false);
    expect(canRemoveRole(doc, "none")).toBe(false);
    const withSpare = addRole(doc, "spare");
    expect(Object.keys(removeRole(withSpare, "spare").roles!)).toEqual(["none", "sales"]);
  });

  it("finds accounts that are one once domain and case are ignored", () => {
    const dupes = duplicateUsers(setUser(doc, "ANA", "none"));
    expect([...dupes].sort()).toEqual(["ACME\\ana", "ANA"]);
  });

  it("expands dbUser the way the backend does", () => {
    expect(normaliseUser("ACME\\ALopez")).toBe("alopez");
    expect(expandDbUser("erp_{user}", "ACME\\ALopez")).toBe("erp_alopez");
    expect(roleOf(doc, "acme\\BOB")).toBe("sales");
    expect(roleOf(doc, "carla")).toBe("none");
  });

  it("summarises what a save changes, dbUser included", () => {
    const after = setUser(
      {
        ...doc,
        roles: {
          ...doc.roles,
          sales: {
            rules: [{ endpoint: "*", human: ["select"], ai: ["select"], dbUser: "{user}" }],
          },
        },
      },
      "bob",
      "none",
    );
    const c = summarizeChanges(doc, after);
    expect(c.rulesChanged).toEqual(["sales"]);
    expect(c.usersMoved).toEqual([{ user: "bob", from: "sales", to: "none" }]);
    expect(c.dbUserIntroduced).toBe(true);
    expect(c.columnsIntroduced).toBe(false);
    expect(c.rolesAdded).toEqual([]);
    // Column limits break older versions the same way.
    const limited: PolicyJson = {
      ...after,
      roles: {
        ...after.roles,
        sales: { rules: [{ endpoint: "*", human: ["update"], columns: { update: ["estado"] } }] },
      },
    };
    expect(summarizeChanges(after, limited).columnsIntroduced).toBe(true);
    expect(summarizeChanges(limited, limited).columnsIntroduced).toBe(false);
  });

  it("starts a new policy with its author able to do everything", () => {
    const t = templatePolicy("ACME\\alopez");
    expect(roleOf(t, "alopez")).toBe("admin");
    expect(roleOf(t, "someone")).toBe("none");
    expect(t.unmanagedConnections).toBe("deny");
  });
});
