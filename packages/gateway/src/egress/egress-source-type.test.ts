// packages/gateway/src/egress/egress-source-type.test.ts
import { describe, expect, test } from "bun:test";
import {
  EGRESS_SOURCE_TYPES,
  isMarkerSourceType,
  MARKER_SOURCE_TYPES,
} from "./egress-source-type.ts";

describe("EGRESS_SOURCE_TYPES — frozen union", () => {
  // IDENTITY assertion, never a length check: widening the union must show up as a diff on this
  // line. `source_type` is BLAKE3-committed, so a new member is a chain break, not a refactor.
  test("is exactly these eight members, in this order", () => {
    expect(EGRESS_SOURCE_TYPES).toEqual([
      "task",
      "prune",
      "session",
      "sync",
      "model",
      "peer",
      "boot",
      "degraded",
    ]);
  });

  test("marker types are the three bookkeeping classes", () => {
    expect([...MARKER_SOURCE_TYPES].sort()).toEqual(["boot", "degraded", "prune"]);
  });

  test("isMarkerSourceType: markers true, egress-bearing false, unknown false", () => {
    expect(isMarkerSourceType("prune")).toBe(true);
    expect(isMarkerSourceType("boot")).toBe(true);
    expect(isMarkerSourceType("degraded")).toBe(true);
    expect(isMarkerSourceType("task")).toBe(false);
    expect(isMarkerSourceType("model")).toBe(false);
    // An unrecognized value must NOT be treated as a marker — an unknown row counts as egress.
    expect(isMarkerSourceType("wat")).toBe(false);
  });
});
