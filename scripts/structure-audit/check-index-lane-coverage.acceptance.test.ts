#!/usr/bin/env bun

/**
 * Task 1.7 — acceptance: the census must reproduce the four confirmed bugs.
 *
 * This is the test that decides whether the census (`collectLaneCensus`, Task 1.6) is real. It
 * runs against the actual repo tree, not fixtures — the same `packages/gateway/src/**` corpus
 * `check-index-lane-coverage.ts`'s `run()` scans, collected the same way (`iterateSourceFiles()`
 * filtered to that prefix) so the numbers here are the numbers the shipped artifact reports.
 *
 * Four bugs are the reason this gate exists, confirmed by hand against the shipped artifact
 * (`docs/structure-audit/index-lane-census.json`):
 *   - `expert.ts:386` reads `item.type = 'commit'` — no writer in the corpus ever writes that
 *     type (a dead lane: `graph_entity` writes `commit`, `item` never does).
 *   - `preflight.ts:166` reads `item.metadata.workflow_name` scoped to `ci_run` — no `ci_run`
 *     writer emits it at all.
 *   - `preflight.ts:168` and `:175` read `item.metadata.branch` scoped to `ci_run` — of the
 *     `ci_run` writers, only `circleci` emits it (a PARTIAL match, not total absence).
 *   - `premortem.ts:199`/`:205` read `item.metadata.opened_at_ms` on `pr`-scoped rows — no `pr`
 *     writer emits it (the key exists on other types, e.g. `dora.ts`'s matched read, but never on
 *     `pr` — this is the per-type-scoping guard, not a global-key check).
 *
 * Per the task brief: if any of the four fails, the fix belongs in the extractor
 * (`check-index-lane-coverage.ts` or `lane-census/*.ts`), never in this assertion — weakening the
 * assertion to match a broken implementation is how this gate becomes theatre.
 *
 * Bun test files are synchronous top-level scripts but a module itself may use top-level await,
 * so the (I/O-bearing) collection happens at module scope, once, and the `describe` body below
 * only reads the already-built `census` — never awaits inside a `describe`/`test` callback.
 */

import { describe, expect, test } from "bun:test";
import { collectLaneCensus } from "./check-index-lane-coverage.ts";
import type { FileEntry } from "./check-nimbus-invariants.ts";
import { iterateSourceFiles } from "./lib.ts";

const files: FileEntry[] = [];
for await (const f of iterateSourceFiles()) {
  if (!f.relPath.startsWith("packages/gateway/src/")) continue;
  files.push({ relPath: f.relPath, contents: f.contents });
}

const census = collectLaneCensus(files);

describe("lane census over the real tree", () => {
  const unmatchedAt = (value: string, file: string) =>
    census.unmatchedItemReads.filter((r) => r.value === value && r.file.endsWith(file));

  test("expert.ts's dead 'commit' item-type read is unmatched", () => {
    const hits = unmatchedAt("commit", "agents/expert.ts");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.line === 386 && h.matchState === "unmatched")).toBe(true);
  });

  test("preflight's workflow_name read is unmatched (total absence)", () => {
    const hits = unmatchedAt("workflow_name", "preflight/preflight.ts");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.line === 166 && h.matchState === "unmatched")).toBe(true);
  });

  test("preflight's branch read is a PARTIAL match — only circleci emits it", () => {
    const hits = unmatchedAt("branch", "preflight/preflight.ts");
    const lines = new Set(hits.map((h) => h.line));
    expect(lines.has(168)).toBe(true);
    expect(lines.has(175)).toBe(true);
    for (const h of hits) {
      if (h.line !== 168 && h.line !== 175) continue;
      expect(h.matchState).toBe("partial");
      expect(h.partialCoverage).toBeDefined();
      expect(h.partialCoverage).toContain("circleci");
    }
  });

  test("premortem's opened_at_ms read is unmatched ONLY on pr-scoped rows, not dora's", () => {
    const premortemHits = unmatchedAt("opened_at_ms", "agents/premortem.ts");
    const premortemLines = new Set(premortemHits.map((h) => h.line));
    expect(premortemLines.has(199)).toBe(true);
    expect(premortemLines.has(205)).toBe(true);
    for (const h of premortemHits) {
      if (h.line === 199 || h.line === 205) expect(h.matchState).toBe("unmatched");
    }

    // The per-literal type-scoping guard: dora.ts reads the SAME key on a type that IS covered,
    // so it must never appear in unmatchedItemReads — only premortem.ts's pr-scoped reads should.
    const doraUnmatched = census.unmatchedItemReads.filter(
      (r) => r.value === "opened_at_ms" && r.file.endsWith("metrics/dora.ts"),
    );
    expect(doraUnmatched).toHaveLength(0);

    const doraReads = census.reads.filter(
      (r) => r.value === "opened_at_ms" && r.file.endsWith("metrics/dora.ts"),
    );
    expect(doraReads.length).toBeGreaterThan(0);
  });

  test("no writer from demo/ is counted — the vacuous-pass guard", () => {
    expect(census.writes.some((w) => w.file.includes("/demo/"))).toBe(false);
  });

  test("graph_entity's commit read is carried in reads but never gated in unmatchedItemReads", () => {
    const graphCommitReads = census.reads.filter(
      (r) => r.table === "graph_entity" && r.value === "commit",
    );
    expect(graphCommitReads.length).toBeGreaterThan(0);

    const graphInUnmatched = census.unmatchedItemReads.filter((r) => r.table === "graph_entity");
    expect(graphInUnmatched).toHaveLength(0);
  });

  test("ambiguity is disclosed, not hidden", () => {
    expect(census.ambiguousReadCount).toBeGreaterThanOrEqual(0);
  });

  test("the corpus is non-trivial — a magnitude bound, not an exact count", () => {
    // Deliberately loose: exact totals move whenever anyone adds a query elsewhere in the repo,
    // and a test that reds on unrelated work gets deleted rather than fixed. These bounds exist
    // only to catch a collection that silently returned nothing (e.g. a broken glob).
    expect(census.reads.length).toBeGreaterThan(50);
    expect(census.writes.length).toBeGreaterThan(20);
    expect(census.unmatchedItemReads.length).toBeGreaterThan(50);
  });
});
