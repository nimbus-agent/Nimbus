import { describe, expect, test } from "bun:test";

import { renderSloMarkdown } from "./regen-slo.ts";

describe("renderSloMarkdown", () => {
  test("contains the caveat row about M1 Air reference hardware", () => {
    const md = renderSloMarkdown();
    expect(md).toContain("2020 M1 MacBook Air");
  });

  test("contains every UX surface ID with a numeric reference threshold", () => {
    const md = renderSloMarkdown();
    for (const id of ["S1", "S2-a", "S2-b", "S2-c", "S3", "S4", "S5", "S11-a", "S11-b"]) {
      expect(md).toContain(id);
    }
    expect(md).toContain("≤2 000 ms");
    expect(md).toContain("≤30 ms");
  });

  test("contains the workload-table section with TBD threshold cells", () => {
    const md = renderSloMarkdown();
    expect(md).toContain("Workload surfaces");
    expect(md).toContain("TBD — Phase 2 reference run (PR-C-2)");
  });

  test("collapses S8 in the top-level table and lists 12 cells in the sub-table", () => {
    const md = renderSloMarkdown();
    expect(md).toContain("S8 (12 cells");
    expect(md).toContain("S8 cells");
    for (const length of [50, 500, 5000]) {
      for (const batch of [1, 8, 32, 64]) {
        expect(md).toContain(`S8-l${length}-b${batch}`);
      }
    }
  });

  test("S8 sub-table includes the cell-ID gloss for non-perf readers", () => {
    const md = renderSloMarkdown();
    expect(md).toMatch(/`l` = .* (length|chars)/i);
    expect(md).toMatch(/`b` = .* batch/i);
  });

  test("contains the generated-doc footer", () => {
    const md = renderSloMarkdown();
    expect(md).toContain(
      "This file is generated from `packages/gateway/src/perf/slo-thresholds.ts`",
    );
  });
});
