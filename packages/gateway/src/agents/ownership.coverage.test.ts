import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { DEFAULT_NIMBUS_OWNERSHIP_TOML } from "../config/nimbus-toml.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { runOwnershipPass } from "../ownership/ownership-pass.ts";
import { runOwnership } from "./ownership.ts";

/**
 * Paths through `runOwnership` that `ownership.test.ts` never takes: a top-level file, whose parent
 * directory is the repository root; a path that resolves inside a root but has no ownership node;
 * files excluded by `[ownership].ignore_globs`; and a pass that covered only some of the configured
 * roots. The last two notes are each gated on the counter that proves it bit, so their tests also
 * pin the note's silence when that counter is zero.
 */

const NOW = 1_800_000_000_000;
const ROOT = "/repo/alpha";
const SECOND_ROOT = "/repo/beta";
const alwaysExists = (): boolean => true;

let d: Database;

beforeEach(() => {
  d = new Database(":memory:");
  runIndexedSchemaMigrations(d, CURRENT_SCHEMA_VERSION);
});

afterEach(() => {
  d.close();
});

function blame(root: string, filePath: string, lines: number): void {
  for (let line = 1; line <= lines; line++) {
    d.run(
      `INSERT INTO git_blame_line
         (repo_root, file_path, line_no, commit_sha, author_name, author_email, author_time_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [root, filePath, line, `sha${String(line)}`, "Ann", "a@x.com", NOW - 86_400_000],
    );
  }
}

async function pass(roots: readonly string[], ignoreGlobs: readonly string[] = []): Promise<void> {
  await runOwnershipPass(d, {
    nowMs: NOW,
    roots: [...roots],
    config: { ...DEFAULT_NIMBUS_OWNERSHIP_TOML, ignoreGlobs: [...ignoreGlobs] },
    serviceRepoUrns: new Map<string, readonly string[]>(),
    spawn: (() => {
      throw new Error("git unavailable");
    }) as unknown as typeof Bun.spawn,
  });
}

function ctx(roots: readonly string[] = [ROOT]) {
  return { db: d, roots, notify: () => {}, sessionId: "s-cov" };
}

const EXCLUDED_NOTE = "were excluded from aggregation";
const PARTIAL_NOTE = "root(s) were covered by the last pass";
const NO_NODE_NOTE = "resolved to a configured root but has no ownership node";

test("a top-level file's parent directory is the repository root", async () => {
  blame(ROOT, "README.md", 2);
  await pass([ROOT]);

  const brief = await runOwnership({ path: "README.md" }, ctx(), alwaysExists);

  expect(brief.target?.kind).toBe("source_file");
  expect(brief.target?.displayPath).toBe("README.md");
  expect(brief.parentDirectory?.kind).toBe("directory");
  expect(brief.parentDirectory?.displayPath).toBe("(repository root)");
});

test("a path inside a root with no ownership node is named in its own gap, not as outside every root", async () => {
  blame(ROOT, "src/a.ts", 2);
  await pass([ROOT]);

  const brief = await runOwnership({ path: "src/never-blamed.ts" }, ctx(), alwaysExists);

  expect(brief.target).toBeNull();
  const noNode = brief.gaps.filter((g) => g.detail.includes(NO_NODE_NOTE));
  expect(noNode).toHaveLength(1);
  expect(noNode[0]?.category).toBe("missing_entity_type");
  expect(noNode[0]?.detail.startsWith("`src/never-blamed.ts` resolved")).toBe(true);
  expect(brief.gaps.some((g) => g.detail.includes("outside every configured root"))).toBe(false);
});

test("files excluded by ignore_globs are disclosed with their count", async () => {
  blame(ROOT, "src/a.ts", 2);
  blame(ROOT, "src/api.gen.ts", 3);
  blame(ROOT, "src/types.gen.ts", 1);
  await pass([ROOT], ["**/*.gen.ts"]);

  const brief = await runOwnership({ path: "src/a.ts" }, ctx(), alwaysExists);

  expect(brief.coverage.filesExcluded).toBe(2);
  const excluded = brief.gaps.filter((g) => g.detail.includes(EXCLUDED_NOTE));
  expect(excluded).toHaveLength(1);
  expect(excluded[0]?.category).toBe("missing_relation_emit");
  expect(excluded[0]?.detail.startsWith("2 file(s) were excluded")).toBe(true);
  // One root, fully covered: the partial-coverage note must stay silent.
  expect(brief.gaps.some((g) => g.detail.includes(PARTIAL_NOTE))).toBe(false);
});

test("with nothing excluded the exclusion note stays silent", async () => {
  blame(ROOT, "src/a.ts", 2);
  await pass([ROOT], ["**/*.gen.ts"]);

  const brief = await runOwnership({ path: "src/a.ts" }, ctx(), alwaysExists);

  expect(brief.coverage.filesExcluded).toBe(0);
  expect(brief.gaps.some((g) => g.detail.includes(EXCLUDED_NOTE))).toBe(false);
});

test("a root the pass found no blame for makes coverage partial, and says how partial", async () => {
  blame(ROOT, "src/a.ts", 2);
  await pass([ROOT, SECOND_ROOT]);

  const brief = await runOwnership({}, ctx([ROOT, SECOND_ROOT]), alwaysExists);

  expect(brief.coverage.rootsTotal).toBe(2);
  expect(brief.coverage.rootsCovered).toBe(1);
  const partial = brief.gaps.filter((g) => g.detail.includes(PARTIAL_NOTE));
  expect(partial).toHaveLength(1);
  expect(partial[0]?.category).toBe("missing_connector");
  expect(partial[0]?.detail.startsWith("1 of 2 root(s)")).toBe(true);
  expect(brief.gaps.some((g) => g.detail.includes(EXCLUDED_NOTE))).toBe(false);
});
