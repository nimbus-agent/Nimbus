import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { syncGraphFromIndexedItem } from "../../../src/graph/graph-populator.ts";
import { runIndexedSchemaMigrations } from "../../../src/index/migrations/runner.ts";

describe("graph-populator: pr → commit merged_as edge", () => {
  it("emits a merged_as relation from PR entity to commit entity on merge", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 27);
    const now = Date.now();
    syncGraphFromIndexedItem(db, {
      id: "nimbus-agent/payments#42",
      service: "github",
      type: "pr",
      title: "Add retry logic",
      bodyPreview: null,
      authorId: null,
      metadata: {
        repo: "nimbus-agent/payments",
        merged: true,
        merged_at: now,
        merge_commit_sha: "abc123",
      },
    });
    const rows = db
      .query(
        `SELECT r.type AS name FROM graph_relation r
         JOIN graph_entity src ON src.id = r.from_id
         JOIN graph_entity dst ON dst.id = r.to_id
         WHERE src.type = 'pr' AND dst.type = 'commit' AND r.type = 'merged_as'`,
      )
      .all() as Array<{ name: string }>;
    expect(rows).toHaveLength(1);
    db.close();
  });

  it("emits no merged_as edge when PR is not merged", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 27);
    syncGraphFromIndexedItem(db, {
      id: "nimbus-agent/payments#7",
      service: "github",
      type: "pr",
      title: "WIP",
      bodyPreview: null,
      authorId: null,
      metadata: { repo: "nimbus-agent/payments", merged: false },
    });
    const rows = db
      .query(
        `SELECT 1 FROM graph_relation r
         WHERE r.type = 'merged_as'`,
      )
      .all();
    expect(rows).toHaveLength(0);
    db.close();
  });

  it("emits no merged_as edge when merge_commit_sha is missing", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 27);
    syncGraphFromIndexedItem(db, {
      id: "nimbus-agent/payments#8",
      service: "github",
      type: "pr",
      title: "Squash-merge with no SHA echoed back",
      bodyPreview: null,
      authorId: null,
      metadata: { repo: "nimbus-agent/payments", merged: true },
    });
    const rows = db
      .query(
        `SELECT 1 FROM graph_relation r
         WHERE r.type = 'merged_as'`,
      )
      .all();
    expect(rows).toHaveLength(0);
    db.close();
  });
});
