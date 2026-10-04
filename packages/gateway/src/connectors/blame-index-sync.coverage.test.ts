/**
 * Blame-indexer paths `blame-index-sync.test.ts` does not reach: truncated `git diff` output, a
 * cursor whose `heads` are malformed, a window larger than the per-tick cap, and an incremental
 * change whose file is gone from the working tree.
 *
 * The two real-repo tests make the blamed files exist only in history, never in the working tree,
 * so each one takes the "gone from disk" exit before any `git blame` subprocess. That keeps a
 * 401-file window cheap on every platform.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino, { type Logger } from "pino";

import { extensionProcessEnv } from "../extensions/spawn-env.ts";
import type { SyncContext } from "../sync/types.ts";
import { type BlameChange, createBlameIndexSyncable, gitChangedSince } from "./blame-index-sync.ts";
import {
  createMemoryIndexDb,
  createStubVault,
  syncTestContext,
} from "./connector-sync-test-helpers.ts";
import { decodeNimbusJsonCursorPayload, encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";

const CURSOR_PREFIX = "nimbus-blame1:";

/** A Bun.spawn stand-in returning a fixed exit code + stdout. */
function fakeSpawn(out: string, code = 0): typeof Bun.spawn {
  return (() =>
    ({
      exited: Promise.resolve(code),
      stdout: new Response(out).body,
    }) as unknown as ReturnType<typeof Bun.spawn>) as unknown as typeof Bun.spawn;
}

const GIT_ENV = extensionProcessEnv({
  GIT_AUTHOR_NAME: "T",
  GIT_AUTHOR_EMAIL: "t@x.dev",
  GIT_COMMITTER_NAME: "T",
  GIT_COMMITTER_EMAIL: "t@x.dev",
});

function git(root: string, ...args: string[]): string {
  return gitWithInput(root, undefined, ...args);
}

function gitWithInput(root: string, stdin: string | undefined, ...args: string[]): string {
  const res = Bun.spawnSync(["git", "-C", root, "-c", "commit.gpgsign=false", ...args], {
    env: GIT_ENV,
    windowsHide: true,
    ...(stdin === undefined ? {} : { stdin: Buffer.from(stdin, "utf8") }),
  });
  if (res.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr.toString()}`);
  }
  return res.stdout.toString().trim();
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function newRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "nimbus-blame-cov-"));
  dirs.push(root);
  git(root, "init", "-q");
  return root;
}

function rootCfg(path: string) {
  return {
    path,
    gitAware: true,
    codeIndex: false,
    dependencyGraph: false,
    mediaIndex: false,
    exclude: [],
  };
}

function headsOf(cursor: string | null): Record<string, unknown> {
  const p = decodeNimbusJsonCursorPayload(cursor ?? "", CURSOR_PREFIX) as {
    heads: Record<string, unknown>;
  };
  return p.heads;
}

/** A context that counts prunes and keeps its info/warn log lines. */
function observedContext(db: ReturnType<typeof createMemoryIndexDb>) {
  const raw: string[] = [];
  const logger: Logger = pino({ level: "info" }, { write: (s: string) => raw.push(s) });
  const base = syncTestContext(db, createStubVault({}), "blame");
  const pruned: string[] = [];
  const ctx: SyncContext = {
    ...base,
    logger,
    pruneBlameForFile: (root, file) => {
      pruned.push(file);
      base.pruneBlameForFile(root, file);
    },
  };
  return { ctx, pruned, logs: () => raw.map((s) => JSON.parse(s) as Record<string, unknown>) };
}

describe("gitChangedSince over truncated output", () => {
  const cases: Array<[string, string, BlameChange[]]> = [
    ["a status with no path", "M\0", [{ status: "M", path: "" }]],
    [
      "a rename missing its new path",
      "R100\0old.ts\0",
      [
        { status: "D", path: "old.ts" },
        { status: "A", path: "", oldPath: "old.ts" },
      ],
    ],
    [
      "a rename with no paths at all",
      "R100\0",
      [
        { status: "D", path: "" },
        { status: "A", path: "", oldPath: "" },
      ],
    ],
  ];

  test.each(cases)("%s yields empty paths, never undefined ones", async (_label, out, expected) => {
    expect(await gitChangedSince("/r", "a".repeat(40), fakeSpawn(out))).toEqual(expected);
  });
});

describe("cursor heads", () => {
  // A root that does not exist is skipped before any git call, so these runs touch no repo: the
  // only thing that reaches the output cursor is what decoding kept from the input cursor.
  function missingRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-blame-cov-"));
    dirs.push(dir);
    return join(dir, "gone");
  }

  test.each([
    ["a non-object heads value", "not an object", {}],
    ["a null heads value", null, {}],
    ["heads with a non-string entry", { "/kept": "abc", "/dropped": 5 }, { "/kept": "abc" }],
  ])("%s is decoded to only the string heads it holds", async (_label, heads, expected) => {
    const root = missingRoot();
    const db = createMemoryIndexDb();
    const syncable = createBlameIndexSyncable({ roots: [rootCfg(root)] });

    const r = await syncable.sync(
      syncTestContext(db, createStubVault({}), "blame"),
      encodeNimbusJsonCursor(CURSOR_PREFIX, { heads }),
    );

    expect(headsOf(r.cursor)).toEqual(expected);
    db.close();
  });
});

describe("real repositories", () => {
  test("a window larger than the per-tick cap is logged and only the first 400 files are visited", async () => {
    const root = newRepo();
    // 401 paths committed straight into the index, all pointing at one blob, so no file is ever
    // written to the working tree: in history but gone from disk, each visit prunes and then skips
    // the blame spawn. (Writing and deleting 401 real files cost seconds on Windows.)
    const blob = gitWithInput(root, "content\n", "hash-object", "-w", "--stdin");
    const entries = Array.from(
      { length: 401 },
      (_, i) => `100644 ${blob}\tf${String(i).padStart(3, "0")}.txt`,
    );
    gitWithInput(root, `${entries.join("\n")}\n`, "update-index", "--index-info");
    git(root, "commit", "-q", "-m", "many files");
    const head = git(root, "rev-parse", "HEAD");
    const db = createMemoryIndexDb();
    const { ctx, pruned, logs } = observedContext(db);

    const r = await createBlameIndexSyncable({ roots: [rootCfg(root)] }).sync(ctx, null);

    const capped = logs().filter(
      (l) => l["msg"] === "blame window exceeds per-tick cap; remainder picked up on later ticks",
    );
    expect(capped).toHaveLength(1);
    expect(capped[0]?.["total"]).toBe(401);
    expect(capped[0]?.["cap"]).toBe(400);
    expect(pruned).toHaveLength(400);
    expect(r.itemsUpserted).toBe(0);
    expect(headsOf(r.cursor)).toEqual({ [root]: head });
    db.close();
  });

  test("an incremental change whose file is gone from disk is pruned, not counted, and the head still advances", async () => {
    const root = newRepo();
    writeFileSync(join(root, "a.ts"), "1\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "c1");
    const db = createMemoryIndexDb();
    const { ctx, pruned } = observedContext(db);
    const syncable = createBlameIndexSyncable({ roots: [rootCfg(root)] });
    const first = await syncable.sync(ctx, null);
    expect(first.itemsUpserted).toBe(1); // positive control: the file really was blamed once

    writeFileSync(join(root, "a.ts"), "1\n2\n");
    git(root, "commit", "-q", "-am", "c2");
    const c2 = git(root, "rev-parse", "HEAD");
    rmSync(join(root, "a.ts"));
    pruned.length = 0;

    const second = await syncable.sync(ctx, first.cursor);

    expect(pruned).toEqual(["a.ts"]);
    expect(second.itemsUpserted).toBe(0);
    expect(headsOf(second.cursor)).toEqual({ [root]: c2 });
    const left = db.query("SELECT COUNT(*) AS c FROM git_blame_line").get() as { c: number };
    expect(left.c).toBe(0);
    db.close();
  });
});
