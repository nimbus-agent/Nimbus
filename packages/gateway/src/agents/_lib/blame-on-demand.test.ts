import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { LocalIndex } from "../../index/local-index.ts";
import { lookupBlame, upsertBlameLines } from "../../security/blame-store.ts";
import { ensureBlameLine } from "./blame-on-demand.ts";

const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const ROOT = path.resolve(path.join(path.sep, "work", "repo"));

function freshDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

/** Real `git blame --line-porcelain` grammar for one line — the exact shape parseBlamePorcelain consumes. */
const PORCELAIN = [
  `${SHA} 42 42`,
  "author alice",
  "author-mail <alice@example.com>",
  "author-time 1700000000",
  "author-tz +0000",
  "\tconst x = 1;",
  "",
].join("\n");

type SpawnCounter = { count: number; spawn: typeof Bun.spawn };
function countingSpawn(stdout: string, exitCode = 0): SpawnCounter {
  const counter: SpawnCounter = {
    count: 0,
    spawn: ((..._args: unknown[]) => {
      counter.count += 1;
      return {
        exited: Promise.resolve(exitCode),
        stdout: new Response(stdout).body,
        stderr: new Response("").body,
      } as unknown as ReturnType<typeof Bun.spawn>;
    }) as typeof Bun.spawn,
  };
  return counter;
}

const tempDirs: string[] = [];

/** Create a fresh temp dir with a `.git` subdirectory so the fence's existsSync check passes. */
async function makeTempGitDir(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "why-blame-"));
  tempDirs.push(d);
  await fs.mkdir(path.join(d, ".git"));
  return d;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d !== undefined) {
      await fs.rm(d, { recursive: true, force: true });
    }
  }
});

test("DB hit → zero spawns", async () => {
  const db = freshDb();
  upsertBlameLines(db, ROOT, "src/a.ts", [
    {
      lineNo: 42,
      commitSha: SHA,
      authorName: "alice",
      authorEmail: "alice@example.com",
      authorTimeMs: 1_700_000_000_000,
    },
  ]);
  const c = countingSpawn(PORCELAIN);
  const out = await ensureBlameLine(db, { repoRoot: ROOT, filePath: "src/a.ts" }, 42, c.spawn);
  expect(out?.commitSha).toBe(SHA);
  expect(c.count).toBe(0);
});

test("miss → one spawn → row persisted → second call is a DB hit with zero further spawns", async () => {
  const db = freshDb();
  const c = countingSpawn(PORCELAIN);
  const tmp = await makeTempGitDir();
  const first = await ensureBlameLine(db, { repoRoot: tmp, filePath: "src/a.ts" }, 42, c.spawn);
  expect(first?.commitSha).toBe(SHA);
  expect(c.count).toBe(1);
  expect(lookupBlame(db, tmp, "src/a.ts", 42)?.commitSha).toBe(SHA);
  const second = await ensureBlameLine(db, { repoRoot: tmp, filePath: "src/a.ts" }, 42, c.spawn);
  expect(second?.commitSha).toBe(SHA);
  expect(c.count).toBe(1);
});

test("non-zero exit → null, no throw", async () => {
  const db = freshDb();
  const c = countingSpawn("", 128);
  const tmp = await makeTempGitDir();
  expect(await ensureBlameLine(db, { repoRoot: tmp, filePath: "src/a.ts" }, 1, c.spawn)).toBeNull();
});

test("a root with no .git directory → null and ZERO spawns", async () => {
  const db = freshDb();
  const c = countingSpawn(PORCELAIN);
  const out = await ensureBlameLine(db, { repoRoot: ROOT, filePath: "src/a.ts" }, 42, c.spawn);
  expect(out).toBeNull();
  expect(c.count).toBe(0);
});
