import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIndexedSchemaMigrations } from "../../../src/index/migrations/runner.ts";

describe("V27 migration — merged_as graph_relation_type", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nimbus-v27-"));
  });
  afterEach(() => {
    try {
      // maxRetries: 0 / retryDelay: 0 — a pinned handle must fail FAST rather than block
      // the hook's timeout budget; a leaked temp dir is the accepted trade-off (#972,
      // #973). Do NOT turn this back into a blocking retry.
      rmSync(dir, { recursive: true, force: true, maxRetries: 0, retryDelay: 0 });
    } catch {
      /* non-fatal */
    }
  });

  it("seeds the merged_as relation type idempotently", () => {
    const db = new Database(join(dir, "nimbus.db"));
    runIndexedSchemaMigrations(db, 27);
    const row = db
      .query("SELECT name, directed FROM graph_relation_type WHERE name = 'merged_as'")
      .get() as { name: string; directed: number } | undefined;
    expect(row).toBeDefined();
    expect(row?.directed).toBe(1);
    db.close();
  });

  it("does not fail when applied to a DB already at V27 (idempotency)", () => {
    const dbPath = join(dir, "nimbus.db");
    const db1 = new Database(dbPath);
    runIndexedSchemaMigrations(db1, 27);
    db1.close();

    const db2 = new Database(dbPath);
    runIndexedSchemaMigrations(db2, 27);
    const row = db2
      .query("SELECT name, directed FROM graph_relation_type WHERE name = 'merged_as'")
      .get() as { name: string; directed: number } | undefined;
    expect(row).toBeDefined();
    expect(row?.directed).toBe(1);
    db2.close();
  });
});
