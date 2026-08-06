// packages/gateway/src/egress/egress-source-type.test.ts
import { describe, expect, test } from "bun:test";
import {
  EGRESS_SOURCE_TYPES,
  isMarkerSourceType,
  MARKER_SOURCE_TYPES,
} from "./egress-source-type.ts";

describe("EGRESS_SOURCE_TYPES — frozen union", () => {
  // IDENTITY assertion, never a length check: widening the union must show up as a diff on this
  // line. Widening is NOT a chain break (verifyEgressChain recomputes each row's hash from that
  // row's own stored source_type, never from this union's current definition) — it's frozen because
  // a value written today is permanent in the data and isMarkerSourceType depends on the set being
  // known and closed. See the doc comment on EGRESS_SOURCE_TYPES.
  //
  // `mcp` is the NINTH member, added deliberately in the agents-as-MCP-tools work — the review
  // moment this assertion exists to force. It did NOT reuse `session` with a reserved `method` (the
  // freeze note's original prescription) because `session` must keep claiming `none` coverage until
  // its own appenders land; see the rewritten header on EGRESS_SOURCE_TYPES and I29 in
  // docs/SECURITY-INVARIANTS.md.
  test("is exactly these nine members, in this order", () => {
    expect(EGRESS_SOURCE_TYPES).toEqual([
      "task",
      "prune",
      "session",
      "sync",
      "model",
      "peer",
      "mcp",
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
    // `mcp` rows are real egress (a brief handed to a client's model), never bookkeeping.
    expect(isMarkerSourceType("mcp")).toBe(false);
    // An unrecognized value must NOT be treated as a marker — an unknown row counts as egress.
    expect(isMarkerSourceType("wat")).toBe(false);
  });
});
