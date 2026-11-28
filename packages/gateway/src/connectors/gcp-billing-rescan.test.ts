import { describe, expect, test } from "bun:test";

import { failedScanOutcome, GCP_RESCAN_NOTE, nextScanDay, scanDue } from "./gcp-billing-rescan.ts";

describe("gcp billing rescan", () => {
  test("a past month waits 7 days, the current month a day", () => {
    expect(nextScanDay("2026-11-20", "2026-10", "2026-11-21")).toBe("2026-11-27");
    expect(nextScanDay("2026-11-20", "2026-11", "2026-11-20")).toBe("2026-11-21");
    expect(scanDue(undefined, "2026-10", "2026-11-21")).toBe(true);
    expect(scanDue("2026-11-20", "2026-10", "2026-11-26")).toBe(false);
    expect(scanDue("2026-11-20", "2026-10", "2026-11-27")).toBe(true);
    expect(scanDue("2026-11-20", "2026-11", "2026-11-20")).toBe(false);
    expect(scanDue("2026-11-20", "2026-11", "2026-11-21")).toBe(true);
  });

  test("a failed scan always says the next attempt is billed", () => {
    expect(failedScanOutcome({ kind: "retry" }, "2026-11")).toMatchObject({ kind: "month_gap" });
    const g = failedScanOutcome({ kind: "month_gap", reason: "x" }, "2026-11");
    expect(g).toMatchObject({ kind: "month_gap", reason: `x${GCP_RESCAN_NOTE}` });
    expect(failedScanOutcome({ kind: "gap", reason: "y" }, "2026-11")).toMatchObject({
      kind: "gap",
    });
  });
});
