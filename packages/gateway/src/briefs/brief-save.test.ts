import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { LocalIndex } from "../index/local-index.ts";
import { BriefRunController } from "./brief-run-store.ts";
import { ReportTooLargeError, saveBriefReport } from "./brief-save.ts";
import type { BriefRun, Report } from "./brief-types.ts";

function db(): Database {
  const d = new Database(":memory:");
  // Real schema helper — creates the `item` table + FTS triggers (same as clip tests).
  LocalIndex.ensureSchema(d);
  return d;
}

function doneRun(report: Report): BriefRun {
  const c = new BriefRunController({ nowMs: () => 1000 });
  const out = c.create({
    brief: "compare MV3 lifecycles",
    sources: [{ url: "https://a.test/1", title: "A" }],
    useIndex: true,
  });
  if ("error" in out) throw new Error("expected a run");
  c.finish(out.run, report);
  return out.run;
}

const REPORT: Report = {
  summary: "Workers die differently.",
  findings: [
    {
      text: "Chrome evicts at 30s",
      citations: [{ kind: "source", title: "A", url: "https://a.test/1" }],
    },
  ],
  conflicts: [],
  gaps: ["one gap"],
  synthesis: { model: "llama3.1:8b", remote: false },
};

describe("saveBriefReport", () => {
  // Defensive: save is only ever called on a "done" run, but the type still allows
  // `report: null` (a run that hasn't finished yet), and this module must never write
  // a null report to disk rather than silently coercing it into something saveable.
  test("throws ReportTooLargeError when the run has no report yet", () => {
    const d = db();
    const c = new BriefRunController({ nowMs: () => 1000 });
    const out = c.create({
      brief: "compare MV3 lifecycles",
      sources: [{ url: "https://a.test/1", title: "A" }],
      useIndex: true,
    });
    if ("error" in out) throw new Error("expected a run");
    expect(out.run.report).toBeNull();
    expect(() => saveBriefReport(d, out.run)).toThrow(ReportTooLargeError);
  });

  test("writes a nimbus:research_brief item", () => {
    const d = db();
    const { itemId } = saveBriefReport(d, doneRun(REPORT));
    const row = d.query("SELECT service, type, title FROM item WHERE id = ?").get(itemId) as {
      service: string;
      type: string;
      title: string;
    } | null;
    expect(row?.service).toBe("nimbus");
    expect(row?.type).toBe("research_brief");
    expect(row?.title).toContain("compare MV3 lifecycles");
    expect(itemId.startsWith("nimbus:brief:")).toBe(true);
  });

  test("stores the full report plus synthesis in metadata", () => {
    const d = db();
    const { itemId } = saveBriefReport(d, doneRun(REPORT));
    const row = d.query("SELECT metadata FROM item WHERE id = ?").get(itemId) as {
      metadata: string;
    };
    const meta = JSON.parse(row.metadata) as Record<string, unknown>;
    expect(meta["source"]).toBe("research_brief");
    expect((meta["report"] as Report).findings).toHaveLength(1);
    expect((meta["synthesis"] as { model: string }).model).toBe("llama3.1:8b");
    expect(meta["usedIndex"]).toBe(true);
  });

  test("saving twice upserts rather than duplicating", () => {
    const d = db();
    const run = doneRun(REPORT);
    const a = saveBriefReport(d, run);
    const b = saveBriefReport(d, run);
    expect(a.itemId).toBe(b.itemId);
    const n = d.query("SELECT COUNT(*) AS n FROM item WHERE type = 'research_brief'").get() as {
      n: number;
    };
    expect(n.n).toBe(1);
  });

  test("schedules an embedding for the saved brief", () => {
    const d = db();
    const seen: string[] = [];
    const { itemId } = saveBriefReport(d, doneRun(REPORT), (id) => seen.push(id));
    expect(seen).toEqual([itemId]);
  });

  // Two distinct degradation cases. Size them by MEASURING, not by eyeballing: a report
  // of 25 findings x 8 citations with 200-char titles and URLs is ~100 KB even after the
  // quotes come off, so a fixture like that can only ever throw.
  test("drops quotes when that is enough to fit, and says so in gaps", () => {
    const d = db();
    // ~15 findings x 6 citations: over budget with 600-char quotes, under without them
    // (measured, not eyeballed — see the guard assertions right below).
    const heavy: Report = {
      ...REPORT,
      findings: Array.from({ length: 15 }, () => ({
        text: "x".repeat(400),
        citations: Array.from({ length: 6 }, () => ({
          kind: "source" as const,
          title: "t".repeat(60),
          url: "https://a.test/p",
          quote: "q".repeat(600),
        })),
      })),
    };
    const withQuotes = Buffer.byteLength(JSON.stringify(heavy), "utf8");
    const stripped = JSON.stringify({
      ...heavy,
      findings: heavy.findings.map((f) => ({
        text: f.text,
        citations: f.citations.map(({ quote: _q, ...r }) => r),
      })),
    });
    // Guard the fixture itself: if these stop straddling the budget the test is vacuous.
    expect(withQuotes).toBeGreaterThan(60 * 1024);
    expect(Buffer.byteLength(stripped, "utf8")).toBeLessThan(60 * 1024);

    const { itemId } = saveBriefReport(d, doneRun(heavy));
    const row = d.query("SELECT metadata FROM item WHERE id = ?").get(itemId) as {
      metadata: string;
    };
    expect(Buffer.byteLength(row.metadata, "utf8")).toBeLessThanOrEqual(64 * 1024);
    const meta = JSON.parse(row.metadata) as { report: Report };
    expect(meta.report.findings[0]?.citations[0]?.quote).toBeUndefined();
    expect(meta.report.gaps.join(" ")).toContain("quotes");
  });

  test("throws ReportTooLargeError when even a quote-free report cannot fit", () => {
    const d = db();
    const huge: Report = {
      ...REPORT,
      findings: Array.from({ length: 25 }, () => ({
        text: "x".repeat(400),
        citations: Array.from({ length: 8 }, () => ({
          kind: "source" as const,
          title: "t".repeat(200),
          url: `https://a.test/${"u".repeat(200)}`,
          quote: "q".repeat(200),
        })),
      })),
    };
    expect(() => saveBriefReport(d, doneRun(huge))).toThrow(ReportTooLargeError);
  });
});
