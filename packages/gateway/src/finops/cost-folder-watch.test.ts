import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { createCostFolderPass } from "./cost-folder-watch.ts";

const HEADER =
  "BilledCost,BillingAccountId,BillingCurrency,BillingPeriodStart,ChargePeriodStart,ProviderName,ServiceName";
const csv = (cost: string): string =>
  `${HEADER}\n${cost},111,USD,2026-11-01T00:00:00Z,2026-11-01T00:00:00Z,AWS,Amazon S3\n`;

let db: Database;
let dir: string;
beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  dir = mkdtempSync(join(tmpdir(), "nimbus-cost-watch-"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const total = (): number =>
  (db.query("SELECT TOTAL(billed_cost) AS s FROM cost_line").get() as { s: number }).s;

describe("createCostFolderPass", () => {
  test("imports new files, skips unchanged ones, re-imports a changed one", () => {
    let now = Date.UTC(2026, 10, 26);
    const pass = createCostFolderPass({ db, dir: () => dir, now: () => now });
    writeFileSync(join(dir, "a.csv"), csv("3"));
    expect(pass().map((f) => f.name)).toEqual(["a.csv"]);
    expect(total()).toBe(3);
    now += 86_400_000;
    expect(pass()).toEqual([]);
    writeFileSync(join(dir, "a.csv"), csv("4"));
    writeFileSync(join(dir, "b.txt"), "ignored");
    expect(pass().map((f) => [f.name, f.replaced])).toEqual([["a.csv", 1]]);
    expect(total()).toBe(4);
  });

  test("no folder configured and an empty folder are quiet no-ops", () => {
    const failures: unknown[] = [];
    expect(createCostFolderPass({ db, dir: () => null, now: Date.now })()).toEqual([]);
    const pass = createCostFolderPass({
      db,
      dir: () => dir,
      now: Date.now,
      onFailure: (e) => failures.push(e),
    });
    expect(pass()).toEqual([]);
    expect(failures).toEqual([]);
  });

  test("a missing folder reports a failure and never throws", () => {
    const failures: unknown[] = [];
    const pass = createCostFolderPass({
      db,
      dir: () => join(dir, "gone"),
      now: Date.now,
      onFailure: (e) => failures.push(e),
    });
    expect(pass()).toEqual([]);
    expect(failures).toHaveLength(1);
  });

  test("a refused file is reported to onFile and retried next pass", () => {
    const seen: string[] = [];
    const pass = createCostFolderPass({
      db,
      dir: () => dir,
      now: Date.now,
      onFile: (f) => seen.push(f.status),
    });
    writeFileSync(join(dir, "bad.csv"), "x,y\n1,2\n");
    pass();
    pass();
    expect(seen).toEqual(["refused", "refused"]);
  });
});
