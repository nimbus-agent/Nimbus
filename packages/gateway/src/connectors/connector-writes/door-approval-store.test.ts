import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import {
  getDoorApproval,
  listDoorApprovals,
  markDoorToolSuspended,
  removeDoorApprovals,
  replaceDoorApprovals,
  upsertDoorApprovals,
} from "./door-approval-store.ts";

const H1 = "1".repeat(64);
const H2 = "2".repeat(64);
const H3 = "3".repeat(64);

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 97);
});
afterEach(() => db.close());

describe("door approval store", () => {
  test("replace keeps only the given set for that service and leaves other services alone", () => {
    replaceDoorApprovals(db, "agent", "github", [{ toolId: "a", definitionSha256: H1 }], 10);
    replaceDoorApprovals(db, "agent", "slack", [{ toolId: "s", definitionSha256: H1 }], 10);
    replaceDoorApprovals(db, "agent", "github", [{ toolId: "b", definitionSha256: H2 }], 20);
    expect(listDoorApprovals(db, "agent", "github").map((r) => r.toolId)).toEqual(["b"]);
    expect(listDoorApprovals(db, "agent", "slack").map((r) => r.toolId)).toEqual(["s"]);
    expect(getDoorApproval(db, "agent", "github", "b")).toEqual({
      service: "github",
      door: "agent",
      toolId: "b",
      approvedAt: 20,
      definitionSha256: H2,
      suspendedAt: null,
      suspendedSha256: null,
    });
  });

  test("replace with an empty set removes the service's approvals", () => {
    replaceDoorApprovals(db, "agent", "github", [{ toolId: "a", definitionSha256: H1 }], 10);
    replaceDoorApprovals(db, "agent", "github", [], 11);
    expect(listDoorApprovals(db, "agent", "github")).toEqual([]);
  });

  test("upsert keeps other rows, replaces the hash and the time, and clears a suspension", () => {
    replaceDoorApprovals(
      db,
      "agent",
      "github",
      [
        { toolId: "a", definitionSha256: H1 },
        { toolId: "b", definitionSha256: H1 },
      ],
      10,
    );
    expect(markDoorToolSuspended(db, "agent", "github", "a", H3, 15)).toBe(true);
    upsertDoorApprovals(db, "agent", "github", [{ toolId: "a", definitionSha256: H2 }], 30);
    expect(getDoorApproval(db, "agent", "github", "a")).toMatchObject({
      approvedAt: 30,
      definitionSha256: H2,
      suspendedAt: null,
      suspendedSha256: null,
    });
    expect(getDoorApproval(db, "agent", "github", "b")?.approvedAt).toBe(10);
  });

  test("markDoorToolSuspended is true once; a second observation with another hash is a no-op and the first hash stays", () => {
    replaceDoorApprovals(db, "agent", "github", [{ toolId: "a", definitionSha256: H1 }], 10);
    expect(markDoorToolSuspended(db, "agent", "github", "a", H2, 11)).toBe(true);
    expect(markDoorToolSuspended(db, "agent", "github", "a", H3, 12)).toBe(false);
    expect(getDoorApproval(db, "agent", "github", "a")).toMatchObject({
      suspendedAt: 11,
      suspendedSha256: H2,
    });
  });

  test("a null observed hash marks the row with a NULL suspended_sha256", () => {
    replaceDoorApprovals(db, "agent", "github", [{ toolId: "a", definitionSha256: H1 }], 10);
    expect(markDoorToolSuspended(db, "agent", "github", "a", null, 11)).toBe(true);
    expect(getDoorApproval(db, "agent", "github", "a")).toMatchObject({
      suspendedAt: 11,
      suspendedSha256: null,
    });
  });

  test("marking a tool that has no approval changes nothing", () => {
    expect(markDoorToolSuspended(db, "agent", "github", "ghost", H2, 11)).toBe(false);
    expect(listDoorApprovals(db, "agent")).toEqual([]);
  });

  test("remove by service and by door; the count is the rows removed", () => {
    replaceDoorApprovals(db, "agent", "github", [{ toolId: "a", definitionSha256: H1 }], 10);
    replaceDoorApprovals(db, "agent", "slack", [{ toolId: "s", definitionSha256: H1 }], 10);
    expect(removeDoorApprovals(db, "github")).toBe(1);
    expect(removeDoorApprovals(db, "github")).toBe(0);
    expect(removeDoorApprovals(db, "slack", "agent")).toBe(1);
    expect(listDoorApprovals(db, "agent")).toEqual([]);
  });

  test("a list is sorted by service then tool id", () => {
    replaceDoorApprovals(
      db,
      "agent",
      "slack",
      [
        { toolId: "z", definitionSha256: H1 },
        { toolId: "m", definitionSha256: H1 },
      ],
      1,
    );
    replaceDoorApprovals(
      db,
      "agent",
      "github",
      [
        { toolId: "q", definitionSha256: H1 },
        { toolId: "b", definitionSha256: H1 },
      ],
      1,
    );
    expect(listDoorApprovals(db, "agent").map((r) => `${r.service}/${r.toolId}`)).toEqual([
      "github/b",
      "github/q",
      "slack/m",
      "slack/z",
    ]);
  });

  test("a failure while inserting rolls the replace back (the old set survives)", () => {
    replaceDoorApprovals(db, "agent", "github", [{ toolId: "a", definitionSha256: H1 }], 10);
    expect(() =>
      replaceDoorApprovals(
        db,
        "agent",
        "github",
        [
          { toolId: "b", definitionSha256: H2 },
          { toolId: "c", definitionSha256: "short" },
        ],
        20,
      ),
    ).toThrow();
    expect(listDoorApprovals(db, "agent", "github").map((r) => r.toolId)).toEqual(["a"]);
  });
});
