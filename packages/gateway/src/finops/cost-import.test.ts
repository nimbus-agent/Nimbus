import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { CostImportError, importFocusPath, removeCostImport } from "./cost-import.ts";
import { readCostLines } from "./cost-line-store.ts";

const FIXTURES = join(import.meta.dir, "__fixtures__", "focus");
const HEADER =
  "BilledCost,BillingAccountId,BillingCurrency,BillingPeriodStart,ChargePeriodStart,ProviderName,ServiceName";
const NOW = () => Date.UTC(2026, 10, 26);

function mtd(lastDay: number, cost = "1"): string {
  const rows = [HEADER];
  for (let d = 1; d <= lastDay; d++) {
    const day = `2026-11-${String(d).padStart(2, "0")}`;
    rows.push(`${cost},111,USD,2026-11-01T00:00:00Z,${day}T00:00:00Z,AWS,Amazon S3`);
  }
  return `${rows.join("\n")}\n`;
}

let db: Database;
let dir: string;
beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  dir = mkdtempSync(join(tmpdir(), "nimbus-cost-import-"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const count = (): number =>
  (db.query("SELECT COUNT(*) AS n FROM cost_line").get() as { n: number }).n;

describe("importFocusPath", () => {
  test("a directory imports every *.csv (not recursive); per-file totals equal the lines", () => {
    for (const f of ["aws.csv", "azure.csv", "gcp.csv"])
      copyFileSync(join(FIXTURES, f), join(dir, f));
    writeFileSync(join(dir, "notes.txt"), "not a csv");
    mkdirSync(join(dir, "nested"));
    copyFileSync(join(FIXTURES, "quoted.csv"), join(dir, "nested", "quoted.csv"));
    const r = importFocusPath(db, dir, { dryRun: false, now: NOW });
    expect(r.files.map((f) => f.name)).toEqual(["aws.csv", "azure.csv", "gcp.csv"]);
    expect(r.files.every((f) => f.status === "imported")).toBe(true);
    const aws = r.files[0];
    expect(aws?.totals).toEqual({ USD: 50 });
    expect(aws?.lines).toBe(3);
    expect(aws?.importId).toMatch(/^focus:[0-9a-f]{16}$/);
    expect(r.files[1]?.totals).toEqual({ EUR: 30 });
    const stored = readCostLines(db, { fromDay: "2026-11-01", toDay: "2026-11-30" });
    const usd = stored.filter((l) => l.currency === "USD").reduce((a, l) => a + l.billedCost, 0);
    expect(usd).toBe(58);
    expect(count()).toBe(5);
  });

  test("--dry-run writes nothing but reports what would change", () => {
    const p = join(dir, "a.csv");
    writeFileSync(p, mtd(3));
    const r = importFocusPath(db, p, { dryRun: true, now: NOW });
    expect(r.dryRun).toBe(true);
    expect(r.files[0]).toMatchObject({ status: "dry_run", inserted: 3, lines: 3 });
    expect(count()).toBe(0);
  });

  test("a second identical run reports no net change", () => {
    const p = join(dir, "a.csv");
    writeFileSync(p, mtd(5));
    importFocusPath(db, p, { dryRun: false, now: NOW });
    const again = importFocusPath(db, p, { dryRun: false, now: NOW });
    expect(again.files[0]).toMatchObject({ inserted: 0, replaced: 0, removed: 0, unchanged: 5 });
    expect(count()).toBe(5);
  });

  test("a month-to-date file that grew is replaced on its days; a restated day is counted", () => {
    const p = join(dir, "a.csv");
    writeFileSync(p, mtd(19));
    importFocusPath(db, p, { dryRun: false, now: NOW });
    writeFileSync(p, mtd(20, "2"));
    const r = importFocusPath(db, p, { dryRun: false, now: NOW });
    expect(r.files[0]).toMatchObject({ inserted: 1, replaced: 19, unchanged: 0 });
    expect(count()).toBe(20);
  });

  test("files in a directory import oldest first, so the newest export wins an overlap", () => {
    const older = join(dir, "z-old.csv");
    const newer = join(dir, "a-new.csv");
    writeFileSync(older, mtd(2, "1"));
    writeFileSync(newer, mtd(2, "5"));
    utimesSync(older, new Date(Date.UTC(2026, 10, 1)), new Date(Date.UTC(2026, 10, 1)));
    utimesSync(newer, new Date(Date.UTC(2026, 10, 2)), new Date(Date.UTC(2026, 10, 2)));
    const r = importFocusPath(db, dir, { dryRun: false, now: NOW });
    expect(r.files.map((f) => f.name)).toEqual(["z-old.csv", "a-new.csv"]);
    const sum = readCostLines(db, { fromDay: "2026-11-01", toDay: "2026-11-02" }).reduce(
      (a, l) => a + l.billedCost,
      0,
    );
    expect(sum).toBe(10);
  });

  test("a file that is not a FOCUS export is refused on its own; the others still import", () => {
    writeFileSync(join(dir, "a.csv"), mtd(1));
    writeFileSync(join(dir, "b.csv"), "x,y\n1,2\n");
    const r = importFocusPath(db, dir, { dryRun: false, now: NOW });
    expect(r.files.map((f) => f.status)).toEqual(["imported", "refused"]);
    expect(r.files[1]?.error).toContain("missing required column");
    expect(count()).toBe(1);
  });

  test("invalid UTF-8 is refused", () => {
    const p = join(dir, "a.csv");
    writeFileSync(p, Buffer.from([0x42, 0x69, 0xff, 0xfe, 0x0a]));
    const r = importFocusPath(db, p, { dryRun: false, now: NOW });
    expect(r.files[0]?.status).toBe("refused");
    expect(r.files[0]?.error).toContain("UTF-8");
  });

  test("a file over the size cap is refused with the cap stated", () => {
    const p = join(dir, "a.csv");
    writeFileSync(p, mtd(2));
    const r = importFocusPath(db, p, { dryRun: false, now: NOW, maxBytes: 10 });
    expect(r.files[0]?.status).toBe("refused");
    expect(r.files[0]?.error).toContain("larger than");
  });

  test("a relative path, a missing path and an empty directory are errors", () => {
    expect(() => importFocusPath(db, "rel.csv", { dryRun: false, now: NOW })).toThrow(
      CostImportError,
    );
    expect(() =>
      importFocusPath(db, join(dir, "missing.csv"), { dryRun: false, now: NOW }),
    ).toThrow(CostImportError);
    expect(() => importFocusPath(db, dir, { dryRun: false, now: NOW })).toThrow(/no \.csv file/);
  });

  test("skipped rows are reported with their record numbers (capped) and the count", () => {
    const p = join(dir, "a.csv");
    writeFileSync(p, `${mtd(1)}bad,111,USD,2026-11-01T00:00:00Z,2026-11-02T00:00:00Z,AWS,S3\n`);
    const r = importFocusPath(db, p, { dryRun: false, now: NOW });
    expect(r.files[0]?.skippedCount).toBe(1);
    expect(r.files[0]?.skipped[0]?.row).toBe(3);
  });

  test("removeCostImport deletes one import's lines", () => {
    const a = join(dir, "a.csv");
    writeFileSync(a, mtd(2));
    const r = importFocusPath(db, a, { dryRun: false, now: NOW });
    const id = r.files[0]?.importId ?? "";
    expect(removeCostImport(db, id)).toEqual({ importId: id, removed: 2 });
    expect(count()).toBe(0);
    expect(() => removeCostImport(db, "nope")).toThrow(CostImportError);
  });
});
