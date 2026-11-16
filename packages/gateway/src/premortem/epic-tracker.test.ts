import { describe, expect, test } from "bun:test";

import {
  EPIC_TRACKERS,
  type EpicAlias,
  JIRA_TRACKER,
  LINEAR_TRACKER,
  trackerForService,
} from "./epic-tracker.ts";

describe("epic tracker descriptors", () => {
  test("trackerForService maps the two covered services and nothing else", () => {
    expect(trackerForService("jira")).toBe(JIRA_TRACKER);
    expect(trackerForService("linear")).toBe(LINEAR_TRACKER);
    expect(trackerForService("asana")).toBeUndefined();
    expect(trackerForService("")).toBeUndefined();
    expect(EPIC_TRACKERS).toEqual([JIRA_TRACKER, LINEAR_TRACKER]);
  });

  test("every isEpicSql carries its own service test (the never-blend guarantee)", () => {
    expect(JIRA_TRACKER.isEpicSql("item")).toContain("item.service = 'jira'");
    expect(LINEAR_TRACKER.isEpicSql("item")).toContain("item.service = 'linear'");
  });

  test("Jira fragments", () => {
    expect(JIRA_TRACKER.isEpicSql("epic")).toBe(
      "epic.service = 'jira' AND json_valid(epic.metadata) AND json_extract(epic.metadata, '$.issue_type') = 'Epic'",
    );
    expect(JIRA_TRACKER.childOfSql("child", "epic")).toBe(
      "json_extract(child.metadata, '$.parent_key') = epic.external_id",
    );
    expect(JIRA_TRACKER.displayKeySql("item")).toBe("item.external_id");
  });

  test("Linear fragments read the project id from the epic ROW and never show the UUID", () => {
    expect(LINEAR_TRACKER.isEpicSql("item")).toBe(
      "item.service = 'linear' AND item.type = 'project'",
    );
    expect(LINEAR_TRACKER.childOfSql("child", "epic")).toBe(
      "child.type = 'issue' AND json_extract(child.metadata, '$.project_id') = epic.external_id",
    );
    expect(LINEAR_TRACKER.displayKeySql("item")).toContain("$.slug_id");
    expect(LINEAR_TRACKER.displayKeySql("item")).toContain("item.title");
    expect(LINEAR_TRACKER.displayKeySql("item")).not.toContain("external_id");
  });

  test("the alias is a closed union", () => {
    const ok: EpicAlias[] = ["item", "epic", "child"];
    expect(ok).toHaveLength(3);
    // @ts-expect-error a free-form alias is not accepted (I9: fragments take compile-time literals)
    JIRA_TRACKER.isEpicSql("x; DROP TABLE item");
    // @ts-expect-error the child alias is the literal "child"
    JIRA_TRACKER.childOfSql("epic", "epic");
  });
});
