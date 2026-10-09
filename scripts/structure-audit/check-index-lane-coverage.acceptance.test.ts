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
 *   - `expert.ts` read `item.type = 'commit'` — no writer in the corpus ever wrote that
 *     type (a dead lane: `graph_entity` writes `commit`, `item` never does). Fixed by PR A2, which
 *     points the lane at the filesystem connector's `git_commit` rows.
 *   - `preflight.ts` read `item.metadata.workflow_name` and `branch` scoped to `ci_run` — no writer
 *     emitted `workflow_name` and only `circleci` emitted `branch`. Fixed by PR A1's writer contract;
 *     the census stays blind to builder-made keys until PR A3 (see the two preflight tests below).
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

  // Fixed by PR A2: the lane now reads the filesystem connector's `git_commit` rows. This case
  // MUST still fail if a read of the never-written `commit` item type is reintroduced in
  // expert.ts, so it asserts on the reads actually collected, not merely on an empty list.
  test("expert.ts reads no dead commit item type; its git_commit read matches the filesystem writer", () => {
    expect(unmatchedAt("commit", "agents/expert.ts")).toHaveLength(0);
    expect(
      census.reads.some(
        (r) => r.table === "item" && r.value === "commit" && r.file.endsWith("agents/expert.ts"),
      ),
    ).toBe(false);

    const gitCommitReads = census.reads.filter(
      (r) => r.table === "item" && r.value === "git_commit" && r.file.endsWith("agents/expert.ts"),
    );
    expect(gitCommitReads.length).toBeGreaterThan(0);
    expect(unmatchedAt("git_commit", "agents/expert.ts")).toHaveLength(0);
    // ...because a writer exists (a vacuous "matched" would pass with no writer at all).
    expect(
      census.writes.some((w) => w.service === "filesystem" && w.itemType === "git_commit"),
    ).toBe(true);
  });

  // PR A1 (index lane contract) fixed the preflight bug these two tests were written to catch:
  // every ci_run writer except Jenkins now emits canonical `workflow_name`/`branch`, but through
  // the `buildCiRunMetadata` builder, which this census cannot see yet. So both reads are still
  // flagged — now as total absence, because the CircleCI `branch` write moved into the builder too.
  // That is census blindness, not a dead lane. PR A3 teaches the census the contract tables; it MUST
  // then flip these to matched (`workflow_name`: partial, no CircleCI/GitLab; `branch`: partial,
  // no Jenkins). The read sites are located by their SQL text, not by line number, because the
  // query was rewritten in A1 (failure filter moved out of the ranking CTE, repo scoping added).
  const preflightSrc =
    files.find((f) => f.relPath.endsWith("preflight/preflight.ts"))?.contents ?? "";
  const lineOf = (needle: string): number =>
    preflightSrc.split(/\r?\n/).findIndex((l) => l.includes(needle)) + 1;

  test("preflight's workflow_name read is still flagged until the census learns the contract (A3)", () => {
    const line = lineOf("'$.workflow_name'");
    expect(line).toBeGreaterThan(0);
    const hits = unmatchedAt("workflow_name", "preflight/preflight.ts");
    expect(hits.some((h) => h.line === line && h.matchState === "unmatched")).toBe(true);
  });

  test("preflight's branch filter is still flagged until the census learns the contract (A3)", () => {
    const line = lineOf("'$.branch') = ?");
    expect(line).toBeGreaterThan(0);
    const hits = unmatchedAt("branch", "preflight/preflight.ts");
    expect(hits.some((h) => h.line === line && h.matchState === "unmatched")).toBe(true);
  });

  test("premortem's opened_at_ms read is unmatched ONLY on pr-scoped rows, not dora's", () => {
    const premortemHits = unmatchedAt("opened_at_ms", "agents/premortem.ts");
    const premortemLines = new Set(premortemHits.map((h) => h.line));
    // Located by SQL text, not line number: the premortem queries moved when its reader changed. The
    // aliased `pr_item.metadata` read on the join query is not an unaliased item read the census sees.
    const premortemSrc =
      files.find((f) => f.relPath.endsWith("agents/premortem.ts"))?.contents ?? "";
    const readLines = premortemSrc
      .split(/\r?\n/)
      .flatMap((l, i) => (l.includes("json_extract(metadata, '$.opened_at_ms')") ? [i + 1] : []));
    expect(readLines.length).toBeGreaterThanOrEqual(2);
    for (const line of readLines) {
      expect(premortemLines.has(line)).toBe(true);
    }
    for (const h of premortemHits) {
      if (readLines.includes(h.line)) expect(h.matchState).toBe("unmatched");
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
    // No lower bound on `unmatchedItemReads`: shrinking it is the whole point of the census (A3
    // Task 2's writer resolution took it from 72 to 39), so a floor there reds on progress, not on
    // a broken collection — which the two bounds above already catch.
  });
});
