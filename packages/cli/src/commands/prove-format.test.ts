// packages/cli/src/commands/prove-format.test.ts
import { describe, expect, test } from "bun:test";
import { formatProveResult } from "./prove.ts";

/**
 * The REAL production vector: the gateway's six-class `THIS_BINARY_COVERAGE`
 * (`gateway/src/egress/egress-coverage.ts`), with `task` and `mcp` observed per-call.
 *
 * Hand-maintained mirror — `ProveCompleteness.coverage` is `Record<string, string>` because the
 * CLI may not import gateway source, so `tsc` cannot catch this going stale. It DID go stale once:
 * it modelled five classes after `mcp` shipped, and the assertions below kept passing against a
 * scope line no shipped gateway could produce, which is how a missing `COVERAGE_CLASS_LABELS`
 * entry reached production. Change this whenever `COVERAGE_CLASSES` changes.
 */
const COVERED = {
  coverage: {
    mcp: "per-call",
    task: "per-call",
    session: "none",
    sync: "none",
    model: "none",
    peer: "none",
  },
  outboundEgressEvents: 0,
  indeterminate: false,
} as const;

/**
 * The scope clause a real gateway produces today, spelled out literally.
 *
 * `observed` is sorted by CLASS KEY before mapping to display names, so `mcp` (< `task`) leads even
 * though its label starts with "agents.*". The `mcp` label is deliberately narrow: that class
 * covers only `agents.*` briefs served to a client that declared `kind: "mcp"`, NOT everything an
 * MCP client can call on the socket. A class with no `COVERAGE_CLASS_LABELS` entry falls back to
 * its raw key, which reads as a far broader claim than the appender makes — see the comment on
 * that map in prove.ts.
 */
const REAL_SCOPE = "agents.* briefs served to MCP clients, gated connector actions";

describe("formatProveResult", () => {
  test("a zero window never prints a bare 0 — it names what was observed", () => {
    const out = formatProveResult({
      delta: 0,
      completeness: COVERED,
      chainOk: true,
      label: "during this query",
    });
    // Assert the whole first line, not just that a "0" appears somewhere: the defect being fixed
    // is a count printed WITHOUT its scope, so the scope must be on the same line as the number.
    // Pinned to the REAL six-class gateway output — every observed class is named with a label,
    // never a raw key.
    expect(out.split("\n")[0]).toBe(
      `outbound egress events during this query, in the covered classes: 0 (scope: ${REAL_SCOPE})`,
    );
    expect(out).toContain("not observed: model, peer, session, sync");
    // No observed class fell through to its raw key. `mcp` alone in the scope clause would read as
    // "everything this MCP client does"; the label exists to stop exactly that.
    expect(out).not.toContain("scope: mcp");
    expect(out).not.toMatch(/scope:.*\bmcp\b,/);
  });

  // Fix wave: the label must be the caller-supplied scope, not a hardcoded "during this query" —
  // `nimbus egress`'s whole-window report is a different number over a different scope from
  // `nimbus prove`'s query delta, and printing both under an identical label was the defect.
  test("the printed label is exactly what the caller supplies, not hardcoded", () => {
    const out = formatProveResult({
      delta: 3,
      completeness: COVERED,
      chainOk: true,
      label: "in this window",
    });
    expect(out.split("\n")[0]).toBe(
      `outbound egress events in this window, in the covered classes: 3 (scope: ${REAL_SCOPE})`,
    );
    expect(out).not.toContain("during this query");
  });

  // Fix wave: the scope line must name every observed class, not collapse to just "gated connector
  // actions" and silently drop the others from both the scope line AND the "not observed" line.
  // Two observed classes is now the SHIPPED state (`task` + `mcp`), not a hypothetical; this case
  // adds a third, `session`, which has no label yet and therefore prints its raw key — the mixed
  // labelled/unlabelled rendering a future coverage class will hit on its first day.
  test("scope names every observed class when more than one is observed", () => {
    const out = formatProveResult({
      delta: 0,
      completeness: {
        coverage: {
          mcp: "per-call",
          task: "per-call",
          session: "per-run",
          sync: "none",
          model: "none",
          peer: "none",
        },
        outboundEgressEvents: 0,
        indeterminate: false,
      },
      chainOk: true,
      label: "during this query",
    });
    // `observed` is sorted by CLASS KEY before mapping to display names: mcp < session < task, so
    // the bare "session" lands between the two labelled entries rather than after them.
    expect(out.split("\n")[0]).toBe(
      "outbound egress events during this query, in the covered classes: 0 (scope: agents.* briefs served to MCP clients, session, gated connector actions)",
    );
    expect(out).toContain("not observed: model, peer, sync");
  });

  test("an indeterminate window reports indeterminate, never zero", () => {
    const out = formatProveResult({
      delta: 0,
      completeness: { ...COVERED, indeterminate: true },
      chainOk: true,
      label: "during this query",
    });
    expect(out).toContain("indeterminate");
    expect(out).not.toContain("0 ✓");
  });

  test("a broken chain reports indeterminate even when the count is zero", () => {
    const out = formatProveResult({
      delta: 0,
      completeness: COVERED,
      chainOk: false,
      label: "during this query",
    });
    expect(out).toContain("indeterminate");
    expect(out).not.toContain("0 ✓");
  });

  // I29 Task 11: `sync` was raised `none` -> `per-run` (the fourth non-none class, alongside the
  // `http` class that landed after COVERED/REAL_SCOPE above were last updated). Without this test,
  // deleting the `sync` entry from `COVERAGE_CLASS_LABELS` (prove.ts) would leave the whole suite
  // green while `formatProveResult` fell through to the bare-key fallback and printed a raw `sync`
  // — exactly the "a class with no label reads as a much bigger claim than it is" trap the map's
  // own docstring warns about. A fresh, ACCURATE fixture here, deliberately not folded into
  // `COVERED` above: `COVERED` is missing `http` already (pre-existing drift out of this task's
  // scope — see the module doc comment) and is shared by five other tests whose exact-string
  // assertions would all need rewriting for an unrelated reason if `COVERED` itself changed.
  test("the sync class renders its OWN label ('runs', not 'calls'), never falls through to a bare key", () => {
    const out = formatProveResult({
      delta: 0,
      completeness: {
        coverage: {
          task: "per-call",
          mcp: "per-call",
          http: "per-call",
          sync: "per-run",
          session: "none",
          model: "none",
          peer: "none",
        },
        outboundEgressEvents: 0,
        indeterminate: false,
      },
      chainOk: true,
      label: "during this query",
    });
    expect(out).toContain("configured connector sync runs and targeted fetch-on-miss calls");
    // The bare fallback never fires: a lone "sync" (unlabelled) would appear as its own
    // comma-delimited scope-clause token, which this rules out without over-matching the labelled
    // occurrence above (which contains the substring "sync" too, inside "targeted fetch-on-miss").
    expect(out).not.toMatch(/scope:.*(?:^|, )sync(?:,|\))/);
  });

  // Task 3 fix round 1: `model` was raised `none` -> `per-call` (the fifth non-none class).
  // Following the `sync` test immediately above's precedent and stated reasoning: without this
  // test, deleting the `model` entry from `COVERAGE_CLASS_LABELS` (prove.ts) would leave the whole
  // suite green while `formatProveResult` fell through to the bare-key fallback and printed a raw
  // `model` — the widest possible over-claim on the one surface whose entire job is not
  // over-claiming, since a bare `model` reads as "all inference" rather than the narrower
  // non-local-route-generate/Mastra-agent/remote-embed scope this label actually covers.
  // A fresh, ACCURATE fixture here, deliberately not folded into `COVERED` above,
  // for the same reason the `sync` test isn't: `COVERED` is shared by five other tests whose
  // exact-string assertions would all need rewriting for an unrelated reason if it changed.
  test("the model class renders its OWN label ('prompts and embedding batches sent to a non-local model route'), never falls through to a bare key", () => {
    const out = formatProveResult({
      delta: 0,
      completeness: {
        coverage: {
          task: "per-call",
          mcp: "per-call",
          http: "per-call",
          sync: "per-run",
          model: "per-call",
          session: "none",
          peer: "none",
        },
        outboundEgressEvents: 0,
        indeterminate: false,
      },
      chainOk: true,
      label: "during this query",
    });
    expect(out).toContain("prompts and embedding batches sent to a non-local model route");
    // The bare fallback never fires: a lone "model" (unlabelled) would appear as its own
    // comma-delimited scope-clause token.
    expect(out).not.toMatch(/scope:.*(?:^|, )model(?:,|\))/);
  });
});
