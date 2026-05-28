import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { LocalIndex } from "../../../src/index/local-index.ts";
import { prunePeopleAfterServiceRemoval } from "../../../src/people/prune.ts";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
});

afterEach(() => {
  db.close();
});

function seedPersonAllHandles(id: string): void {
  db.run(
    `INSERT INTO person (
       id, display_name, canonical_email,
       github_login, gitlab_login, slack_handle, linear_member_id,
       jira_account_id, notion_user_id, bitbucket_uuid, discord_user_id
     ) VALUES (?, 'Test User', ?,
       'ghuser', 'gluser', '@slack', 'lin_123',
       'jira_456', 'notion_789', 'bb_uuid', 'discord_321')`,
    [id, `${id}@example.com`],
  );
}

function getPerson(id: string): Record<string, unknown> | null {
  return db.query("SELECT * FROM person WHERE id = ?").get(id) as Record<string, unknown> | null;
}

function seedReferencingItem(authorId: string | null, itemId: string): void {
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, modified_at, author_id, synced_at)
     VALUES (?, 'github', 'pr', ?, 'test', 1, ?, 1)`,
    [itemId, itemId, authorId],
  );
}

describe("prunePeopleAfterServiceRemoval — per-service handle clears", () => {
  const cases: Array<{ service: string; column: string }> = [
    { service: "github", column: "github_login" },
    { service: "gitlab", column: "gitlab_login" },
    { service: "slack", column: "slack_handle" },
    { service: "linear", column: "linear_member_id" },
    { service: "jira", column: "jira_account_id" },
    { service: "notion", column: "notion_user_id" },
    { service: "bitbucket", column: "bitbucket_uuid" },
    { service: "discord", column: "discord_user_id" },
  ];

  for (const { service, column } of cases) {
    test(`${service} → clears ${column}, preserves other handle columns`, () => {
      seedPersonAllHandles("p1");
      seedReferencingItem("p1", "github:pr_1");
      prunePeopleAfterServiceRemoval(db, service);
      const person = getPerson("p1");
      expect(person).not.toBeNull();
      expect(person?.[column]).toBeNull();
      for (const other of cases.filter((c) => c.column !== column)) {
        expect(person?.[other.column]).not.toBeNull();
      }
    });
  }
});

describe("prunePeopleAfterServiceRemoval — unknown service (default branch)", () => {
  test("does not touch any handle column", () => {
    seedPersonAllHandles("p1");
    seedReferencingItem("p1", "github:pr_1");
    prunePeopleAfterServiceRemoval(db, "made-up-service");
    const person = getPerson("p1");
    expect(person?.["github_login"]).toBe("ghuser");
    expect(person?.["gitlab_login"]).toBe("gluser");
    expect(person?.["slack_handle"]).toBe("@slack");
    expect(person?.["linear_member_id"]).toBe("lin_123");
  });
});

describe("prunePeopleAfterServiceRemoval — orphan delete", () => {
  test("deletes person rows no longer referenced by any item.author_id", () => {
    seedPersonAllHandles("orphan");
    seedPersonAllHandles("kept");
    seedReferencingItem("kept", "github:pr_1");
    prunePeopleAfterServiceRemoval(db, "github");
    expect(getPerson("kept")).not.toBeNull();
    expect(getPerson("orphan")).toBeNull();
  });

  test("preserves person rows referenced by NULL-author items (no false-positive delete)", () => {
    seedPersonAllHandles("kept");
    seedReferencingItem(null, "github:pr_null");
    seedReferencingItem("kept", "github:pr_1");
    prunePeopleAfterServiceRemoval(db, "github");
    expect(getPerson("kept")).not.toBeNull();
  });

  test("default branch still runs the orphan delete", () => {
    seedPersonAllHandles("orphan");
    prunePeopleAfterServiceRemoval(db, "unknown-service");
    expect(getPerson("orphan")).toBeNull();
  });
});
