/**
 * The database-level capability predicates.
 *
 * Written for one bug and kept for the rule it encodes: `supportsDropDatabase`
 * used to *be* `supportsCreateDatabase`, so MongoDB — which cannot create an
 * empty database, because the server has no such thing — was also refused the
 * ability to drop a full one. The two answers only coincide by accident, and
 * these tests are what makes the next person merging them notice.
 */

import { describe, expect, it } from "vitest";

import {
  effectivePort,
  isForeignKeyViolation,
  requiresInitialCollection,
  supportsCreateDatabase,
  stoppedOutcome,
  supportsDropDatabase,
} from "@/lib/db/driver";
import type { Driver } from "@/types";

const DRIVERS: Driver[] = [
  "postgres",
  "mysql",
  "sqlite",
  "mongodb",
  "sqlserver",
];

describe("database-level capabilities", () => {
  it("offers create on every driver but SQLite", () => {
    for (const driver of DRIVERS) {
      expect(supportsCreateDatabase(driver)).toBe(driver !== "sqlite");
    }
  });

  it("offers drop on every driver but SQLite", () => {
    for (const driver of DRIVERS) {
      expect(supportsDropDatabase(driver)).toBe(driver !== "sqlite");
    }
  });

  it("asks for a first collection on MongoDB and nowhere else", () => {
    for (const driver of DRIVERS) {
      expect(requiresInitialCollection(driver)).toBe(driver === "mongodb");
    }
  });

  it("treats an unknown connection as incapable rather than capable", () => {
    // The profile is looked up by id and can legitimately be missing for a
    // frame; defaulting to "yes, offer DROP DATABASE" would be the wrong way
    // round to be wrong.
    expect(supportsCreateDatabase(undefined)).toBe(false);
    expect(supportsDropDatabase(undefined)).toBe(false);
    expect(requiresInitialCollection(undefined)).toBe(false);
  });
});

/**
 * A stored port of `0` is what the dialog writes when the field is left
 * blank, and what a `--port`-less CLI launch or an imported profile can
 * carry. Every surface that prints or compares a port has to read it as the
 * driver's default, the same way `ConnectionProfile::effective_port` does on
 * the backend — printing `db:0` would name a port nothing listens on.
 */
describe("effectivePort", () => {
  it("resolves a blank port to the driver's default", () => {
    expect(effectivePort("postgres", 0)).toBe(5432);
    expect(effectivePort("mysql", 0)).toBe(3306);
    expect(effectivePort("mongodb", 0)).toBe(27017);
    expect(effectivePort("sqlserver", 0)).toBe(1433);
  });

  it("never second-guesses a port the user typed", () => {
    expect(effectivePort("postgres", 6432)).toBe(6432);
    expect(effectivePort("sqlserver", 1450)).toBe(1450);
  });

  it("leaves SQLite at zero, having no server to default to", () => {
    expect(effectivePort("sqlite", 0)).toBe(0);
  });
});

describe("isForeignKeyViolation", () => {
  it("recognises each driver's wording for a still-referenced row", () => {
    const messages = [
      "database error: error returned from database: 1451 (23000): Cannot delete or update a parent row: a foreign key constraint fails (`db`.`child`, CONSTRAINT `fk` FOREIGN KEY (`pid`) REFERENCES `parent` (`id`))",
      'database error: error returned from database: update or delete on table "parent" violates foreign key constraint "child_pid_fkey" on table "child"',
      "database error: error returned from database: (code: 787) FOREIGN KEY constraint failed",
      "sql server error: Token error: 'The DELETE statement conflicted with the REFERENCE constraint \"FK_x\".'",
    ];
    for (const message of messages) {
      expect(isForeignKeyViolation(message)).toBe(true);
    }
  });

  it("leaves unrelated failures alone", () => {
    expect(isForeignKeyViolation("connection refused")).toBe(false);
    expect(isForeignKeyViolation(new Error("syntax error near 'WHERE'"))).toBe(
      false,
    );
  });
});

describe("stoppedOutcome", () => {
  // The exact shapes `AppError::Stopped` renders (src-tauri/src/error.rs).
  it("reads both outcomes the backend renders", () => {
    expect(
      stoppedOutcome("query stopped (not applied): The server was told to stop it."),
    ).toBe("not_applied");
    expect(
      stoppedOutcome("query stopped (may have applied): SQLite cannot stop a statement."),
    ).toBe("may_have_applied");
  });

  it("is null for anything that is not a stop", () => {
    expect(stoppedOutcome("database error: relation \"x\" does not exist")).toBeNull();
    expect(stoppedOutcome("the query stopped (not applied): quoted")).toBeNull();
    expect(stoppedOutcome("query stopped (someday): unknown marker")).toBeNull();
    expect(stoppedOutcome(undefined)).toBeNull();
  });
});
