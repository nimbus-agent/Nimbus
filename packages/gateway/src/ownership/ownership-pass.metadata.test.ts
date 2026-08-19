import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import { DEFAULT_NIMBUS_OWNERSHIP_TOML } from "../config/nimbus-toml.ts";
import { syncGraphFromIndexedItem } from "../graph/graph-populator.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { runOwnershipPass } from "./ownership-pass.ts";
import { findFileEntity } from "./ownership-store.ts";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const ROOT = "/repo/alpha";

/** Mirrors `ownership-pass.test.ts`'s own `seedLine` — not exported, so reproduced here
 * rather than reaching into that file's module internals. */
function seedLine(
  d: Database,
  file: string,
  lineNo: number,
  email: string,
  name: string,
  ageDays: number,
): void {
  d.run(
    `INSERT INTO git_blame_line
       (repo_root, file_path, line_no, commit_sha, author_name, author_email, author_time_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [ROOT, file, lineNo, `sha${String(lineNo)}`, name, email, NOW - ageDays * DAY],
  );
}

const noRemote: typeof Bun.spawn = (() => {
  throw new Error("git unavailable");
}) as unknown as typeof Bun.spawn;

function baseOpts(over: Partial<Parameters<typeof runOwnershipPass>[1]> = {}) {
  return {
    nowMs: NOW,
    roots: [ROOT],
    config: { ...DEFAULT_NIMBUS_OWNERSHIP_TOML, ignoreGlobs: [] },
    serviceRepoUrns: new Map<string, readonly string[]>(),
    spawn: noRemote,
    ...over,
  };
}

describe("owner counts vs. the code-symbol sync (THE BUG)", () => {
  let d: Database;
  beforeEach(() => {
    d = new Database(":memory:");
    runIndexedSchemaMigrations(d, CURRENT_SCHEMA_VERSION);
  });

  // THE BUG. Before this task: ownership writes owner counts on a `source_file`; the
  // code-symbol sync writes the SAME entity with no metadata and `metadata =
  // excluded.metadata` NULLs them; `nimbus owners` then falls through to the branch meant
  // for legacy pre-split rows. The counts must SURVIVE a symbol sync.
  test("owner counts survive a code-symbol sync over the same file", async () => {
    seedLine(d, "a.ts", 1, "a@x.com", "A", 0);
    seedLine(d, "a.ts", 2, "b@x.com", "B", 0);
    await runOwnershipPass(d, baseOpts());

    const before = findFileEntity(d, ROOT, "a.ts");
    expect(before?.counts.ownerCount).not.toBeNull();
    expect(before?.counts.ownerCount).toBe(2);
    // Both authors own exactly one line each (0.5 share), clearing the default 5% floor
    // with the default cap of 10 never binding — pinned concretely so the post-sync
    // comparison below rests on known values, not on two possibly-null/possibly-equal
    // sides that would pass vacuously if the metadata went missing on both ends.
    expect(before?.counts.ownersAboveFloor).toBe(2);
    expect(before?.counts.truncated).toBe(false);

    // Exactly what `graph/graph-populator.ts`'s `syncCodeSymbolGraph` does on a
    // real code-symbol sync: the same `source_file` external id, via the same
    // populator entry point a real sync goes through.
    syncGraphFromIndexedItem(d, {
      id: "code_symbol:foo",
      service: "filesystem",
      type: "code_symbol",
      title: "foo",
      bodyPreview: null,
      authorId: null,
      metadata: { file: "a.ts", name: "foo", repoRoot: ROOT },
    });

    const after = findFileEntity(d, ROOT, "a.ts");
    expect(after?.counts.ownerCount).toBe(before?.counts.ownerCount);
    expect(after?.counts.ownersAboveFloor).toBe(before?.counts.ownersAboveFloor);
    expect(after?.counts.truncated).toBe(before?.counts.truncated);
  });
});
