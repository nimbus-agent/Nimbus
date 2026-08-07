// packages/gateway/src/egress/egress-coverage.test.ts
import { describe, expect, test } from "bun:test";
import {
  ALL_NONE_COVERAGE,
  COVERAGE_CLASSES,
  type CoverageVector,
  parseCoverage,
  serializeCoverage,
  THIS_BINARY_COVERAGE,
  weakestCoverage,
} from "./egress-coverage.ts";

const NONE: CoverageVector = {
  task: "none",
  mcp: "none",
  http: "none",
  session: "none",
  sync: "none",
  model: "none",
  peer: "none",
};

/**
 * The canonical serialization of `THIS_BINARY_COVERAGE`, spelled out literally so a change to
 * `COVERAGE_CLASSES` (which IS the wire order) shows up as a diff here rather than being absorbed
 * by a round-trip through `serializeCoverage`.
 *
 * Every hardcoded coverage string in this file must list ALL SEVEN classes. A string that omits one
 * makes `parseCoverage` return `null` for the MISSING-class reason, which would let a test that
 * targets some other defect keep passing while exercising nothing.
 *
 * `http` heads the string because the array is key-sorted and `http` < `mcp`.
 */
const CANONICAL =
  "http=per-call;mcp=per-call;model=none;peer=none;session=none;sync=per-run;task=per-call";

/** The six-class string every binary before the `http` class wrote. See the blackout test below. */
const PRE_HTTP_MARKER = "mcp=per-call;model=none;peer=none;session=none;sync=none;task=per-call";

describe("coverage vector", () => {
  test("this binary observes gated actions, externally-originated briefs, and sync runs — nothing else", () => {
    // `mcp` and `http` are per-call because ONE appender (`recordAgentBriefEgress`) serves both
    // transports and its dispatcher condition ships alongside this entry. `sync` is `per-run`
    // (weaker than per-call) because its ONE appender (`egress/sync-egress.ts`'s
    // `recordSyncEgress`) backs two callers with different shapes: `sync/scheduler.ts` appends once
    // per paginated RUN (many upstream calls per row), `sync/targeted-fetch.ts` appends once per
    // CALL — the vector reports the weaker of the two, matching how `weakestCoverage` merges
    // markers from different binaries. Every other class stays `none` until its appender lands —
    // raising an entry on the strength of an unwired seam would be a claim with no code behind it,
    // which is the exact defect this vector prevents.
    expect(THIS_BINARY_COVERAGE).toEqual({
      task: "per-call",
      mcp: "per-call",
      http: "per-call",
      session: "none",
      sync: "per-run",
      model: "none",
      peer: "none",
    });
  });

  test("COVERAGE_CLASSES stays key-sorted, with http at the head", () => {
    // The array IS the wire format: serializeCoverage maps over it to build the canonical string
    // stored in a boot marker's HASHED source_id. A non-sorted array would still typecheck and
    // still round-trip within one binary — and would produce a different canonical string from any
    // other binary that sorted correctly, silently splitting the fleet.
    expect([...COVERAGE_CLASSES]).toEqual([
      "http",
      "mcp",
      "model",
      "peer",
      "session",
      "sync",
      "task",
    ]);
    expect([...COVERAGE_CLASSES]).toEqual([...COVERAGE_CLASSES].sort());
  });

  test("ALL_NONE_COVERAGE covers the new class too", () => {
    // It is the contribution of an UNPARSEABLE marker. A class missing from it would not typecheck,
    // but this pins the intent: the all-none vector must stay total as the union grows.
    expect(ALL_NONE_COVERAGE).toEqual(NONE);
  });

  test("a pre-http marker does not parse — the accepted `nimbus prove` blackout", () => {
    // parseCoverage rejects a vector MISSING a known class, so every marker written by a binary
    // older than this one now yields null, the caller substitutes ALL_NONE_COVERAGE, and any
    // `prove` window spanning the upgrade reads `indeterminate` on EVERY class.
    //
    // Asserted rather than merely documented because it is a real operational consequence someone
    // will hit and want "fixed". Softening parseCoverage to tolerate it would let an old marker
    // contribute understated-but-plausible coverage — the forward-compatibility failure the
    // strictness exists to prevent. This is the fail-safe direction. Do not relax it.
    expect(parseCoverage(PRE_HTTP_MARKER)).toBeNull();
    // ...and the reason is genuinely the missing class, not some unrelated malformation: the same
    // string with the class restored parses fine.
    expect(parseCoverage(`http=none;${PRE_HTTP_MARKER}`)).not.toBeNull();
  });

  test("serialize is stable and key-sorted", () => {
    expect(serializeCoverage(THIS_BINARY_COVERAGE)).toBe(CANONICAL);
  });

  test("parse round-trips serialize", () => {
    expect(parseCoverage(serializeCoverage(THIS_BINARY_COVERAGE))).toEqual(THIS_BINARY_COVERAGE);
  });

  test("parse returns null on malformed input rather than guessing", () => {
    expect(parseCoverage("")).toBeNull();
    expect(parseCoverage("task=banana")).toBeNull();
    expect(parseCoverage("task=per-call")).toBeNull(); // missing classes
    // A COMPLETE vector whose only defect is an unrecognized granularity — so the rejection is
    // provably about the granularity, not about a class being absent.
    expect(parseCoverage(CANONICAL.replace("task=per-call", "task=banana"))).toBeNull();
  });

  test("parse rejects an unknown key rather than silently ignoring it (fix 2)", () => {
    // A marker written by a NEWER binary carrying a class this one doesn't know must be REJECTED
    // (→ null → ALL_NONE_COVERAGE), not accepted with the unknown segment dropped — otherwise a
    // forward-incompatible marker would contribute real (understated) coverage instead of forcing
    // `indeterminate`.
    const withUnknownKey = `${serializeCoverage(THIS_BINARY_COVERAGE)};futureclass=per-call`;
    expect(parseCoverage(withUnknownKey)).toBeNull();
  });

  test("parse rejects a duplicate key rather than silently overwriting it (fix 2)", () => {
    const withDuplicate = `${serializeCoverage(THIS_BINARY_COVERAGE)};task=per-call`;
    expect(parseCoverage(withDuplicate)).toBeNull();
  });

  test("parse rejects an extra `=` in a segment rather than dropping the tail (fix 2)", () => {
    // "task=per-call=extra" must not silently parse as task="per-call" with "extra" discarded.
    //
    // The base string is asserted PARSEABLE first. Without that guard this test would pass
    // vacuously the moment COVERAGE_CLASSES grows and the literal below stops listing every class:
    // parseCoverage would return null because a class is MISSING, not because of the extra `=`,
    // and the property under test would go unexercised.
    expect(parseCoverage(CANONICAL)).not.toBeNull();
    const withExtraEquals = CANONICAL.replace("task=per-call", "task=per-call=extra");
    expect(withExtraEquals).toContain("task=per-call=extra");
    expect(parseCoverage(withExtraEquals)).toBeNull();
  });

  test("weakest takes the LOWEST granularity per class across binaries", () => {
    const rich: CoverageVector = {
      task: "per-call",
      mcp: "per-call",
      http: "per-call",
      session: "per-call",
      sync: "per-run",
      model: "per-call",
      peer: "per-call",
    };
    expect(weakestCoverage([rich, THIS_BINARY_COVERAGE])).toEqual({
      task: "per-call", // both per-call
      mcp: "per-call", // both per-call
      http: "per-call", // both per-call
      session: "none", // this binary saw nothing
      sync: "per-run", // both per-run
      model: "none",
      peer: "none",
    });
  });

  test("weakest of an empty list is all-none — claim nothing without evidence", () => {
    expect(weakestCoverage([])).toEqual(NONE);
  });
});
