import { describe, expect, test } from "bun:test";

import { openMemoryIndexDatabase } from "../testing/bun-test-support.ts";
import {
  listWorkSnapshot,
  replaceWorkSnapshotRows,
  type WorkSnapshotRelation,
} from "./work-snapshot-store.ts";

function seed(db: ReturnType<typeof openMemoryIndexDatabase>, service: string, ext: string): string {
  const id = `${service}:${ext}`;
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
     VALUES (?, ?, 'issue', ?, 't', 1, 1)`,
    [id, service, ext],
  );
  return id;
}

describe("work snapshot store", () => {
  test("stores only resolvable ids and reports stored and dropped", () => {
    const db = openMemoryIndexDatabase();
    try {
      const a = seed(db, "jira", "A-1");
      const res = replaceWorkSnapshotRows(db, "jira", "assigned", ["A-1", "MISSING"], 100);
      expect(res).toEqual({ stored: 1, dropped: 1 });
      expect(listWorkSnapshot(db, "jira", "assigned")).toEqual([{ itemId: a, capturedAt: 100 }]);
    } finally {
      db.close();
    }
  });

  test("a second call replaces its own set only", () => {
    const db = openMemoryIndexDatabase();
    try {
      const a = seed(db, "github", "o/r#1");
      const b = seed(db, "github", "o/r#2");
      const j = seed(db, "jira", "J-1");
      replaceWorkSnapshotRows(db, "github", "assigned", ["o/r#1", "o/r#2"], 1);
      replaceWorkSnapshotRows(db, "github", "authored_open", ["o/r#1"], 1);
      replaceWorkSnapshotRows(db, "jira", "assigned", ["J-1"], 1);
      replaceWorkSnapshotRows(db, "github", "assigned", ["o/r#2"], 2);
      expect(listWorkSnapshot(db, "github", "assigned")).toEqual([{ itemId: b, capturedAt: 2 }]);
      expect(listWorkSnapshot(db, "github", "authored_open")).toEqual([{ itemId: a, capturedAt: 1 }]);
      expect(listWorkSnapshot(db, "jira", "assigned")).toEqual([{ itemId: j, capturedAt: 1 }]);
    } finally {
      db.close();
    }
  });

  test("an empty list clears the set; a duplicate id stores once", () => {
    const db = openMemoryIndexDatabase();
    try {
      seed(db, "linear", "ENG-1");
      expect(replaceWorkSnapshotRows(db, "linear", "assigned", ["ENG-1", "ENG-1"], 1).stored).toBe(1);
      expect(listWorkSnapshot(db, "linear", "assigned")).toHaveLength(1);
      expect(replaceWorkSnapshotRows(db, "linear", "assigned", [], 2)).toEqual({
        stored: 0,
        dropped: 0,
      });
      expect(listWorkSnapshot(db, "linear", "assigned")).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  test("refuses a service outside the three, a bad relation and an oversized list", () => {
    const db = openMemoryIndexDatabase();
    try {
      expect(() => replaceWorkSnapshotRows(db, "slack", "assigned", [], 1)).toThrow(/slack/);
      expect(() =>
        replaceWorkSnapshotRows(db, "jira", "bogus" as unknown as WorkSnapshotRelation, [], 1),
      ).toThrow(/relation/);
      const many = Array.from({ length: 1001 }, (_, i) => `K-${String(i)}`);
      expect(() => replaceWorkSnapshotRows(db, "jira", "assigned", many, 1)).toThrow(/1000/);
    } finally {
      db.close();
    }
  });

  test("a failure mid-way leaves the previous set intact", () => {
    const db = openMemoryIndexDatabase();
    try {
      const a = seed(db, "jira", "A-1");
      replaceWorkSnapshotRows(db, "jira", "assigned", ["A-1"], 1);
      // NaN binds as NULL, so the INSERT fails (NOT NULL) after the DELETE already ran.
      expect(() =>
        replaceWorkSnapshotRows(db, "jira", "assigned", ["A-1"], Number.NaN as unknown as number),
      ).toThrow();
      expect(listWorkSnapshot(db, "jira", "assigned")).toEqual([{ itemId: a, capturedAt: 1 }]);
    } finally {
      db.close();
    }
  });
});
