import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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

  test("a refused file is reported to onFile, and retried only when its bytes change", () => {
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
    expect(seen).toEqual(["refused"]);
    writeFileSync(join(dir, "bad.csv"), csv("2"));
    pass();
    expect(seen).toEqual(["refused", "imported"]);
  });

  test("an older file that changes re-imports the whole folder oldest first: the newest export stands", () => {
    const day = (d: number) => new Date(Date.UTC(2026, 10, d));
    const a = join(dir, "a.csv");
    const b = join(dir, "b.csv");
    writeFileSync(a, csv("3"));
    writeFileSync(b, csv("4"));
    utimesSync(a, day(1), day(1));
    utimesSync(b, day(2), day(2));
    const pass = createCostFolderPass({ db, dir: () => dir, now: Date.now });
    expect(pass().map((f) => f.name)).toEqual(["a.csv", "b.csv"]);
    expect(total()).toBe(4);
    writeFileSync(a, csv("5"));
    utimesSync(a, day(1), day(1));
    expect(pass().map((f) => [f.name, f.status])).toEqual([
      ["a.csv", "imported"],
      ["b.csv", "imported"],
    ]);
    expect(total()).toBe(4);
    expect(pass()).toEqual([]);
    // A restart (a new pass, an empty memory) ends in the same state.
    const restarted = createCostFolderPass({ db, dir: () => dir, now: Date.now });
    restarted();
    expect(total()).toBe(4);
  });

  test("a file above the import cap is refused without being read, once", () => {
    const seen: (string | undefined)[] = [];
    const pass = createCostFolderPass({
      db,
      dir: () => dir,
      now: Date.now,
      maxBytes: 16,
      onFile: (f) => seen.push(f.error),
    });
    writeFileSync(join(dir, "big.csv"), csv("1"));
    pass();
    pass();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("larger than the import cap of 16 bytes");
  });
});
