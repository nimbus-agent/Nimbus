import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mergeShardsToLcov } from "./merge-coverage.ts";

// A minimal istanbul fileCoverage for an absolute file with one covered line
// and one branch (one outcome taken, one not).
function fc(absPath: string) {
  return {
    path: absPath,
    statementMap: { "0": { start: { line: 1, column: 0 }, end: { line: 1, column: 9 } } },
    s: { "0": 1 },
    fnMap: {},
    f: {},
    branchMap: { "0": { type: "if", line: 1, loc: { start: { line: 1, column: 0 }, end: { line: 1, column: 0 } }, locations: [{ start: { line: 1, column: 0 }, end: { line: 1, column: 0 } }, { start: { line: 1, column: 0 }, end: { line: 1, column: 0 } }] } },
    b: { "0": [1, 0] },
  };
}

describe("mergeShardsToLcov", () => {
  test("merges shards and writes a repo-root-relative lcov with BRDA", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "cov-merge-"));
    const tmp = join(repoRoot, "coverage", ".nyc-tmp");
    mkdirSync(tmp, { recursive: true });
    const abs = join(repoRoot, "packages", "gateway", "src", "a.ts");
    writeFileSync(join(tmp, "111.json"), JSON.stringify({ [abs]: fc(abs) }));

    const result = mergeShardsToLcov(repoRoot);
    expect(result).toBe(1);

    const out = join(repoRoot, "coverage", "lcov.info");
    expect(existsSync(out)).toBe(true);
    const text = readFileSync(out, "utf8");
    expect(text).toContain("SF:packages/gateway/src/a.ts");
    expect(text).toContain("BRDA:");

    // Shard dir must be cleaned up after merge (Fix I1).
    expect(existsSync(tmp)).toBe(false);
  });

  test("skips corrupt shards and still writes lcov for valid ones", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "cov-merge-corrupt-"));
    const tmp = join(repoRoot, "coverage", ".nyc-tmp");
    mkdirSync(tmp, { recursive: true });
    const abs = join(repoRoot, "packages", "gateway", "src", "b.ts");
    // One valid shard.
    writeFileSync(join(tmp, "222.json"), JSON.stringify({ [abs]: fc(abs) }));
    // One corrupt shard — must be skipped with a warning, not abort the merge.
    writeFileSync(join(tmp, "bad.json"), "not json{");

    const result = mergeShardsToLcov(repoRoot);
    // Only the valid shard counted.
    expect(result).toBe(1);

    const out = join(repoRoot, "coverage", "lcov.info");
    expect(existsSync(out)).toBe(true);
    const text = readFileSync(out, "utf8");
    expect(text).toContain("SF:");

    // Shard dir must still be cleaned up even when a shard was skipped.
    expect(existsSync(tmp)).toBe(false);
  });
});
