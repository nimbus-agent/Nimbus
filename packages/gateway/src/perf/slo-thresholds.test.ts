import { describe, expect, test } from "bun:test";
import { SLO_THRESHOLDS, type SloThreshold, thresholdsBySurface } from "./slo-thresholds.ts";
import type { BenchSurfaceId } from "./types.ts";

describe("SLO_THRESHOLDS — schema invariants", () => {
  test("contains exactly 29 rows", () => {
    expect(SLO_THRESHOLDS.length).toBe(29);
  });

  test("every UX row carries a gateClass and has refMax populated", () => {
    const uxIds: ReadonlySet<string> = new Set([
      "S1",
      "S2-a",
      "S2-b",
      "S2-c",
      "S3",
      "S4",
      "S5",
      "S11-a",
      "S11-b",
    ]);
    for (const row of SLO_THRESHOLDS) {
      if (!uxIds.has(row.surfaceId)) continue;
      expect(["gate", "trend", "reference"]).toContain(row.gateClass);
      expect(typeof row.refMax).toBe("number");
      if (row.surfaceId === "S2-c") {
        expect(row.ghaMax).toBe("skipped");
      } else {
        expect(typeof row.ghaMax).toBe("number");
      }
    }
  });

  test("every workload row carries a gateClass and has ghaMax === 'tbd-c2' or 'skipped'", () => {
    const workloadIds = SLO_THRESHOLDS.map((r) => r.surfaceId).filter(
      (id) =>
        id.startsWith("S6-") ||
        id.startsWith("S7-") ||
        id.startsWith("S8-") ||
        id === "S9" ||
        id === "S10",
    );
    for (const id of workloadIds) {
      const row = SLO_THRESHOLDS.find((r) => r.surfaceId === id);
      expect(row).toBeDefined();
      if (id.startsWith("S8-")) {
        expect(row!.gateClass).toBe("gate");
      } else {
        expect(["trend", "reference"]).toContain(row!.gateClass);
      }
      const ghaMax = row!.ghaMax;
      expect(typeof ghaMax).toBe("string");
      if (typeof ghaMax === "string") {
        expect(["tbd-c2", "skipped"]).toContain(ghaMax);
      }
    }
  });

  test("S2-c, S7-c, S9 are GHA-skipped surfaces (reference only)", () => {
    for (const id of ["S2-c", "S7-c", "S9"] as const) {
      const row = SLO_THRESHOLDS.find((r) => r.surfaceId === id);
      expect(row?.ghaMax).toBe("skipped");
    }
  });

  test("S1 row matches spec § 3.2 exactly", () => {
    const s1 = SLO_THRESHOLDS.find((r) => r.surfaceId === "S1");
    expect(s1).toEqual({
      surfaceId: "S1",
      gateClass: "trend",
      metric: "p95_ms",
      refMax: 2_000,
      ghaMax: 10_000,
      noiseFloorPct: 25,
      noiseFloorAbs: 300,
      noiseFloorAbsUnit: "ms",
    } satisfies SloThreshold);
  });

  test("S2-a row matches spec § 3.2 exactly", () => {
    const s2a = SLO_THRESHOLDS.find((r) => r.surfaceId === "S2-a");
    expect(s2a).toEqual({
      surfaceId: "S2-a",
      gateClass: "gate",
      metric: "p95_ms",
      refMax: 30,
      ghaMax: 200,
      noiseFloorPct: 25,
      noiseFloorAbs: 5,
      noiseFloorAbsUnit: "ms",
    } satisfies SloThreshold);
  });

  test("contains all 12 S8 cells", () => {
    const s8Ids = SLO_THRESHOLDS.map((r) => r.surfaceId).filter((id) => id.startsWith("S8-"));
    const cmp = (a: string, b: string): number => a.localeCompare(b);
    expect((s8Ids as string[]).sort(cmp)).toEqual(
      [
        "S8-l50-b1",
        "S8-l50-b8",
        "S8-l50-b32",
        "S8-l50-b64",
        "S8-l500-b1",
        "S8-l500-b8",
        "S8-l500-b32",
        "S8-l500-b64",
        "S8-l5000-b1",
        "S8-l5000-b8",
        "S8-l5000-b32",
        "S8-l5000-b64",
      ].sort(cmp),
    );
  });

  test("thresholdsBySurface() returns a O(1) lookup map", () => {
    const map = thresholdsBySurface();
    expect(map.get("S1")?.surfaceId).toBe("S1");
    expect(map.get("S2-a")?.refMax).toBe(30);
    expect(map.get("not-a-real-surface" as never)).toBeUndefined();
  });
});

describe("SLO_THRESHOLDS — gateClass partition (spec § 4.1)", () => {
  const GATE_IDS: Set<BenchSurfaceId> = new Set([
    "S2-a",
    "S2-b",
    "S8-l50-b1",
    "S8-l50-b8",
    "S8-l50-b32",
    "S8-l50-b64",
    "S8-l500-b1",
    "S8-l500-b8",
    "S8-l500-b32",
    "S8-l500-b64",
    "S8-l5000-b1",
    "S8-l5000-b8",
    "S8-l5000-b32",
    "S8-l5000-b64",
  ]);
  const TREND_IDS: Set<BenchSurfaceId> = new Set([
    "S1",
    "S3",
    "S4",
    "S5",
    "S6-drive",
    "S6-gmail",
    "S6-github",
    "S7-a",
    "S7-b",
    "S10",
    "S11-a",
    "S11-b",
  ]);
  const REFERENCE_IDS: Set<BenchSurfaceId> = new Set(["S2-c", "S7-c", "S9"]);
  const STUB_IDS: Set<BenchSurfaceId> = new Set(["S3", "S5"]);

  test("every row carries a gateClass of gate | trend | reference", () => {
    for (const row of SLO_THRESHOLDS) {
      expect(["gate", "trend", "reference"]).toContain(row.gateClass);
    }
  });

  test("the partition is exhaustive over all 29 surfaces with no overlap", () => {
    const seen = new Set<string>();
    for (const row of SLO_THRESHOLDS) {
      expect(seen.has(row.surfaceId)).toBe(false);
      seen.add(row.surfaceId);
    }
    expect(seen.size).toBe(29);
  });

  test("gate-class set matches the spec § 3 table (S2-a, S2-b + 12 S8 cells)", () => {
    const gate = SLO_THRESHOLDS.filter((r) => r.gateClass === "gate").map((r) => r.surfaceId);
    expect(new Set(gate)).toEqual(GATE_IDS);
  });

  test("trend-class set matches the spec § 3 table (S1, S4, S6-*, S7-a/b, S10, S11-a/b)", () => {
    const trend = SLO_THRESHOLDS.filter((r) => r.gateClass === "trend").map((r) => r.surfaceId);
    expect(new Set(trend)).toEqual(TREND_IDS);
  });

  test("reference-class set matches the spec § 3 table (S2-c, S7-c, S9)", () => {
    const ref = SLO_THRESHOLDS.filter((r) => r.gateClass === "reference").map((r) => r.surfaceId);
    expect(new Set(ref)).toEqual(REFERENCE_IDS);
  });

  test("S3/S5 stubs are classified trend (spawn-driver pending) and S4 is trend", () => {
    for (const id of STUB_IDS) {
      const row = SLO_THRESHOLDS.find((r) => r.surfaceId === id);
      expect(row?.gateClass).toBe("trend");
    }
    expect(SLO_THRESHOLDS.find((r) => r.surfaceId === "S4")?.gateClass).toBe("trend");
  });
});
