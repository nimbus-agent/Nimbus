import { describe, expect, test } from "bun:test";
import { collectLaneCensus } from "./check-index-lane-coverage.ts";
import type { FileEntry } from "./check-nimbus-invariants.ts";

describe("collectLaneCensus", () => {
  test("an item type no writer emits lands in unmatchedItemReads", () => {
    const census = collectLaneCensus([
      {
        relPath: "packages/gateway/src/agents/expert.ts",
        contents: "db.query(`SELECT 1 FROM item i WHERE i.type = 'commit'`);",
      },
      {
        relPath: "packages/gateway/src/connectors/fs-sync.ts",
        contents: 'ctx.upsertItem({ service: "filesystem", type: "git_commit", metadata: {} });',
      },
    ]);
    expect(census.unmatchedItemReads.map((r) => r.value)).toContain("commit");
  });

  test("a graph_entity read of the same literal does NOT satisfy the item read", () => {
    const census = collectLaneCensus([
      {
        relPath: "packages/gateway/src/agents/expert.ts",
        contents: "db.query(`SELECT 1 FROM item i WHERE i.type = 'commit'`);",
      },
      {
        relPath: "packages/gateway/src/graph/graph-populator.ts",
        contents: 'upsertGraphEntity({ type: "commit" });',
      },
    ]);
    expect(census.unmatchedItemReads.map((r) => r.value)).toContain("commit");
  });

  test("empty input yields an empty census, not a crash", () => {
    const census = collectLaneCensus([]);
    expect(census.reads).toHaveLength(0);
    expect(census.writes).toHaveLength(0);
    expect(census.unmatchedItemReads).toHaveLength(0);
    expect(census.ambiguousReadCount).toBe(0);
    expect(census.parameterizedReads).toHaveLength(0);
  });

  test("a metadata key matched under its OWN type is not unmatched", () => {
    const files: FileEntry[] = [
      {
        relPath: "packages/gateway/src/agents/x.ts",
        contents:
          "db.query(`SELECT 1 FROM item i WHERE i.type = 'pr' AND json_extract(i.metadata, '$.parent_key') = ?`);",
      },
      {
        relPath: "packages/gateway/src/connectors/pr-sync.ts",
        contents:
          'ctx.upsertItem({ service: "gitlab", type: "pr", metadata: { parent_key: pk } });',
      },
    ];
    const census = collectLaneCensus(files);
    expect(
      census.unmatchedItemReads.some((r) => r.kind === "metadata-key" && r.value === "parent_key"),
    ).toBe(false);
  });

  test("a metadata key emitted under a DIFFERENT type does not satisfy the read — the jira parent_key hazard", () => {
    // jira-sync emits parent_key under `issue`; a `pr`-scoped read of parent_key must NOT be
    // satisfied by that — global matching would be exactly the cross-context conflation this
    // whole gate exists to prevent.
    const files: FileEntry[] = [
      {
        relPath: "packages/gateway/src/agents/x.ts",
        contents:
          "db.query(`SELECT 1 FROM item i WHERE i.type = 'pr' AND json_extract(i.metadata, '$.parent_key') = ?`);",
      },
      {
        relPath: "packages/gateway/src/connectors/jira-sync.ts",
        contents:
          'ctx.upsertItem({ service: "jira", type: "issue", metadata: { parent_key: pk } });',
      },
    ];
    const census = collectLaneCensus(files);
    expect(
      census.unmatchedItemReads.some((r) => r.kind === "metadata-key" && r.value === "parent_key"),
    ).toBe(true);
  });

  test("a type IN (...) list scopes a sibling metadata key to ALL listed types", () => {
    const files: FileEntry[] = [
      {
        relPath: "packages/gateway/src/agents/x.ts",
        contents:
          "db.query(`SELECT 1 FROM item i WHERE i.type IN ('pr', 'issue') AND json_extract(i.metadata, '$.k') = ?`);",
      },
      {
        relPath: "packages/gateway/src/connectors/y-sync.ts",
        contents: 'ctx.upsertItem({ service: "y", type: "issue", metadata: { k: 1 } });',
      },
    ];
    const census = collectLaneCensus(files);
    expect(census.unmatchedItemReads.some((r) => r.value === "k")).toBe(false);
  });

  test("a JS-side metadata read with no type predicate is scoped __ANY__ and counted as ambiguous", () => {
    const files: FileEntry[] = [
      {
        relPath: "packages/gateway/src/metrics/x.ts",
        contents: 'if (meta["conclusion"] !== "success") continue;',
      },
    ];
    const census = collectLaneCensus(files);
    expect(census.ambiguousReadCount).toBe(1);
    expect(census.reads.some((r) => r.kind === "metadata-key" && r.value === "conclusion")).toBe(
      true,
    );
  });

  test("an __ANY__-scoped read matches against the union of every writer's keys, any type", () => {
    const files: FileEntry[] = [
      {
        relPath: "packages/gateway/src/metrics/x.ts",
        contents: 'if (meta["k"] !== undefined) continue;',
      },
      {
        relPath: "packages/gateway/src/connectors/z-sync.ts",
        contents: 'ctx.upsertItem({ service: "z", type: "widget", metadata: { k: 1 } });',
      },
    ];
    const census = collectLaneCensus(files);
    expect(census.ambiguousReadCount).toBe(1);
    expect(census.unmatchedItemReads.some((r) => r.value === "k")).toBe(false);
  });

  test("a /demo/ writer under WRITER_EXCLUDE is not scanned as a real writer", () => {
    const files: FileEntry[] = [
      {
        relPath: "packages/gateway/src/agents/x.ts",
        contents: "db.query(`SELECT 1 FROM item i WHERE i.type = 'ci_run'`);",
      },
      {
        relPath: "packages/gateway/src/demo/corpus/acme.ts",
        contents: 'ctx.upsertItem({ service: "github_actions", type: "ci_run", metadata: {} });',
      },
    ];
    const census = collectLaneCensus(files);
    expect(census.writes).toHaveLength(0);
    expect(census.unmatchedItemReads.some((r) => r.value === "ci_run")).toBe(true);
  });

  test("a non-connectors file is never scanned as a writer, even with a service+type object literal", () => {
    const files: FileEntry[] = [
      {
        relPath: "packages/gateway/src/agents/x.ts",
        contents: 'ctx.upsertItem({ service: "x", type: "y", metadata: {} });',
      },
    ];
    const census = collectLaneCensus(files);
    expect(census.writes).toHaveLength(0);
  });

  test("deployment/annotate.ts IS scanned as a writer (the one non-connectors WRITER_INCLUDE entry)", () => {
    const files: FileEntry[] = [
      {
        relPath: "packages/gateway/src/deployment/annotate.ts",
        contents: 'ctx.upsertItem({ service: "deploy", type: "deployment", metadata: {} });',
      },
    ];
    const census = collectLaneCensus(files);
    expect(census.writes).toHaveLength(1);
    expect(census.writes[0]?.itemType).toBe("deployment");
  });

  test("parameterizedReads lists every type = ? site by file and line", () => {
    const files: FileEntry[] = [
      {
        relPath: "packages/gateway/src/query/x.ts",
        contents: "db.query(`SELECT 1 FROM item i WHERE i.type = ?`);",
      },
    ];
    const census = collectLaneCensus(files);
    expect(census.parameterizedReads).toEqual([
      { file: "packages/gateway/src/query/x.ts", line: 1 },
    ]);
  });

  test("a type = ? site never produces a matched/unmatched read triple", () => {
    const files: FileEntry[] = [
      {
        relPath: "packages/gateway/src/query/x.ts",
        contents: "db.query(`SELECT 1 FROM item i WHERE i.type = ?`);",
      },
    ];
    const census = collectLaneCensus(files);
    expect(census.reads.some((r) => r.kind === "type")).toBe(false);
    expect(census.unmatchedItemReads).toHaveLength(0);
  });

  test("an __UNRESOLVED__ writer type never accidentally matches a real type read", () => {
    const files: FileEntry[] = [
      {
        relPath: "packages/gateway/src/agents/x.ts",
        contents: "db.query(`SELECT 1 FROM item i WHERE i.type = 'incident'`);",
      },
      {
        relPath: "packages/gateway/src/connectors/dyn-sync.ts",
        contents: "ctx.upsertItem({ service: 'x', type: computeType(), metadata: {} });",
      },
    ];
    const census = collectLaneCensus(files);
    expect(census.writes[0]?.itemType).toBe("__UNRESOLVED__");
    expect(census.unmatchedItemReads.some((r) => r.value === "incident")).toBe(true);
  });

  test("graph_entity and graph_relation reads are carried in reads but never gated in unmatchedItemReads", () => {
    const files: FileEntry[] = [
      {
        relPath: "packages/gateway/src/agents/x.ts",
        contents: "db.query(`SELECT 1 FROM graph_entity ge WHERE ge.type = 'nobody_writes_this'`);",
      },
    ];
    const census = collectLaneCensus(files);
    expect(
      census.reads.some((r) => r.table === "graph_entity" && r.value === "nobody_writes_this"),
    ).toBe(true);
    expect(census.unmatchedItemReads).toHaveLength(0);
  });
});
