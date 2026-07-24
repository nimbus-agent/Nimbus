import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extensionProcessEnv } from "../extensions/spawn-env.ts";
import {
  createBlameIndexSyncable,
  gitBlameWholeFile,
  gitBlameWindowFiles,
  gitChangedSince,
  gitHeadSha,
  isAncestor,
} from "./blame-index-sync.ts";
import {
  createMemoryIndexDb,
  createStubVault,
  syncTestContext,
} from "./connector-sync-test-helpers.ts";

/** A Bun.spawn stand-in returning a fixed exit code + stdout. */
function fakeSpawn(out: string, code: number): typeof Bun.spawn {
  return (() =>
    ({
      exited: Promise.resolve(code),
      stdout: new Response(out).body,
    }) as unknown as ReturnType<typeof Bun.spawn>) as unknown as typeof Bun.spawn;
}

/** A Bun.spawn stand-in that throws (ENOENT / abort). */
const throwingSpawn = (() => {
  throw new Error("spawn failed");
}) as unknown as typeof Bun.spawn;

const SHA_A = "a".repeat(40);
const SHA_F = "f".repeat(40);

describe("gitHeadSha", () => {
  test("returns a 40-hex sha on exit 0", async () => {
    expect(await gitHeadSha("/r", fakeSpawn(`${SHA_A}\n`, 0))).toBe(SHA_A);
  });

  test("returns null on a non-zero exit", async () => {
    expect(await gitHeadSha("/r", fakeSpawn("", 128))).toBeNull();
  });

  test("returns null when the output is not a 40-hex sha", async () => {
    expect(await gitHeadSha("/r", fakeSpawn("not-a-sha\n", 0))).toBeNull();
  });

  test("returns null when the spawn throws (git missing / timeout)", async () => {
    expect(await gitHeadSha("/r", throwingSpawn)).toBeNull();
  });
});

describe("isAncestor", () => {
  test("true on exit 0", async () => {
    expect(await isAncestor("/r", SHA_A, fakeSpawn("", 0))).toBe(true);
  });

  test("false on a non-zero exit (rewritten history)", async () => {
    expect(await isAncestor("/r", SHA_A, fakeSpawn("", 1))).toBe(false);
  });
});

describe("gitBlameWindowFiles", () => {
  test("dedupes NUL-separated names", async () => {
    const files = await gitBlameWindowFiles("/r", 90, fakeSpawn("a.ts\0b.ts\0a.ts\0", 0));
    expect(new Set(files)).toEqual(new Set(["a.ts", "b.ts"]));
  });

  test("returns [] on a non-zero exit", async () => {
    expect(await gitBlameWindowFiles("/r", 90, fakeSpawn("a.ts\0", 1))).toEqual([]);
  });
});

describe("gitChangedSince", () => {
  test("parses A/M/D and expands renames to D + A", async () => {
    const changes = await gitChangedSince(
      "/r",
      SHA_F,
      fakeSpawn("M\0a.ts\0D\0b.ts\0A\0c.ts\0R100\0old.ts\0new.ts\0", 0),
    );
    expect(changes).toContainEqual({ status: "M", path: "a.ts" });
    expect(changes).toContainEqual({ status: "D", path: "b.ts" });
    expect(changes).toContainEqual({ status: "A", path: "c.ts" });
    expect(changes).toContainEqual({ status: "D", path: "old.ts" });
    expect(changes).toContainEqual({ status: "A", path: "new.ts", oldPath: "old.ts" });
  });

  test("maps an unknown status code (e.g. copy/type-change) to a modification", async () => {
    const changes = await gitChangedSince("/r", SHA_F, fakeSpawn("T\0typed.ts\0", 0));
    expect(changes).toEqual([{ status: "M", path: "typed.ts" }]);
  });

  test("returns [] on a non-zero exit", async () => {
    expect(await gitChangedSince("/r", SHA_F, fakeSpawn("M\0a.ts\0", 1))).toEqual([]);
  });
});

describe("gitBlameWholeFile", () => {
  test("parses porcelain rows", async () => {
    const out = [
      `${"1".repeat(40)} 1 1 1`,
      "author Ada",
      "author-mail <ada@x>",
      "author-time 1700000000",
      "\tconst k = 1",
      "",
    ].join("\n");
    const rows = await gitBlameWholeFile("/r", "x.ts", fakeSpawn(out, 0));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.commitSha).toBe("1".repeat(40));
    expect(rows[0]?.lineNo).toBe(1);
  });

  test("returns [] on a non-zero exit", async () => {
    expect(await gitBlameWholeFile("/r", "x.ts", fakeSpawn("", 128))).toEqual([]);
  });
});

// --- Integration: a real temp git repo (real subprocesses, real SQLite) ---

const GIT_ENV = extensionProcessEnv({
  GIT_AUTHOR_NAME: "T",
  GIT_AUTHOR_EMAIL: "t@x.dev",
  GIT_COMMITTER_NAME: "T",
  GIT_COMMITTER_EMAIL: "t@x.dev",
});

function git(root: string, ...args: string[]): void {
  const res = Bun.spawnSync(["git", "-C", root, ...args], { env: GIT_ENV });
  if (res.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr.toString()}`);
  }
}

function blameRootConfig(path: string) {
  return { path, gitAware: true, codeIndex: false, dependencyGraph: false, exclude: [] };
}

function countBlame(
  db: ReturnType<typeof createMemoryIndexDb>,
  root: string,
  file: string,
): number {
  const row = db
    .query("SELECT COUNT(*) AS c FROM git_blame_line WHERE repo_root = ? AND file_path = ?")
    .get(root, file) as { c: number };
  return row.c;
}

describe("createBlameIndexSyncable (real repo)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  function newRepo(): string {
    const root = mkdtempSync(join(tmpdir(), "blame-idx-"));
    dirs.push(root);
    git(root, "init", "-q");
    return root;
  }

  test("noop when there are no roots", async () => {
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, createStubVault({}));
    const syncable = createBlameIndexSyncable({ roots: [] });
    const res = await syncable.sync(ctx, null);
    expect(res.itemsUpserted).toBe(0);
    expect(res.cursor).toBeNull();
  });

  test("full path: blames the window files into git_blame_line + encodes a cursor", async () => {
    const root = newRepo();
    writeFileSync(join(root, "x.ts"), "const a = 1\nconst b = 2\n");
    writeFileSync(join(root, "y.ts"), "export const c = 3\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "init");

    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, createStubVault({}));
    const syncable = createBlameIndexSyncable({ roots: [blameRootConfig(root)], windowDays: 90 });

    const res = await syncable.sync(ctx, null);

    expect(countBlame(db, root, "x.ts")).toBe(2);
    expect(countBlame(db, root, "y.ts")).toBe(1);
    expect(res.itemsUpserted).toBe(2); // two files blamed this tick
    expect(res.cursor).toContain("nimbus-blame1:");
  });

  test("incremental path: only changed files re-blamed, deleted file pruned", async () => {
    const root = newRepo();
    writeFileSync(join(root, "a.ts"), "1\n2\n");
    writeFileSync(join(root, "b.ts"), "keep\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "c1");

    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, createStubVault({}));
    const syncable = createBlameIndexSyncable({ roots: [blameRootConfig(root)], windowDays: 90 });
    const first = await syncable.sync(ctx, null);
    expect(countBlame(db, root, "a.ts")).toBe(2);
    expect(countBlame(db, root, "b.ts")).toBe(1);

    // Second commit: modify a.ts (grows to 3 lines), delete b.ts, add c.ts.
    writeFileSync(join(root, "a.ts"), "1\n2\n3\n");
    rmSync(join(root, "b.ts"));
    writeFileSync(join(root, "c.ts"), "new\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "c2");

    const second = await syncable.sync(ctx, first.cursor);

    expect(countBlame(db, root, "a.ts")).toBe(3); // re-blamed
    expect(countBlame(db, root, "b.ts")).toBe(0); // pruned on delete
    expect(countBlame(db, root, "c.ts")).toBe(1); // added
    expect(second.cursor).toContain("nimbus-blame1:");
  });

  test("history rewrite: a non-ancestor cursor falls back to a full re-blame", async () => {
    const root = newRepo();
    writeFileSync(join(root, "a.ts"), "1\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "c1");

    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, createStubVault({}));
    const syncable = createBlameIndexSyncable({ roots: [blameRootConfig(root)], windowDays: 90 });
    const first = await syncable.sync(ctx, null);
    expect(countBlame(db, root, "a.ts")).toBe(1);

    // Rewrite history so the recorded head is no longer an ancestor of HEAD.
    writeFileSync(join(root, "a.ts"), "1\n2\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "--amend", "-m", "c1-amended");

    const second = await syncable.sync(ctx, first.cursor);

    // Full re-blame ran (isAncestor(false) → window path), picking up the 2 lines.
    expect(countBlame(db, root, "a.ts")).toBe(2);
    expect(second.itemsUpserted).toBeGreaterThan(0);
  });

  test("a malformed cursor is ignored and the tick runs the full path", async () => {
    const root = newRepo();
    writeFileSync(join(root, "x.ts"), "a\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "init");

    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, createStubVault({}));
    const syncable = createBlameIndexSyncable({ roots: [blameRootConfig(root)], windowDays: 90 });

    const res = await syncable.sync(ctx, "not-a-valid-cursor");

    expect(countBlame(db, root, "x.ts")).toBe(1);
    expect(res.cursor).toContain("nimbus-blame1:");
  });

  test("an empty (zero-line) file is not counted but does not error", async () => {
    const root = newRepo();
    writeFileSync(join(root, "empty.ts"), "");
    writeFileSync(join(root, "one.ts"), "a\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "init");

    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, createStubVault({}));
    const syncable = createBlameIndexSyncable({ roots: [blameRootConfig(root)], windowDays: 90 });

    const res = await syncable.sync(ctx, null);

    expect(countBlame(db, root, "empty.ts")).toBe(0);
    expect(countBlame(db, root, "one.ts")).toBe(1);
    expect(res.itemsUpserted).toBe(1); // only the non-empty file counts
  });

  test("skips a root path that is a file, not a directory", async () => {
    const root = newRepo();
    const filePath = join(root, "a-file.ts");
    writeFileSync(filePath, "x\n");

    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, createStubVault({}));
    const syncable = createBlameIndexSyncable({
      roots: [blameRootConfig(filePath)],
      windowDays: 90,
    });
    const res = await syncable.sync(ctx, null);

    expect(res.itemsUpserted).toBe(0);
  });

  test("skips a root that is not a git repository", async () => {
    const plain = mkdtempSync(join(tmpdir(), "blame-plain-"));
    dirs.push(plain);
    writeFileSync(join(plain, "a.ts"), "1\n");

    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, createStubVault({}));
    const syncable = createBlameIndexSyncable({ roots: [blameRootConfig(plain)], windowDays: 90 });
    const res = await syncable.sync(ctx, null);

    expect(res.itemsUpserted).toBe(0);
    expect(countBlame(db, plain, "a.ts")).toBe(0);
  });
});
