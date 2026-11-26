import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION, LocalIndex } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import type { CostLine, CostLineKey } from "./cost-line.ts";
import {
  deleteCostImport,
  deleteCostLinesBySource,
  pruneCostLinesBefore,
  readCostLines,
  replaceCostLines,
} from "./cost-line-store.ts";

const KEY: CostLineKey = {
  source: "focus",
  provider: "aws",
  billingAccountId: "111",
  billingPeriod: "2026-11",
};

function day(n: number): string {
  return `2026-11-${String(n).padStart(2, "0")}`;
}

function line(n: number, over: Partial<CostLine> = {}): CostLine {
  return {
    ...KEY,
    chargeDay: day(n),
    subAccountId: "acct-1",
    subAccountName: null,
    serviceName: "Amazon S3",
    serviceCategory: "Storage",
    regionId: "us-east-1",
    resourceId: null,
    resourceName: null,
    skuId: null,
    chargeCategory: "usage",
    billedCost: 10,
    effectiveCost: null,
    currency: "USD",
    tags: { team: "web" },
    repo: null,
    workflow: null,
    model: null,
    importId: "imp-a",
    ...over,
  };
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i <= to; i++) out.push(i);
  return out;
}

function count(db: Database): number {
  return (db.query("SELECT COUNT(*) AS n FROM cost_line").get() as { n: number }).n;
}

function sum(db: Database): number {
  return (db.query("SELECT TOTAL(billed_cost) AS s FROM cost_line").get() as { s: number }).s;
}

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
});
afterEach(() => {
  db.close();
});

describe("cost-line store", () => {
  test("a replace inserts and the read returns the same lines", () => {
    const lines = range(1, 3).map((n) => line(n));
    const r = replaceCostLines(
      db,
      KEY,
      lines.map((l) => l.chargeDay),
      lines,
    );
    expect(r).toEqual({ inserted: 3, replaced: 0, unchanged: 0, removed: 0 });
    const back = readCostLines(db, { fromDay: day(1), toDay: day(3) });
    expect(back).toEqual(lines);
  });

  test("a month-to-date file that grew from 1..19 to 1..20 leaves exactly 20 days (Review Focus 2)", () => {
    const first = range(1, 19).map((n) => line(n));
    replaceCostLines(
      db,
      KEY,
      first.map((l) => l.chargeDay),
      first,
    );
    const second = range(1, 20).map((n) => line(n, { importId: "imp-b" }));
    const r = replaceCostLines(
      db,
      KEY,
      second.map((l) => l.chargeDay),
      second,
    );
    expect(r).toEqual({ inserted: 1, replaced: 0, unchanged: 19, removed: 0 });
    expect(count(db)).toBe(20);
    const days = readCostLines(db, { fromDay: day(1), toDay: day(30) }).map((l) => l.chargeDay);
    expect(days).toEqual(range(1, 20).map(day));
  });

  test("an identical re-import changes nothing", () => {
    const lines = range(1, 5).map((n) => line(n));
    replaceCostLines(
      db,
      KEY,
      lines.map((l) => l.chargeDay),
      lines,
    );
    const before = { n: count(db), s: sum(db) };
    const r = replaceCostLines(
      db,
      KEY,
      lines.map((l) => l.chargeDay),
      lines,
    );
    expect(r).toEqual({ inserted: 0, replaced: 0, unchanged: 5, removed: 0 });
    expect({ n: count(db), s: sum(db) }).toEqual(before);
  });

  test("a restated day replaces its value, and a grain gone from a covered day is removed", () => {
    replaceCostLines(db, KEY, [day(1)], [line(1), line(1, { serviceName: "Amazon EC2" })]);
    const r = replaceCostLines(db, KEY, [day(1)], [line(1, { billedCost: 12 })]);
    expect(r).toEqual({ inserted: 0, replaced: 1, unchanged: 0, removed: 1 });
    expect(readCostLines(db, { fromDay: day(1), toDay: day(1) })).toEqual([
      line(1, { billedCost: 12 }),
    ]);
  });

  test("lines on days the file does not contain are kept", () => {
    const all = range(1, 10).map((n) => line(n));
    replaceCostLines(
      db,
      KEY,
      all.map((l) => l.chargeDay),
      all,
    );
    replaceCostLines(db, KEY, [day(10)], [line(10, { billedCost: 99 })]);
    expect(count(db)).toBe(10);
    expect(sum(db)).toBe(9 * 10 + 99);
  });

  test("another billing account or source on the same day is untouched", () => {
    const other = line(1, { billingAccountId: "222" });
    replaceCostLines(db, { ...KEY, billingAccountId: "222" }, [day(1)], [other]);
    replaceCostLines(db, KEY, [day(1)], [line(1)]);
    replaceCostLines(db, KEY, [day(1)], []);
    expect(readCostLines(db, { fromDay: day(1), toDay: day(1) })).toEqual([other]);
  });

  test("a line outside the key or the covered days is refused and nothing is written", () => {
    expect(() => replaceCostLines(db, KEY, [day(1)], [line(1), line(2)])).toThrow(
      /not among the covered days/,
    );
    expect(() => replaceCostLines(db, KEY, [day(1)], [line(1, { provider: "gcp" })])).toThrow(
      /does not match/,
    );
    expect(count(db)).toBe(0);
  });

  test("a non-finite amount is refused", () => {
    expect(() =>
      replaceCostLines(db, KEY, [day(1)], [line(1, { billedCost: Number.NaN })]),
    ).toThrow(/finite/);
  });

  test("reads filter by source", () => {
    replaceCostLines(db, KEY, [day(1)], [line(1)]);
    const gh = { ...KEY, source: "github_actions", provider: "github" };
    replaceCostLines(db, gh, [day(1)], [line(1, { source: "github_actions", provider: "github" })]);
    expect(readCostLines(db, { fromDay: day(1), toDay: day(1), sources: ["focus"] })).toHaveLength(
      1,
    );
    expect(readCostLines(db, { fromDay: day(1), toDay: day(1), sources: [] })).toHaveLength(0);
    expect(readCostLines(db, { fromDay: day(1), toDay: day(1) })).toHaveLength(2);
  });

  test("delete by source and by import id", () => {
    replaceCostLines(db, KEY, [day(1)], [line(1, { importId: "imp-a" })]);
    replaceCostLines(db, KEY, [day(2)], [line(2, { importId: "imp-b" })]);
    const gh = { ...KEY, source: "github_actions", provider: "github" };
    replaceCostLines(db, gh, [day(1)], [line(1, { source: "github_actions", provider: "github" })]);
    expect(deleteCostImport(db, "imp-b")).toBe(1);
    expect(deleteCostLinesBySource(db, "focus")).toBe(1);
    expect(count(db)).toBe(1);
  });

  test("prune deletes lines whose day is before the cutoff", () => {
    const all = range(1, 10).map((n) => line(n));
    replaceCostLines(
      db,
      KEY,
      all.map((l) => l.chargeDay),
      all,
    );
    expect(pruneCostLinesBefore(db, day(4))).toBe(3);
    expect(count(db)).toBe(7);
  });

  test("connector remove deletes that source's lines and no other source's", () => {
    const idx = new LocalIndex(db);
    replaceCostLines(db, KEY, [day(1)], [line(1)]);
    const gh = { ...KEY, source: "github_actions", provider: "github" };
    replaceCostLines(db, gh, [day(1)], [line(1, { source: "github_actions", provider: "github" })]);
    idx.removeConnectorIndexData("github_actions");
    expect(readCostLines(db, { fromDay: day(1), toDay: day(1) }).map((l) => l.source)).toEqual([
      "focus",
    ]);
  });
});
