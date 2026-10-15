import { describe, expect, it } from "vitest";
import type { ConnectionProfile } from "@/types";
import { mongoshTarget } from "./target";

const profile = (over: Partial<ConnectionProfile>): ConnectionProfile =>
  ({ id: "m", name: "Prod", driver: "mongodb", database: "", ...over }) as ConnectionProfile;

const profiles = [
  profile({ id: "m", name: "Prod" }),
  profile({ id: "m2", name: "Shop", database: "shop" }),
  profile({ id: "pg", name: "Billing", driver: "postgres" }),
];

describe("mongoshTarget", () => {
  it("explains why there is nothing to sign in as", () => {
    const active = new Set(["m", "pg"]);
    expect(mongoshTarget(null, null, profiles, active)).toEqual({ unavailable: "noConnection" });
    expect(mongoshTarget("gone", null, profiles, active)).toEqual({
      unavailable: "noConnection",
    });
    expect(mongoshTarget("pg", null, profiles, active)).toEqual({ unavailable: "notMongo" });
    expect(mongoshTarget("m2", null, profiles, active)).toEqual({
      unavailable: "notConnected",
    });
  });

  it("signs in as the top-level connection, never a per-database view", () => {
    const result = mongoshTarget("m::db::orders", null, profiles, new Set(["m"]));
    expect(result).toEqual({ target: { connectionId: "m", database: null, title: "Prod" } });
  });

  it("opens on the database the focused tab is pointed at", () => {
    expect(mongoshTarget("m", "m::db::orders", profiles, new Set(["m"]))).toEqual({
      target: { connectionId: "m", database: "orders", title: "Prod · orders" },
    });
  });

  it("ignores a focused tab that belongs to another connection", () => {
    expect(mongoshTarget("m2", "m::db::orders", profiles, new Set(["m2"]))).toEqual({
      target: { connectionId: "m2", database: null, title: "Shop · shop" },
    });
  });
});
