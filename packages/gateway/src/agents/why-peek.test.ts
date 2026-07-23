import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import * as path from "node:path";

import type { NimbusFilesystemRootToml } from "../config/filesystem-toml.ts";
import { upsertIndexedItem } from "../index/item-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import { upsertBlameLines } from "../security/blame-store.ts";
import { runWhyPeek } from "./why-peek.ts";

const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const ROOT = path.resolve(path.join(path.sep, "work", "repo"));
const roots: NimbusFilesystemRootToml[] = [
  { path: ROOT, gitAware: true, codeIndex: true, dependencyGraph: true, exclude: [] },
];

function seededDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const now = Date.now();

  // filesystem git_commit item — copied verbatim from filesystem-v2-sync.ts:194-209.
  upsertIndexedItem(db, {
    service: "filesystem",
    type: "git_commit",
    externalId: `${SHA}_r1`,
    title: "Fix retry backoff",
    bodyPreview: SHA,
    modifiedAt: now,
    syncedAt: now,
    metadata: { repoRoot: ROOT, sha: SHA, subject: "Fix retry backoff" },
  });

  // linear issue — shape from 1a's graph-populator-resolves.test.ts ticket-key case.
  // MUST be upserted before the PR: syncPrGraph's `resolves` edge is wired only
  // against issue *entities that already exist* in graph_entity at PR-sync time
  // (verified against graph-populator-resolves.test.ts:76-101, which seeds the
  // issue first, then the PR referencing its key — the reverse order silently
  // produces zero `resolves` rows).
  upsertIndexedItem(db, {
    service: "linear",
    type: "issue",
    externalId: "NIM-88",
    title: "Retry backoff is wrong",
    bodyPreview: "",
    url: "https://linear.app/acme/issue/NIM-88",
    modifiedAt: now,
    syncedAt: now,
    metadata: {},
  });

  // github PR — externalId/metadata shape from github-sync.ts (confirmed keys per Step 1 preamble).
  upsertIndexedItem(db, {
    service: "github",
    type: "pr",
    externalId: "acme/app#412",
    title: "Fix retry backoff",
    bodyPreview: "part of NIM-88",
    url: "https://github.com/acme/app/pull/412",
    modifiedAt: now,
    syncedAt: now,
    metadata: {
      number: 412,
      repo: "acme/app",
      state: "merged",
      draft: false,
      merged: true,
      merge_commit_sha: SHA,
    },
  });

  // Blame row seeded via the real builder — zero spawns needed at peek time.
  upsertBlameLines(db, ROOT, "src/retry.ts", [
    {
      lineNo: 42,
      commitSha: SHA,
      authorName: "alice",
      authorEmail: "alice@example.com",
      authorTimeMs: 1_700_000_000_000,
    },
  ]);
  return db;
}

test("peek walks blame → commit → PR → ticket entirely from the index", async () => {
  const db = seededDb();
  const peek = await runWhyPeek({ ref: `${path.join(ROOT, "src", "retry.ts")}:42` }, { db, roots });
  expect(peek.subject).toEqual({ repoRoot: ROOT, filePath: "src/retry.ts", lineNo: 42 });
  expect(peek.author).toBe("alice");
  expect(peek.commitSha).toBe(SHA);
  expect(peek.commitSubject).toBe("Fix retry backoff");
  expect(peek.pr?.number).toBe(412);
  expect(peek.pr?.url).toBe("https://github.com/acme/app/pull/412");
  expect(peek.ticket?.key).toBe("NIM-88");
});

test("a path outside every configured root → null subject and ZERO spawns (red-prove me)", async () => {
  const db = seededDb();
  let spawns = 0;
  const spy = ((..._a: unknown[]) => {
    spawns += 1;
    throw new Error("must not spawn");
  }) as typeof Bun.spawn;
  const outside = path.resolve(path.join(path.sep, "elsewhere", "x.ts"));
  const peek = await runWhyPeek({ ref: `${outside}:1` }, { db, roots, spawn: spy });
  expect(peek.subject).toBeNull();
  expect(spawns).toBe(0);
});

test("a symbol ref resolving to an out-of-roots repoRoot → null subject and ZERO spawns (red-prove me)", async () => {
  const db = seededDb();
  const OUTSIDE_ROOT = path.resolve(path.join(path.sep, "elsewhere", "repo"));
  const now = Date.now();
  upsertIndexedItem(db, {
    service: "filesystem",
    type: "code_symbol",
    externalId: `sym:${OUTSIDE_ROOT}:src/a.ts:retryBackoff:function`,
    title: "retryBackoff (function)",
    bodyPreview: "src/a.ts\nexport function retryBackoff() {",
    modifiedAt: now,
    syncedAt: now,
    metadata: {
      name: "retryBackoff",
      kind: "function",
      file: "src/a.ts",
      repoRoot: OUTSIDE_ROOT,
      excerptStartLine: 42,
    },
  });
  let spawns = 0;
  const spy = ((..._a: unknown[]) => {
    spawns += 1;
    throw new Error("must not spawn");
  }) as typeof Bun.spawn;
  const peek = await runWhyPeek({ ref: "retryBackoff" }, { db, roots, spawn: spy });
  expect(peek.subject).toBeNull();
  expect(spawns).toBe(0);
});

test("no blame row and no git dir → nulls, not an error", async () => {
  const db = seededDb();
  const peek = await runWhyPeek({ ref: `${path.join(ROOT, "src", "other.ts")}:9` }, { db, roots });
  expect(peek.subject).not.toBeNull();
  expect(peek.commitSha).toBeNull();
  expect(peek.pr).toBeNull();
});

test("hasMore is false on this fixture (no mentions/depends_on/correlates_with) and true once a mentions edge exists", async () => {
  const db = seededDb();
  const before = await runWhyPeek(
    { ref: `${path.join(ROOT, "src", "retry.ts")}:42` },
    { db, roots },
  );
  expect(before.hasMore).toBe(false);
  // Slack message mentioning the ticket — follows 1a's
  // graph-populator-mentions.test.ts seedMessage convention: externalId
  // "C1/1000.1" + {channel} metadata. NOT slack-sync.ts's real shape (its
  // externalId separator is `${ch}:${ts}`) — the difference is
  // behavior-neutral here because no query predicate in this path parses
  // the message externalId.
  const now = Date.now();
  upsertIndexedItem(db, {
    service: "slack",
    type: "message",
    externalId: "C1/1000.1",
    title: "anyone looking at NIM-88?",
    bodyPreview: "anyone looking at NIM-88?",
    modifiedAt: now,
    syncedAt: now,
    metadata: { channel: "C1" },
  });
  const after = await runWhyPeek(
    { ref: `${path.join(ROOT, "src", "retry.ts")}:42` },
    { db, roots },
  );
  expect(after.hasMore).toBe(true);
});

test("peek latency under 300 ms on the fixture index", async () => {
  const db = seededDb();
  const t0 = performance.now();
  await runWhyPeek({ ref: `${path.join(ROOT, "src", "retry.ts")}:42` }, { db, roots });
  expect(performance.now() - t0).toBeLessThan(300);
});
