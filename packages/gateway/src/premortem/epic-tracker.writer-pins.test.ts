import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { LocalIndex } from "../index/local-index.ts";
import { childCountsFor } from "./cohort.ts";
import { type EPIC_TRACKERS, JIRA_TRACKER, LINEAR_TRACKER } from "./epic-tracker.ts";
import { seedJiraViaSync, seedLinearViaSync } from "./tracker-writers.test-helpers.ts";

function makeDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

function epicIds(db: Database, tracker: (typeof EPIC_TRACKERS)[number]): string[] {
  return (
    db
      .query(`SELECT item.id AS id FROM item WHERE ${tracker.isEpicSql("item")} ORDER BY item.id`)
      .all() as Array<{ id: string }>
  ).map((r) => r.id);
}

function childIds(db: Database, tracker: (typeof EPIC_TRACKERS)[number]): string[] {
  return (
    db
      .query(
        `SELECT child.id AS id FROM item epic JOIN item child ON json_valid(child.metadata) AND ${tracker.childOfSql("child", "epic")} AND child.service = epic.service AND child.id <> epic.id ORDER BY child.id`,
      )
      .all() as Array<{ id: string }>
  ).map((r) => r.id);
}

describe("epic tracker descriptors against the REAL writers", () => {
  test("Jira: isEpicSql selects the epic only; childOfSql joins the parent_key child", async () => {
    const db = makeDb();
    await seedJiraViaSync(db, {
      epics: [{ key: "PROJ-1" }],
      children: [{ key: "PROJ-2", parentKey: "PROJ-1" }],
    });
    expect(epicIds(db, JIRA_TRACKER)).toEqual(["jira:PROJ-1"]);
    expect(childIds(db, JIRA_TRACKER)).toEqual(["jira:PROJ-2"]);
    expect(childCountsFor(db, ["jira:PROJ-1"]).get("jira:PROJ-1")).toBe(1);
    db.close();
  });

  test("Linear: isEpicSql selects the project only; childOfSql joins the project_id issue", async () => {
    const db = makeDb();
    await seedLinearViaSync(db, {
      projects: [{ id: "proj-uuid-1", name: "Payments", slugId: "abc123def456" }],
      issues: [
        { identifier: "ENG-1", projectId: "proj-uuid-1" },
        { identifier: "ENG-2", projectId: "other-project" },
        { identifier: "ENG-3", projectId: null },
      ],
    });
    expect(epicIds(db, LINEAR_TRACKER)).toEqual(["linear:proj-uuid-1"]);
    expect(childIds(db, LINEAR_TRACKER)).toEqual(["linear:ENG-1"]);
    expect(childCountsFor(db, ["linear:proj-uuid-1"]).get("linear:proj-uuid-1")).toBe(1);
    const display = db
      .query(`SELECT ${LINEAR_TRACKER.displayKeySql("item")} AS k FROM item WHERE type = 'project'`)
      .get() as { k: string };
    expect(display.k).toBe("abc123def456");
    db.close();
  });

  test("a Linear issue wearing Jira epic metadata is neither tracker's epic", async () => {
    const db = makeDb();
    await seedLinearViaSync(db, {
      projects: [],
      issues: [{ identifier: "ENG-9", projectId: null }],
    });
    db.run(
      `UPDATE item SET metadata = json_set(metadata, '$.issue_type', 'Epic') WHERE external_id = 'ENG-9'`,
    );
    expect(epicIds(db, JIRA_TRACKER)).toEqual([]);
    expect(epicIds(db, LINEAR_TRACKER)).toEqual([]);
    db.close();
  });

  test("the metadata keys named in epic-tracker.ts appear in each writer's source", () => {
    const here = import.meta.dirname;
    const read = (rel: string): string => readFileSync(path.join(here, rel), "utf8");
    const jira = read("../connectors/jira-sync.ts");
    const linearSync = read("../connectors/linear-sync.ts");
    const linearProjects = read("../connectors/linear-projects.ts");
    expect(jira).toContain('"issue_type"');
    expect(jira).toContain('"parent_key"');
    expect(linearSync).toContain('"project_id"');
    expect(linearProjects).toContain('"slug_id"');
    const tracker = read("epic-tracker.ts");
    for (const key of ["issue_type", "parent_key", "project_id", "slug_id"]) {
      expect(tracker).toContain(`$.${key}`);
    }
  });
});
