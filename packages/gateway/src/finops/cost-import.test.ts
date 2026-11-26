import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import {
  CostImportError,
  hashFileCapped,
  importFocusPath,
  removeCostImport,
} from "./cost-import.ts";
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
const sumAll = (): number =>
  (db.query("SELECT TOTAL(billed_cost) AS s FROM cost_line").get() as { s: number }).s;

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

  test("a second identical run is reported unchanged and writes nothing", () => {
    const p = join(dir, "a.csv");
    writeFileSync(p, mtd(5));
    const first = importFocusPath(db, p, { dryRun: false, now: NOW });
    const again = importFocusPath(db, p, { dryRun: false, now: NOW });
    expect(again.files[0]).toMatchObject({
      status: "unchanged",
      importId: first.files[0]?.importId,
      inserted: 0,
      replaced: 0,
      removed: 0,
    });
    expect(count()).toBe(5);
  });

  test("replaying an accepted export never overwrites a later restatement (A, B, A again)", () => {
    const a = join(dir, "a.csv");
    const b = join(dir, "b.csv");
    writeFileSync(a, mtd(1, "1"));
    writeFileSync(b, mtd(1, "5"));
    importFocusPath(db, a, { dryRun: false, now: NOW });
    importFocusPath(db, b, { dryRun: false, now: NOW });
    const replay = importFocusPath(db, a, { dryRun: false, now: NOW });
    expect(replay.files[0]?.status).toBe("unchanged");
    expect(sumAll()).toBe(5);
    // --remove clears the ledger row, so the same export can be imported again.
    removeCostImport(db, replay.files[0]?.importId ?? "");
    const again = importFocusPath(db, a, { dryRun: false, now: NOW });
    expect(again.files[0]?.status).toBe("imported");
    expect(sumAll()).toBe(1);
  });

  test("a directory replay is all or nothing: a refused newer file leaves the older one unapplied", () => {
    const a = join(dir, "a.csv");
    const b = join(dir, "b.csv");
    writeFileSync(a, mtd(1, "1"));
    writeFileSync(b, mtd(1, "5"));
    utimesSync(a, new Date(Date.UTC(2026, 10, 1)), new Date(Date.UTC(2026, 10, 1)));
    utimesSync(b, new Date(Date.UTC(2026, 10, 2)), new Date(Date.UTC(2026, 10, 2)));
    importFocusPath(db, dir, { dryRun: false, now: NOW });
    expect(sumAll()).toBe(5);
    // b's bytes change to invalid UTF-8: a new hash, so the directory replays, and b is refused.
    writeFileSync(b, Buffer.from([0xff, 0xfe, 0x00]));
    utimesSync(b, new Date(Date.UTC(2026, 10, 2)), new Date(Date.UTC(2026, 10, 2)));
    const r = importFocusPath(db, dir, { dryRun: false, now: NOW });
    expect(sumAll()).toBe(5);
    expect(r.files.map((f) => [f.name, f.status])).toEqual([
      ["a.csv", "refused"],
      ["b.csv", "refused"],
    ]);
    expect(r.files[0]?.error).toBe(
      "not applied: b.csv was refused, so this folder's replay was rolled back",
    );
    expect(r.files[1]?.error).toBe("the file is not valid UTF-8");
  });

  test("the ledger records each accepted import with its provider, hash and time", () => {
    const p = join(dir, "a.csv");
    writeFileSync(p, mtd(1));
    const r = importFocusPath(db, p, { dryRun: false, now: NOW });
    expect(db.query("SELECT * FROM cost_import").all()).toEqual([
      {
        import_id: r.files[0]?.importId ?? "",
        source: "focus",
        provider: "aws",
        file_sha256: r.files[0]?.sha256 ?? "",
        imported_at: NOW(),
      },
    ]);
    importFocusPath(db, p, { dryRun: true, now: NOW });
    const dry = join(dir, "b.csv");
    writeFileSync(dry, mtd(2));
    importFocusPath(db, dry, { dryRun: true, now: NOW });
    expect(db.query("SELECT COUNT(*) AS n FROM cost_import").get()).toEqual({ n: 1 });
  });

  test("a directory with a new older file replays the accepted newer one, so the newest still wins", () => {
    const older = join(dir, "a.csv");
    const newer = join(dir, "b.csv");
    writeFileSync(newer, mtd(1, "4"));
    importFocusPath(db, newer, { dryRun: false, now: NOW });
    writeFileSync(older, mtd(1, "3"));
    utimesSync(older, new Date(Date.UTC(2026, 10, 1)), new Date(Date.UTC(2026, 10, 1)));
    utimesSync(newer, new Date(Date.UTC(2026, 10, 2)), new Date(Date.UTC(2026, 10, 2)));
    const r = importFocusPath(db, dir, { dryRun: false, now: NOW });
    expect(r.files.map((f) => [f.name, f.status])).toEqual([
      ["a.csv", "imported"],
      ["b.csv", "imported"],
    ]);
    expect(sumAll()).toBe(4);
    // Nothing new: the whole directory is unchanged and nothing is written.
    const again = importFocusPath(db, dir, { dryRun: false, now: NOW });
    expect(again.files.map((f) => f.status)).toEqual(["unchanged", "unchanged"]);
  });

  test("a directory --dry-run lets each file see the earlier files' simulated changes", () => {
    const older = join(dir, "a.csv");
    const newer = join(dir, "b.csv");
    writeFileSync(older, mtd(1, "1"));
    writeFileSync(newer, mtd(1, "2"));
    utimesSync(older, new Date(Date.UTC(2026, 10, 1)), new Date(Date.UTC(2026, 10, 1)));
    utimesSync(newer, new Date(Date.UTC(2026, 10, 2)), new Date(Date.UTC(2026, 10, 2)));
    writeFileSync(join(dir, "c.csv"), "x,y\n1,2\n");
    const r = importFocusPath(db, dir, { dryRun: true, now: NOW });
    const byName = new Map(r.files.map((f) => [f.name, f]));
    expect(byName.get("a.csv")).toMatchObject({ status: "dry_run", inserted: 1, replaced: 0 });
    expect(byName.get("b.csv")).toMatchObject({ status: "dry_run", inserted: 0, replaced: 1 });
    expect(byName.get("c.csv")?.status).toBe("refused");
    expect(count()).toBe(0);
    expect(db.query("SELECT COUNT(*) AS n FROM cost_import").get()).toEqual({ n: 0 });
  });

  test("hashFileCapped refuses a file above the cap and hashes one below it", () => {
    const p = join(dir, "a.csv");
    writeFileSync(p, "hello");
    expect(() => hashFileCapped(p, 4)).toThrow(/larger than the import cap of 4 bytes/);
    expect(hashFileCapped(p, 5)).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
    expect(() => hashFileCapped(join(dir, "missing.csv"))).toThrow();
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
  test("--provider forces the provider; a row naming a different known provider is skipped", () => {
    const p = join(dir, "a.csv");
    writeFileSync(
      p,
      `${HEADER}\n1,111,USD,2026-11-01T00:00:00Z,2026-11-01T00:00:00Z,Acme Cloud,Compute\n` +
        "2,111,USD,2026-11-01T00:00:00Z,2026-11-02T00:00:00Z,Google Cloud,BigQuery\n",
    );
    const r = importFocusPath(db, p, { dryRun: false, now: NOW, provider: "aws" });
    expect(r.files[0]?.status).toBe("imported");
    expect(r.files[0]?.lines).toBe(1);
    expect(r.files[0]?.skipped[0]?.reason).toContain("is not --provider aws");
    expect(
      readCostLines(db, { fromDay: "2026-11-01", toDay: "2026-11-30" }).map((l) => l.provider),
    ).toEqual(["aws"]);
  });

  test("a store failure refuses the file with the store's message and writes nothing", () => {
    const bare = new Database(":memory:");
    try {
      const p = join(dir, "a.csv");
      writeFileSync(p, mtd(2));
      const r = importFocusPath(bare, p, { dryRun: false, now: NOW });
      expect(r.files[0]?.status).toBe("refused");
      expect(r.files[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(r.files[0]?.importId).toBeNull();
      expect(r.files[0]?.error).toContain("no such table");
    } finally {
      bare.close();
    }
  });

  test("a failure while writing the lines refuses the file and records nothing", () => {
    const partial = new Database(":memory:");
    try {
      // The ledger exists but the line table does not: the write fails after the ledger check.
      partial.run(
        "CREATE TABLE cost_import (import_id TEXT PRIMARY KEY, source TEXT, provider TEXT, file_sha256 TEXT, imported_at INTEGER)",
      );
      const p = join(dir, "a.csv");
      writeFileSync(p, mtd(1));
      const r = importFocusPath(partial, p, { dryRun: false, now: NOW });
      expect(r.files[0]?.status).toBe("refused");
      expect(r.files[0]?.error).toContain("cost_line");
      expect(partial.query("SELECT COUNT(*) AS n FROM cost_import").get()).toEqual({ n: 0 });
    } finally {
      partial.close();
    }
  });

  test("a directory whose files are all above the cap refuses each one", () => {
    writeFileSync(join(dir, "a.csv"), mtd(1));
    writeFileSync(join(dir, "b.csv"), mtd(2));
    const r = importFocusPath(db, dir, { dryRun: false, now: NOW, maxBytes: 8 });
    expect(r.files.map((f) => f.status)).toEqual(["refused", "refused"]);
    expect(count()).toBe(0);
  });

  test("a linked path is refused, not followed", () => {
    const target = join(dir, "real");
    mkdirSync(target);
    writeFileSync(join(target, "a.csv"), mtd(1));
    const link = join(dir, "link");
    // A junction needs no privilege on Windows; elsewhere the type is ignored and this is a symlink.
    symlinkSync(target, link, "junction");
    expect(() => importFocusPath(db, link, { dryRun: false, now: NOW })).toThrow(
      /is a link, which is not followed/,
    );
    expect(count()).toBe(0);
  });
});
