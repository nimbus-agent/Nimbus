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
  //
  // `http` is the TENTH, added when agent briefs became reachable over the local HTTP API. Same
  // review moment, same rejected shortcut (`session` again), plus one reason of its own: it is
  // named for the VERIFIABLE TRANSPORT rather than a caller-declared client kind, so folding it
  // into `mcp` would have merged two different attribution strengths under one permanent string.
  //
  // `outcome` is the ELEVENTH, and the first admitted as a MARKER rather than an egress class. It
  // records how a targeted fetch ended, which the authorising row structurally cannot say: that row
  // is appended BEFORE the connector call, so its `result_status` is an authorisation decision.
  test("is exactly these eleven members, in this order", () => {
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
      "http",
      "outcome",
    ]);
  });

  test("marker types are the four bookkeeping classes", () => {
    expect([...MARKER_SOURCE_TYPES].sort()).toEqual(["boot", "degraded", "outcome", "prune"]);
  });

  test("outcome is a MARKER, so it can never be counted as outbound egress", () => {
    // The whole argument for admitting an eleventh member. An outcome row is
    // bookkeeping about an outbound call the ledger has ALREADY counted;
    // counting it again would double every targeted fetch.
    expect(isMarkerSourceType("outcome")).toBe(true);
  });

  test("isMarkerSourceType: markers true, egress-bearing false, unknown false", () => {
    expect(isMarkerSourceType("prune")).toBe(true);
    expect(isMarkerSourceType("boot")).toBe(true);
    expect(isMarkerSourceType("degraded")).toBe(true);
    expect(isMarkerSourceType("task")).toBe(false);
    expect(isMarkerSourceType("model")).toBe(false);
    // `mcp` rows are real egress (a brief handed to a client's model), never bookkeeping.
    expect(isMarkerSourceType("mcp")).toBe(false);
    // Same for `http` — the transport differs, the disclosure does not.
    expect(isMarkerSourceType("http")).toBe(false);
    // An unrecognized value must NOT be treated as a marker — an unknown row counts as egress.
    expect(isMarkerSourceType("wat")).toBe(false);
  });
});
