import { describe, expect, test } from "bun:test";

import { decodeCostSyncCursor, encodeCostSyncCursor } from "./cost-source-gaps.ts";

const P = "nimbus-gcb1:";

describe("the failedScan member of a cost sync cursor", () => {
  test("round-trips, and drops entries that are not a month and a day", () => {
    const raw = encodeCostSyncCursor(P, {
      gaps: {},
      synced: {},
      pending: {},
      failedScan: { "p.d.t": { "2026-10": "2026-11-20" } },
    });
    expect(decodeCostSyncCursor(P, raw).failedScan).toEqual({
      "p.d.t": { "2026-10": "2026-11-20" },
    });
    const dirty =
      P +
      Buffer.from(
        JSON.stringify({
          failedScan: {
            a: { "2026-13": "2026-11-20", "2026-10": "nope", "2026-09": "2026-11-01" },
            b: {},
            c: 5,
          },
        }),
      ).toString("base64url");
    expect(decodeCostSyncCursor(P, dirty).failedScan).toEqual({ a: { "2026-09": "2026-11-01" } });
    expect(
      decodeCostSyncCursor(P, encodeCostSyncCursor(P, { gaps: {}, synced: {}, pending: {} }))
        .failedScan,
    ).toBeUndefined();
  });
});
