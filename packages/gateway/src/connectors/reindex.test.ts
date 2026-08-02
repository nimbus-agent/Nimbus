import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { LocalIndex } from "../index/local-index.ts";
import { reindexConnector } from "./reindex.ts";

function seed(idx: LocalIndex, service: string, withBody: string | null): void {
  idx.rawDb.run(
    `INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at, pinned)
     VALUES (?, ?, 'test', ?, 't', ?, ?, ?, 0)`,
    [`${service}-1`, service, `${service}-1`, withBody, Date.now(), Date.now()],
  );
}

function makeIdx(): LocalIndex {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return new LocalIndex(db);
}

describe("connector reindex", () => {
  test("shallow prunes body and writes data.minimization.prune audit entry", async () => {
    const idx = makeIdx();
    seed(idx, "github", "full body content here");
    const result = await reindexConnector({
      index: idx,
      service: "github",
      depth: "metadata_only",
    });
    expect(result.itemsAffected).toBe(1);
    const row = idx.rawDb.query(`SELECT body_preview FROM item WHERE service = 'github'`).get() as {
      body_preview: string | null;
    };
    expect(row.body_preview).toBeNull();
    const audit = idx.listAuditWithChain(10);
    expect(audit.some((r) => r.actionType === "data.minimization.prune")).toBe(true);
  });

  test("deepen leaves existing rows in place and does not write a prune audit entry", async () => {
    const idx = makeIdx();
    seed(idx, "github", null);
    const result = await reindexConnector({ index: idx, service: "github", depth: "full" });
    expect(result.itemsAffected).toBe(0);
    const audit = idx.listAuditWithChain(10);
    expect(audit.some((r) => r.actionType === "data.minimization.prune")).toBe(false);
  });

  test("metadata_only with zero matching items writes no prune audit entry", async () => {
    const idx = makeIdx();
    // No items at all for this service — the WHERE clause matches nothing.
    const result = await reindexConnector({
      index: idx,
      service: "nonexistent-service",
      depth: "metadata_only",
    });
    expect(result.itemsAffected).toBe(0);
    const audit = idx.listAuditWithChain(10);
    expect(audit.some((r) => r.actionType === "data.minimization.prune")).toBe(false);
  });
});
