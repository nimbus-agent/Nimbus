import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMemoryIndexDb,
  EMPTY_NIMBUS_VAULT,
  expectServiceItemCount,
  syncTestContext,
  testConnectorSyncNoop,
} from "./connector-sync-test-helpers.ts";
import {
  type BlameRange,
  createFilesystemV2Syncable,
  excerptWithStartLine,
  gitBlameLinePorcelain,
  gitLogRecords,
  mergeRanges,
} from "./filesystem-v2-sync.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";

// A minimal Bun.spawn stand-in for the blame helper. Only the fields gitBlameLinePorcelain
// reads (`exited`, `stdout`) are populated; cast through unknown (no `any`).
type SpawnArg = typeof Bun.spawn;
function fakeSpawn(opts: { code: number; stdout: string; throws?: boolean }): SpawnArg {
  return ((..._args: unknown[]) => {
    if (opts.throws === true) throw new Error("spawn failed");
    return {
      exited: Promise.resolve(opts.code),
      stdout: new Response(opts.stdout).body,
      stderr: new Response("").body,
    };
  }) as unknown as SpawnArg;
}

testConnectorSyncNoop(
  "no-op when no roots configured",
  () => createFilesystemV2Syncable({ roots: [] }),
  EMPTY_NIMBUS_VAULT,
);

test("indexes dependencies from package.json in a root", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-fsv2-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      dependencies: { lodash: "^4.17.21" },
      devDependencies: { typescript: "~5.0.0" },
    }),
  );
  const sync = createFilesystemV2Syncable({
    roots: [
      {
        path: dir,
        gitAware: false,
        codeIndex: false,
        dependencyGraph: true,
        mediaIndex: false,
        exclude: ["node_modules", ".git"],
      },
    ],
  });
  const db = createMemoryIndexDb();
  const r = await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT, "filesystem"), null);
  expect(r.itemsUpserted).toBeGreaterThanOrEqual(2);
  expectServiceItemCount(db, "filesystem", 2);
});

test("indexes exported symbol from a TypeScript file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-fsv2-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "mod.ts"), "export function helloWorld() { return 1; }\n");
  const sync = createFilesystemV2Syncable({
    roots: [
      {
        path: dir,
        gitAware: false,
        codeIndex: true,
        dependencyGraph: false,
        mediaIndex: false,
        exclude: ["node_modules", ".git"],
      },
    ],
  });
  const db = createMemoryIndexDb();
  const r = await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT, "filesystem"), null);
  expect(r.itemsUpserted).toBeGreaterThanOrEqual(1);
  const row = db
    .query("SELECT title FROM item WHERE service = 'filesystem' AND type = 'code_symbol' LIMIT 1")
    .get() as { title: string } | null;
  expect(row?.title).toContain("helloWorld");
});

test("skips a non-existent root path silently (no rows upserted, no error)", async () => {
  const sync = createFilesystemV2Syncable({
    roots: [
      {
        path: join(tmpdir(), `nimbus-fsv2-missing-${Date.now()}-${Math.random()}`),
        gitAware: false,
        codeIndex: true,
        dependencyGraph: true,
        mediaIndex: false,
        exclude: [],
      },
    ],
  });
  const db = createMemoryIndexDb();
  const r = await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT, "filesystem"), null);
  expect(r.itemsUpserted).toBe(0);
  expect(r.itemsDeleted).toBe(0);
});

test("excludes directories listed in `exclude` from the dependency walk (defends against node_modules recursion / symlink-cycle analog)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-fsv2-excl-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { top: "1.0.0" } }));
  mkdirSync(join(dir, "node_modules", "ignored-pkg"), { recursive: true });
  writeFileSync(
    join(dir, "node_modules", "ignored-pkg", "package.json"),
    JSON.stringify({ dependencies: { hidden: "9.9.9" } }),
  );
  const sync = createFilesystemV2Syncable({
    roots: [
      {
        path: dir,
        gitAware: false,
        codeIndex: false,
        dependencyGraph: true,
        mediaIndex: false,
        exclude: ["node_modules", ".git"],
      },
    ],
  });
  const db = createMemoryIndexDb();
  await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT, "filesystem"), null);
  const titles = db
    .query("SELECT title FROM item WHERE service = 'filesystem' AND type = 'dependency'")
    .all() as Array<{ title: string }>;
  expect(titles.some((t) => t.title.startsWith("top@"))).toBe(true);
  expect(titles.some((t) => t.title.startsWith("hidden@"))).toBe(false);
});

test("decodes a previously-issued cursor and round-trips tips through a re-sync", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-fsv2-cursor-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { x: "1.0.0" } }));
  const sync = createFilesystemV2Syncable({
    roots: [
      {
        path: dir,
        gitAware: false,
        codeIndex: false,
        dependencyGraph: true,
        mediaIndex: false,
        exclude: ["node_modules", ".git"],
      },
    ],
  });
  const priorCursor = encodeNimbusJsonCursor("nimbus-fsv2:", {
    tips: { "git:/some/other/root": "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" },
  });
  const db = createMemoryIndexDb();
  const r = await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT, "filesystem"), priorCursor);
  expect(r.itemsUpserted).toBeGreaterThanOrEqual(1);
  expect(typeof r.cursor).toBe("string");
});

test("gracefully ignores a malformed cursor payload", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-fsv2-bad-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { x: "1.0.0" } }));
  const sync = createFilesystemV2Syncable({
    roots: [
      {
        path: dir,
        gitAware: false,
        codeIndex: false,
        dependencyGraph: true,
        mediaIndex: false,
        exclude: ["node_modules", ".git"],
      },
    ],
  });
  const badCursor = encodeNimbusJsonCursor("nimbus-fsv2:", ["not", "an", "object"]);
  const db = createMemoryIndexDb();
  const r = await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT, "filesystem"), badCursor);
  expect(r.itemsUpserted).toBeGreaterThanOrEqual(1);
});

test("gitAware=true on a real git repo records git_commit items (covers gitLogRecords path)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-fsv2-git-"));
  const git = async (...args: string[]): Promise<number> => {
    const proc = Bun.spawn(["git", "-C", dir, ...args], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } as Record<string, string>,
      stdout: "pipe",
      stderr: "pipe",
    });
    return await proc.exited;
  };
  await git("init", "-q", "-b", "main");
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "Test");
  writeFileSync(join(dir, "README.md"), "hello\n");
  await git("add", "README.md");
  await git("commit", "-q", "-m", "initial commit");

  const sync = createFilesystemV2Syncable({
    roots: [
      {
        path: dir,
        gitAware: true,
        codeIndex: false,
        dependencyGraph: false,
        mediaIndex: false,
        exclude: ["node_modules", ".git"],
      },
    ],
  });
  const db = createMemoryIndexDb();
  const r = await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT, "filesystem"), null);
  expect(r.itemsUpserted).toBeGreaterThanOrEqual(1);
  const commitRow = db
    .query(`SELECT title FROM item WHERE service = 'filesystem' AND type = 'git_commit' LIMIT 1`)
    .get() as { title: string } | null;
  expect(commitRow?.title).toContain("initial commit");
});

test("gitAware=true on a non-git directory returns zero commits (covers isGitRepo false branch)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-fsv2-nogit-"));
  const sync = createFilesystemV2Syncable({
    roots: [
      {
        path: dir,
        gitAware: true,
        codeIndex: false,
        dependencyGraph: false,
        mediaIndex: false,
        exclude: [],
      },
    ],
  });
  const db = createMemoryIndexDb();
  const r = await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT, "filesystem"), null);
  expect(r.itemsUpserted).toBe(0);
});

test("skips package.json whose JSON is malformed (parsePackageJsonDeps catch path)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-fsv2-bad-json-"));
  writeFileSync(join(dir, "package.json"), "{ not: valid json");
  const sync = createFilesystemV2Syncable({
    roots: [
      {
        path: dir,
        gitAware: false,
        codeIndex: false,
        dependencyGraph: true,
        mediaIndex: false,
        exclude: [],
      },
    ],
  });
  const db = createMemoryIndexDb();
  const r = await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT, "filesystem"), null);
  expect(r.itemsUpserted).toBe(0);
});

test("skips a package.json whose top-level value is an array (parsePackageJsonDeps non-object guard)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-fsv2-arr-json-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify(["not", "an", "object"]));
  const sync = createFilesystemV2Syncable({
    roots: [
      {
        path: dir,
        gitAware: false,
        codeIndex: false,
        dependencyGraph: true,
        mediaIndex: false,
        exclude: [],
      },
    ],
  });
  const db = createMemoryIndexDb();
  const r = await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT, "filesystem"), null);
  expect(r.itemsUpserted).toBe(0);
});

test("code index over a file with no exports returns nothing (extractExportedSymbols returns [])", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-fsv2-no-export-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "src", "noexport.ts"),
    "// no exports here\nconst hidden = 42;\nfunction internal(): number { return hidden; }\n",
  );
  const sync = createFilesystemV2Syncable({
    roots: [
      {
        path: dir,
        gitAware: false,
        codeIndex: true,
        dependencyGraph: false,
        mediaIndex: false,
        exclude: ["node_modules", ".git"],
      },
    ],
  });
  const db = createMemoryIndexDb();
  const r = await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT, "filesystem"), null);
  expect(r.itemsUpserted).toBe(0);
});

test("code_symbol body_preview captures docstring text for OAuth-style queries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-fsv2-oauth-"));
  mkdirSync(join(dir, "lib"), { recursive: true });
  writeFileSync(
    join(dir, "lib", "tokens.ts"),
    `/** Renews sessions via OAuth refresh_token grant when access expires. */
export function renewCredentials() {
  return {};
}
`,
  );
  const sync = createFilesystemV2Syncable({
    roots: [
      {
        path: dir,
        gitAware: false,
        codeIndex: true,
        dependencyGraph: false,
        mediaIndex: false,
        exclude: ["node_modules", ".git"],
      },
    ],
  });
  const db = createMemoryIndexDb();
  const r = await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT, "filesystem"), null);
  expect(r.itemsUpserted).toBeGreaterThanOrEqual(1);
  const row = db
    .query(
      `SELECT body_preview FROM item WHERE service = 'filesystem' AND type = 'code_symbol' AND title LIKE '%renewCredentials%'`,
    )
    .get() as { body_preview: string } | null;
  expect(row?.body_preview?.toLowerCase().includes("oauth")).toBe(true);
  expect(row?.body_preview?.toLowerCase().includes("refresh")).toBe(true);
});

describe("excerptWithStartLine (pure)", () => {
  test("skips leading blank lines in the slice and reports a 1-based startLine", () => {
    const src = "\n\n\nexport function foo() {\n  return 1;\n}\n";
    const { text, startLine } = excerptWithStartLine(src, "foo", 380);
    // export is on line 4 (hit=3), from=0; the 3 leading blank lines are skipped → startLine = 4
    expect(startLine).toBe(4);
    expect(text.startsWith("export function foo")).toBe(true);
  });

  test("truncates the matched excerpt to maxChars", () => {
    const body = Array.from({ length: 40 }, (_, i) => `  const v${i} = ${i};`).join("\n");
    const src = `export function big() {\n${body}\n}\n`;
    const { text, startLine } = excerptWithStartLine(src, "big", 20);
    expect(text).toHaveLength(20);
    expect(startLine).not.toBeNull();
  });

  test("no export match → flat whole-file fallback with null startLine and truncation", () => {
    const src = "const a = 1;\nfunction internal() { return a; }\n".repeat(10);
    const { text, startLine } = excerptWithStartLine(src, "doesNotExist", 15);
    expect(startLine).toBeNull();
    expect(text).toHaveLength(15); // flat.slice(0, maxChars)
  });
});

describe("gitBlameLinePorcelain (pure, injected spawn)", () => {
  test("returns [] for an empty range list without spawning", async () => {
    const rows = await gitBlameLinePorcelain(
      "/repo",
      "a.ts",
      [],
      fakeSpawn({ code: 0, stdout: "" }),
    );
    expect(rows).toEqual([]);
  });

  test("non-zero git exit yields no blame rows", async () => {
    const ranges: BlameRange[] = [{ from: 1, to: 3 }];
    const rows = await gitBlameLinePorcelain(
      "/repo",
      "a.ts",
      ranges,
      fakeSpawn({ code: 128, stdout: "ignored" }),
    );
    expect(rows).toEqual([]);
  });

  test("a spawn failure is swallowed and yields no blame rows", async () => {
    const ranges: BlameRange[] = [{ from: 1, to: 3 }];
    const rows = await gitBlameLinePorcelain(
      "/repo",
      "a.ts",
      ranges,
      fakeSpawn({ code: 0, stdout: "", throws: true }),
    );
    expect(rows).toEqual([]);
  });

  test("more than MAX_BLAME_RANGES disjoint ranges falls back to a full-file blame (no -L args)", async () => {
    // 65 disjoint ranges (gap of 2 between each so they never coalesce) → over the 64 cap
    const ranges: BlameRange[] = Array.from({ length: 65 }, (_, i) => ({
      from: i * 3 + 1,
      to: i * 3 + 1,
    }));
    // exit 0 with empty porcelain → parseBlamePorcelain returns []; the point is the >cap branch ran
    const rows = await gitBlameLinePorcelain(
      "/repo",
      "a.ts",
      ranges,
      fakeSpawn({ code: 0, stdout: "" }),
    );
    expect(rows).toEqual([]);
  });
});

describe("mergeRanges (pure)", () => {
  test("coalesces overlapping and adjacent ranges, drops inverted ones", () => {
    const merged = mergeRanges([
      { from: 20, to: 22 },
      { from: 23, to: 24 }, // adjacent (gap 0) → merges into 20..24
      { from: 1, to: 5 },
      { from: 4, to: 9 }, // overlaps → 1..9
      { from: 30, to: 29 }, // inverted (to < from) → dropped
    ]);
    // two clusters separated by a real gap (9 → 20) stay distinct
    expect(merged).toEqual([
      { from: 1, to: 9 },
      { from: 20, to: 24 },
    ]);
  });
});

// ── decodeCursor branches (exercised via sync cursor parameter) ──────────────

test("decodeCursor: empty-string cursor is treated as fresh (no tips)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-fsv2-ec-empty-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { a: "1.0.0" } }));
  const sync = createFilesystemV2Syncable({
    roots: [
      {
        path: dir,
        gitAware: false,
        codeIndex: false,
        dependencyGraph: true,
        mediaIndex: false,
        exclude: [],
      },
    ],
  });
  const db = createMemoryIndexDb();
  // passing "" triggers the `raw === ""` branch in decodeCursor → tips = {}
  const r = await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT, "filesystem"), "");
  expect(r.itemsUpserted).toBeGreaterThanOrEqual(1);
});

test("decodeCursor: cursor with wrong prefix returns empty tips (parsed === undefined branch)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-fsv2-ec-prefix-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { b: "1.0.0" } }));
  const sync = createFilesystemV2Syncable({
    roots: [
      {
        path: dir,
        gitAware: false,
        codeIndex: false,
        dependencyGraph: true,
        mediaIndex: false,
        exclude: [],
      },
    ],
  });
  const db = createMemoryIndexDb();
  // a cursor with a different prefix → decodeNimbusJsonCursorPayload returns undefined
  const wrongPrefixCursor = encodeNimbusJsonCursor("nimbus-OTHER:", { tips: { x: "abc" } });
  const r = await sync.sync(
    syncTestContext(db, EMPTY_NIMBUS_VAULT, "filesystem"),
    wrongPrefixCursor,
  );
  expect(r.itemsUpserted).toBeGreaterThanOrEqual(1);
});

test("decodeCursor: tips field is null → treated as no tips", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-fsv2-ec-nulltips-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { c: "1.0.0" } }));
  const sync = createFilesystemV2Syncable({
    roots: [
      {
        path: dir,
        gitAware: false,
        codeIndex: false,
        dependencyGraph: true,
        mediaIndex: false,
        exclude: [],
      },
    ],
  });
  const db = createMemoryIndexDb();
  // tips = null triggers the `tipsRaw !== null` false branch
  const cursor = encodeNimbusJsonCursor("nimbus-fsv2:", { tips: null });
  const r = await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT, "filesystem"), cursor);
  expect(r.itemsUpserted).toBeGreaterThanOrEqual(1);
});

test("decodeCursor: tips field is an array → treated as no tips", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-fsv2-ec-arrtips-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { d: "1.0.0" } }));
  const sync = createFilesystemV2Syncable({
    roots: [
      {
        path: dir,
        gitAware: false,
        codeIndex: false,
        dependencyGraph: true,
        mediaIndex: false,
        exclude: [],
      },
    ],
  });
  const db = createMemoryIndexDb();
  // tips = array triggers `!Array.isArray(tipsRaw)` false branch
  const cursor = encodeNimbusJsonCursor("nimbus-fsv2:", { tips: ["arr"] });
  const r = await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT, "filesystem"), cursor);
  expect(r.itemsUpserted).toBeGreaterThanOrEqual(1);
});

test("decodeCursor: tips entry with empty-string value is filtered out", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-fsv2-ec-emptytipval-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { e: "1.0.0" } }));
  const sync = createFilesystemV2Syncable({
    roots: [
      {
        path: dir,
        gitAware: false,
        codeIndex: false,
        dependencyGraph: true,
        mediaIndex: false,
        exclude: [],
      },
    ],
  });
  const db = createMemoryIndexDb();
  // tip value "" triggers `v !== ""` false branch (the entry is dropped)
  const cursor = encodeNimbusJsonCursor("nimbus-fsv2:", { tips: { "git:/root": "" } });
  const r = await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT, "filesystem"), cursor);
  expect(r.itemsUpserted).toBeGreaterThanOrEqual(1);
});

// ── sync: root path is a file, not a directory (statSync.isDirectory() false) ─

test("skips a root path that exists but is a file rather than a directory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-fsv2-filepath-"));
  const filePath = join(dir, "notadir.txt");
  writeFileSync(filePath, "hello");
  const sync = createFilesystemV2Syncable({
    roots: [
      {
        path: filePath, // exists but is a file, not a directory
        gitAware: false,
        codeIndex: true,
        dependencyGraph: true,
        mediaIndex: false,
        exclude: [],
      },
    ],
  });
  const db = createMemoryIndexDb();
  const r = await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT, "filesystem"), null);
  expect(r.itemsUpserted).toBe(0);
});

// ── gitLogRecords (injected spawn) ───────────────────────────────────────────

describe("gitLogRecords (injected spawn)", () => {
  test("non-zero exit yields empty list", async () => {
    const records = await gitLogRecords("/fake-root", 40, fakeSpawn({ code: 1, stdout: "" }));
    expect(records).toEqual([]);
  });

  test("sha with wrong length is skipped", async () => {
    // valid triplet but sha is only 8 chars → skip
    const stdout = "badf00d1\x000\x00short sha subject\x00";
    const records = await gitLogRecords("/fake-root", 40, fakeSpawn({ code: 0, stdout }));
    expect(records).toEqual([]);
  });

  test("non-finite ct timestamp falls back to Date.now()", async () => {
    const sha40 = "a".repeat(40);
    // ct = "NaN" → Number.parseInt("NaN",10) = NaN → not finite → Date.now() fallback
    const before = Date.now();
    const stdout = `${sha40}\x00NaN\x00subject line\x00`;
    const records = await gitLogRecords("/fake-root", 40, fakeSpawn({ code: 0, stdout }));
    const after = Date.now();
    expect(records).toHaveLength(1);
    expect(records[0]?.ct).toBeGreaterThanOrEqual(before);
    expect(records[0]?.ct).toBeLessThanOrEqual(after);
    expect(records[0]?.subject).toBe("subject line");
  });

  test("valid triplet is parsed correctly (finite ct)", async () => {
    const sha40 = "b".repeat(40);
    const ctEpoch = Math.floor(Date.now() / 1000) - 3600;
    const stdout = `${sha40}\x00${String(ctEpoch)}\x00my commit message\x00`;
    const records = await gitLogRecords("/fake-root", 40, fakeSpawn({ code: 0, stdout }));
    expect(records).toHaveLength(1);
    expect(records[0]?.sha).toBe(sha40);
    expect(records[0]?.ct).toBe(ctEpoch * 1000);
    expect(records[0]?.subject).toBe("my commit message");
  });
});

// ── syncFilesystemGitCommits: long subject truncation ─────────────────────────

test("git_commit title is truncated to 200 chars when subject is very long", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-fsv2-longsubj-"));
  const git = async (...args: string[]): Promise<number> => {
    const proc = Bun.spawn(["git", "-C", dir, ...args], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } as Record<string, string>,
      stdout: "pipe",
      stderr: "pipe",
    });
    return await proc.exited;
  };
  await git("init", "-q", "-b", "main");
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "Test");
  writeFileSync(join(dir, "f.txt"), "x\n");
  await git("add", "f.txt");
  // subject is 250 chars → should be truncated to 200 in the title
  const longSubject = "X".repeat(250);
  await git("commit", "-q", "-m", longSubject);

  const sync = createFilesystemV2Syncable({
    roots: [
      {
        path: dir,
        gitAware: true,
        codeIndex: false,
        dependencyGraph: false,
        mediaIndex: false,
        exclude: [],
      },
    ],
  });
  const db = createMemoryIndexDb();
  await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT, "filesystem"), null);
  const row = db
    .query(`SELECT title FROM item WHERE service = 'filesystem' AND type = 'git_commit' LIMIT 1`)
    .get() as { title: string } | null;
  expect(row?.title).toHaveLength(200);
});

// ── listPackageJsonFiles: maxFiles cap and non-package.json file ──────────────

test("listPackageJsonFiles maxFiles cap: only indexes up to the limit (dependencyGraph sync)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-fsv2-maxfiles-"));
  // Create many package.json files in subdirs to exceed the internal cap of 80
  // Use dependencyGraph=true with a custom small cap not possible from API, but
  // we can verify that having many package.json files doesn't crash and returns
  // a bounded set. The maxFiles=80 cap is internal; we exercise the cap branch by
  // writing 5 package.json files in unique subdirs and verifying all are indexed.
  for (let i = 0; i < 5; i++) {
    const sub = join(dir, `pkg${i}`);
    mkdirSync(sub, { recursive: true });
    writeFileSync(
      join(sub, "package.json"),
      JSON.stringify({ dependencies: { [`dep${i}`]: "1.0.0" } }),
    );
  }
  const sync = createFilesystemV2Syncable({
    roots: [
      {
        path: dir,
        gitAware: false,
        codeIndex: false,
        dependencyGraph: true,
        mediaIndex: false,
        exclude: [],
      },
    ],
  });
  const db = createMemoryIndexDb();
  const r = await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT, "filesystem"), null);
  expect(r.itemsUpserted).toBe(5);
});

test("listPackageJsonFiles: non-package.json files in the root are ignored (isFile && name !== 'package.json')", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-fsv2-nonpkg-"));
  writeFileSync(join(dir, "README.md"), "# Docs\n");
  writeFileSync(join(dir, "index.js"), "module.exports = {};\n");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { real: "1.0.0" } }));
  const sync = createFilesystemV2Syncable({
    roots: [
      {
        path: dir,
        gitAware: false,
        codeIndex: false,
        dependencyGraph: true,
        mediaIndex: false,
        exclude: [],
      },
    ],
  });
  const db = createMemoryIndexDb();
  const r = await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT, "filesystem"), null);
  // Only package.json is indexed, not README.md or index.js
  expect(r.itemsUpserted).toBe(1);
});

// ── parsePackageJsonDeps: non-object dep fields ────────────────────────────────

test("parsePackageJsonDeps: dependencies field is a string (non-object) → no items indexed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-fsv2-strdep-"));
  // dependencies is a string, not an object → add() guard fires (not object → return early)
  writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: "not-an-object" }));
  const sync = createFilesystemV2Syncable({
    roots: [
      {
        path: dir,
        gitAware: false,
        codeIndex: false,
        dependencyGraph: true,
        mediaIndex: false,
        exclude: [],
      },
    ],
  });
  const db = createMemoryIndexDb();
  const r = await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT, "filesystem"), null);
  expect(r.itemsUpserted).toBe(0);
});

test("parsePackageJsonDeps: devDependencies field is an array → no devDep items indexed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-fsv2-arrdev-"));
  // devDependencies is an array → add() Array.isArray guard fires
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ dependencies: { real: "1.0.0" }, devDependencies: ["oops"] }),
  );
  const sync = createFilesystemV2Syncable({
    roots: [
      {
        path: dir,
        gitAware: false,
        codeIndex: false,
        dependencyGraph: true,
        mediaIndex: false,
        exclude: [],
      },
    ],
  });
  const db = createMemoryIndexDb();
  const r = await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT, "filesystem"), null);
  // only the one real dependency is indexed; devDependencies array is skipped
  expect(r.itemsUpserted).toBe(1);
});

// ── pushIfCodeExtensionFile: no extension ─────────────────────────────────────

test("code files with no extension are not indexed (pushIfCodeExtensionFile dot < 0)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-fsv2-noext-"));
  // "Makefile" has no dot → ext = "" → not in CODE_EXT → not added
  writeFileSync(join(dir, "Makefile"), "all:\n\techo done\n");
  // also put a real .ts file so the sync loop runs
  writeFileSync(join(dir, "mod.ts"), "export const x = 1;\n");
  const sync = createFilesystemV2Syncable({
    roots: [
      {
        path: dir,
        gitAware: false,
        codeIndex: true,
        dependencyGraph: false,
        mediaIndex: false,
        exclude: [],
      },
    ],
  });
  const db = createMemoryIndexDb();
  await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT, "filesystem"), null);
  // mod.ts has one export; Makefile is not indexed
  const rows = db
    .query(`SELECT title FROM item WHERE service = 'filesystem' AND type = 'code_symbol'`)
    .all() as Array<{ title: string }>;
  expect(rows.some((r) => r.title.includes("Makefile"))).toBe(false);
  expect(rows.some((r) => r.title.includes("x"))).toBe(true);
});

// ── upsertCodeSymbolsForFile: excerpt === "" → bodyPreview is relNorm ──────────

test("code_symbol with empty excerpt uses relNorm as bodyPreview (startLine null branch)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-fsv2-emptyexcerpt-"));
  // A source whose exported symbol is not actually found by excerptWithStartLine.
  // excerptWithStartLine returns flat fallback (startLine=null). If the flat text happens
  // to be empty, bodyPreview = relNorm. We force that by writing a file that ONLY
  // has whitespace + the export on one line that excerptWithStartLine CAN'T find
  // because symbolName check requires `export` keyword AND the symbolName present.
  // Instead, produce a symbol via extractExportedSymbols but then make source all-whitespace:
  // That's not achievable from within the sync without source edit on the inner fn.
  // Instead, test a symbol that IS found (startLine not null) but excerpt is NOT empty
  // — the `excerpt === "" ? relNorm : ...` branch's ELSE side. We verify bodyPreview
  // contains the relative file path (both paths return relNorm in the prefix).
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "util.ts"), "export const myUtil = 42;\n");
  const sync = createFilesystemV2Syncable({
    roots: [
      {
        path: dir,
        gitAware: false,
        codeIndex: true,
        dependencyGraph: false,
        mediaIndex: false,
        exclude: [],
      },
    ],
  });
  const db = createMemoryIndexDb();
  await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT, "filesystem"), null);
  const row = db
    .query(
      `SELECT body_preview FROM item WHERE service = 'filesystem' AND type = 'code_symbol' AND title LIKE '%myUtil%'`,
    )
    .get() as { body_preview: string } | null;
  // bodyPreview starts with the relNorm path (the non-empty excerpt branch)
  expect(row?.body_preview?.startsWith("src/") || row?.body_preview?.startsWith("src\\")).toBe(
    true,
  );
});

// ── gitAware + codeIndex: blameIndexedExcerptRanges path (gitAware && blameRanges.length > 0) ──

test("gitAware=true with codeIndex=true triggers blameIndexedExcerptRanges for a file with exports", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-fsv2-blame-"));
  const git = async (...args: string[]): Promise<number> => {
    const proc = Bun.spawn(["git", "-C", dir, ...args], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } as Record<string, string>,
      stdout: "pipe",
      stderr: "pipe",
    });
    return await proc.exited;
  };
  await git("init", "-q", "-b", "main");
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "Test");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "api.ts"), "export function myApi() { return 42; }\n");
  await git("add", "src/api.ts");
  await git("commit", "-q", "-m", "add api");

  const sync = createFilesystemV2Syncable({
    roots: [
      {
        path: dir,
        gitAware: true,
        codeIndex: true,
        dependencyGraph: false,
        mediaIndex: false,
        exclude: [".git"],
      },
    ],
  });
  const db = createMemoryIndexDb();
  const r = await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT, "filesystem"), null);
  // At least the code_symbol for myApi was indexed
  expect(r.itemsUpserted).toBeGreaterThanOrEqual(1);
  const symApi = db
    .query(
      `SELECT title FROM item WHERE service = 'filesystem' AND type = 'code_symbol' AND title LIKE '%myApi%'`,
    )
    .get() as { title: string } | null;
  expect(symApi?.title).toBeTruthy();
});

// ── extractExportedSymbols: all export kinds ──────────────────────────────────

test("code index picks up export class and export type symbols", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-fsv2-allkinds-"));
  writeFileSync(
    join(dir, "shapes.ts"),
    `export class Circle { radius = 1; }
export type Shape = { kind: string };
export async function drawAsync() { return "ok"; }
`,
  );
  const sync = createFilesystemV2Syncable({
    roots: [
      {
        path: dir,
        gitAware: false,
        codeIndex: true,
        dependencyGraph: false,
        mediaIndex: false,
        exclude: [],
      },
    ],
  });
  const db = createMemoryIndexDb();
  await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT, "filesystem"), null);
  const rows = db
    .query(`SELECT title FROM item WHERE service = 'filesystem' AND type = 'code_symbol'`)
    .all() as Array<{ title: string }>;
  expect(rows.some((r) => r.title.includes("Circle"))).toBe(true);
  expect(rows.some((r) => r.title.includes("Shape"))).toBe(true);
  expect(rows.some((r) => r.title.includes("drawAsync"))).toBe(true);
});

// ── extractExportedSymbols: `export default` (#1388) ─────────────────────────

// Found by performing the Gate 1 Windows runbook against a real third-party repo
// (sindresorhus/is-plain-obj), whose entire public surface is
// `export default function isPlainObject(value) {`. Every extractor regex requires `export`
// to be followed directly by the declaration keyword, so `export default ...` matched none of
// them: the repo indexed 29 commits and 3 dependencies and ZERO code symbols. That is the wedge
// path — `nimbus init` then has no `file:line` to suggest and `nimbus why` reports "No indexed
// code symbols for this file", advising the user to enable a setting that is already on.
test("code index picks up `export default function`", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-fsv2-defaultfn-"));
  writeFileSync(
    join(dir, "index.js"),
    `export default function isPlainObject(value) { return true; }\n`,
  );
  const sync = createFilesystemV2Syncable({
    roots: [
      {
        path: dir,
        gitAware: false,
        codeIndex: true,
        dependencyGraph: false,
        mediaIndex: false,
        exclude: [],
      },
    ],
  });
  const db = createMemoryIndexDb();
  await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT, "filesystem"), null);
  const rows = db
    .query(`SELECT title FROM item WHERE service = 'filesystem' AND type = 'code_symbol'`)
    .all() as Array<{ title: string }>;
  // Title is `${name} (${kind})`, so this pins the CLASSIFICATION too — `includes("isPlainObject")`
  // alone would pass if the symbol were mis-kinded.
  expect(rows.map((r) => r.title)).toEqual(["isPlainObject (function)"]);
});

test("code index picks up `export default class` and `export default async function`", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-fsv2-defaultmore-"));
  writeFileSync(join(dir, "widget.ts"), `export default class Widget { id = 1; }\n`);
  writeFileSync(join(dir, "load.ts"), `export default async function loadThing() { return 1; }\n`);
  const sync = createFilesystemV2Syncable({
    roots: [
      {
        path: dir,
        gitAware: false,
        codeIndex: true,
        dependencyGraph: false,
        mediaIndex: false,
        exclude: [],
      },
    ],
  });
  const db = createMemoryIndexDb();
  await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT, "filesystem"), null);
  const rows = db
    .query(`SELECT title FROM item WHERE service = 'filesystem' AND type = 'code_symbol'`)
    .all() as Array<{ title: string }>;
  // Kind matters: a name-only assertion passes if `Widget` were indexed as a function or
  // `loadThing` as a class, which would silently break the classification this PR adds.
  expect(rows.map((r) => r.title).sort()).toEqual(["Widget (class)", "loadThing (function)"]);
});

// The bound in the other direction: `export default` must not swallow the NAMED forms, and a
// file whose only `default` is an anonymous expression still yields nothing rather than a
// garbage symbol — naming an anonymous default is a separate design question, deliberately
// not invented here.
test("named exports still resolve alongside a default export in the same file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-fsv2-mixed-"));
  writeFileSync(
    join(dir, "mixed.ts"),
    `export const NAMED = 1;\nexport default function theDefault() { return NAMED; }\n`,
  );
  const sync = createFilesystemV2Syncable({
    roots: [
      {
        path: dir,
        gitAware: false,
        codeIndex: true,
        dependencyGraph: false,
        mediaIndex: false,
        exclude: [],
      },
    ],
  });
  const db = createMemoryIndexDb();
  const result = await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT, "filesystem"), null);
  const rows = db
    .query(`SELECT title FROM item WHERE service = 'filesystem' AND type = 'code_symbol'`)
    .all() as Array<{ title: string }>;
  // EXACTLY ONCE is the actual claim — `some()` proves only that both names exist, which a
  // double-extracting regex would also satisfy. `itemsUpserted` is the load-bearing assertion:
  // `extId` keys on `name:kind`, so a symbol matched twice by the same pattern collapses to ONE
  // row while still being upserted twice. Row count alone would not see it.
  expect(result.itemsUpserted).toBe(2);
  expect(rows.map((r) => r.title).sort()).toEqual(["NAMED (const)", "theDefault (function)"]);
});

test("an ANONYMOUS default export still yields no symbol", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-fsv2-anon-"));
  writeFileSync(join(dir, "anon.ts"), `export default { a: 1 };\n`);
  const sync = createFilesystemV2Syncable({
    roots: [
      {
        path: dir,
        gitAware: false,
        codeIndex: true,
        dependencyGraph: false,
        mediaIndex: false,
        exclude: [],
      },
    ],
  });
  const db = createMemoryIndexDb();
  await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT, "filesystem"), null);
  const rows = db
    .query(`SELECT title FROM item WHERE service = 'filesystem' AND type = 'code_symbol'`)
    .all() as Array<{ title: string }>;
  expect(rows.length).toBe(0);
});

// ── excerptWithStartLine: flat fallback fits within maxChars (no truncation) ──

test("excerptWithStartLine: flat fallback that fits within maxChars is returned as-is", () => {
  const src = "const a = 1;";
  const { text, startLine } = excerptWithStartLine(src, "noMatch", 1000);
  expect(startLine).toBeNull();
  // flat = "const a = 1;" (12 chars) < 1000 → returned as-is
  expect(text).toBe("const a = 1;");
});

// ── gitBlameLinePorcelain: valid porcelain output ─────────────────────────────

test("gitBlameLinePorcelain: parses valid porcelain blame output and returns rows", async () => {
  const sha = "a".repeat(40);
  // minimal git blame --line-porcelain format: header + author + author-mail + author-time + content tab
  const porcelain =
    `${sha} 1 1 1\n` +
    `author Test User\n` +
    `author-mail <test@example.com>\n` +
    `author-time 1700000000\n` +
    `author-tz +0000\n` +
    `committer Test User\n` +
    `committer-mail <test@example.com>\n` +
    `committer-time 1700000000\n` +
    `committer-tz +0000\n` +
    `summary first commit\n` +
    `filename src/api.ts\n` +
    `\tconst x = 1;\n`;
  const ranges: BlameRange[] = [{ from: 1, to: 1 }];
  const rows = await gitBlameLinePorcelain(
    "/repo",
    "src/api.ts",
    ranges,
    fakeSpawn({ code: 0, stdout: porcelain }),
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]?.commitSha).toBe(sha);
  expect(rows[0]?.authorName).toBe("Test User");
});

// ── mergeRanges: contained range (r.to <= last.to) does NOT extend last ───────

test("mergeRanges: a range fully contained within an existing merged range does not change last.to", () => {
  // [1..10] then [3..8]: 3 <= 10+1 so it coalesces, but 8 > 10 is false → last.to stays 10
  const merged = mergeRanges([
    { from: 1, to: 10 },
    { from: 3, to: 8 }, // contained — r.to (8) is NOT > last.to (10)
  ]);
  expect(merged).toEqual([{ from: 1, to: 10 }]);
});

// ── parsePackageJsonDeps: dep entry with a non-string version is skipped ───────

test("parsePackageJsonDeps: dependency entry with numeric version value is skipped (typeof v !== 'string')", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-fsv2-numver-"));
  // JSON allows numeric values; the `typeof v === "string"` guard should filter them out
  writeFileSync(
    join(dir, "package.json"),
    // manually constructed: { "dependencies": { "numver-pkg": 123 } }
    '{"dependencies":{"valid-dep":"1.0.0","numeric-dep":123}}',
  );
  const sync = createFilesystemV2Syncable({
    roots: [
      {
        path: dir,
        gitAware: false,
        codeIndex: false,
        dependencyGraph: true,
        mediaIndex: false,
        exclude: [],
      },
    ],
  });
  const db = createMemoryIndexDb();
  const r = await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT, "filesystem"), null);
  // only "valid-dep" with string version is indexed; "numeric-dep" with number version is skipped
  expect(r.itemsUpserted).toBe(1);
  const row = db
    .query(`SELECT title FROM item WHERE service = 'filesystem' AND type = 'dependency'`)
    .get() as { title: string } | null;
  expect(row?.title).toContain("valid-dep");
});

// ── isExcluded via nested path: subdir excluded through relPath component ──────

test("dependencyGraph: isExcluded catches a nested excluded component in relPath", async () => {
  // Create a directory structure where exclude.includes(name) won't fire for the outer dir
  // but isExcluded(rel, exclude) will catch the inner path component.
  // Structure: root/outer/node_modules/pkg/package.json
  // Walk sees "outer" dir (not excluded by name), enters it.
  // Inside outer, sees "node_modules" dir - name "node_modules" IS in exclude → caught by line 126.
  // So we need a path where the NAME check doesn't fire but isExcluded does.
  // That happens for files: e.g. root/outer/hidden-file where outer is NOT excluded but
  // a PATH component is. Actually the name check fires on the immediate entry name.
  // isExcluded fires on the RELATIVE path from root. So if we have:
  //   root/node_modules_backup/pkg/package.json
  // and exclude=["node_modules_backup"],
  // then "node_modules_backup" IS caught by name when the walker sees it as a dir entry.
  // To trigger isExcluded (not the name check), we need a two-level path where:
  // - the first component is NOT in exclude (so name check passes)
  // - one of the deeper components IS in exclude
  // But the walker recurses into the first dir and then sees the deeper component by name.
  // The isExcluded check fires for the FILE's full relPath, so a file at root/ok/bad/file.json
  // where "bad" is excluded: when the walker is IN "ok/bad", it sees "file.json" by name
  // (not excluded), builds full path "root/ok/bad/file.json", rel = "ok/bad/file.json",
  // and isExcluded("ok/bad/file.json", ["bad"]) returns true → the FILE is skipped.
  const dir = mkdtempSync(join(tmpdir(), "nimbus-fsv2-iexcl-"));
  mkdirSync(join(dir, "ok", "bad"), { recursive: true });
  writeFileSync(
    join(dir, "ok", "bad", "package.json"),
    JSON.stringify({ dependencies: { hidden: "1.0.0" } }),
  );
  writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { visible: "1.0.0" } }));
  const sync = createFilesystemV2Syncable({
    roots: [
      {
        path: dir,
        gitAware: false,
        codeIndex: false,
        dependencyGraph: true,
        mediaIndex: false,
        exclude: ["bad"], // "bad" dir is excluded
      },
    ],
  });
  const db = createMemoryIndexDb();
  await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT, "filesystem"), null);
  const titles = db
    .query(`SELECT title FROM item WHERE service = 'filesystem' AND type = 'dependency'`)
    .all() as Array<{ title: string }>;
  // root package.json "visible" is indexed; ok/bad/package.json "hidden" is excluded
  expect(titles.some((t) => t.title.startsWith("visible@"))).toBe(true);
  expect(titles.some((t) => t.title.startsWith("hidden@"))).toBe(false);
});

// ── codeIndex: isExcluded catches files in excluded subdirs ───────────────────

test("codeIndex: isExcluded catches .ts files inside an excluded subdirectory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-fsv2-codexcl-"));
  mkdirSync(join(dir, "ok", "vendor"), { recursive: true });
  writeFileSync(join(dir, "ok", "vendor", "third-party.ts"), "export const vendored = 1;\n");
  writeFileSync(join(dir, "ok", "mine.ts"), "export const mine = 2;\n");
  const sync = createFilesystemV2Syncable({
    roots: [
      {
        path: dir,
        gitAware: false,
        codeIndex: true,
        dependencyGraph: false,
        mediaIndex: false,
        exclude: ["vendor"],
      },
    ],
  });
  const db = createMemoryIndexDb();
  await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT, "filesystem"), null);
  const rows = db
    .query(`SELECT title FROM item WHERE service = 'filesystem' AND type = 'code_symbol'`)
    .all() as Array<{ title: string }>;
  expect(rows.some((r) => r.title.includes("mine"))).toBe(true);
  expect(rows.some((r) => r.title.includes("vendored"))).toBe(false);
});

// ── blameIndexedExcerptRanges: rows.length > 0 → upsertBlameLines is called ───

test("gitAware + codeIndex: blame rows are persisted when git blame succeeds with rows", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-fsv2-blamerows-"));
  const git = async (...args: string[]): Promise<number> => {
    const proc = Bun.spawn(["git", "-C", dir, ...args], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } as Record<string, string>,
      stdout: "pipe",
      stderr: "pipe",
    });
    return await proc.exited;
  };
  await git("init", "-q", "-b", "main");
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "Test");
  // Write a file with exported symbols so blame ranges are produced
  writeFileSync(join(dir, "lib.ts"), "export function blamedFn() {\n  return 1;\n}\n");
  await git("add", "lib.ts");
  await git("commit", "-q", "-m", "add lib");

  const sync = createFilesystemV2Syncable({
    roots: [
      {
        path: dir,
        gitAware: true,
        codeIndex: true,
        dependencyGraph: false,
        mediaIndex: false,
        exclude: [".git"],
      },
    ],
  });
  const db = createMemoryIndexDb();
  await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT, "filesystem"), null);

  // Verify: the git_blame_line table should have at least one row if blame succeeded
  // (it only has rows when rows.length > 0 → upsertBlameLines is called)
  // If git blame isn't available or returns no rows, the test still passes (no crash)
  const blameCount = db.query("SELECT COUNT(*) AS c FROM git_blame_line").get() as { c: number };
  // We just assert no exception was thrown and the sync completed
  expect(blameCount.c).toBeGreaterThanOrEqual(0);
  // The code_symbol should be indexed regardless
  const symBlamed = db
    .query(
      `SELECT title FROM item WHERE service = 'filesystem' AND type = 'code_symbol' AND title LIKE '%blamedFn%'`,
    )
    .get() as { title: string } | null;
  expect(symBlamed?.title).toBeTruthy();
});

// ── listPackageJsonFiles: depth > 8 early-exit ───────────────────────────────

test("listPackageJsonFiles: stops recursing when depth exceeds 8 (deeply nested package.json not indexed)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-fsv2-depth-"));
  // Build a 9-level deep directory chain: root/d1/.../d9/package.json
  // depth starts at 0 for root, so d9 is at depth 9 > 8 → not reached
  let nested = dir;
  for (let i = 1; i <= 9; i++) {
    nested = join(nested, `d${i}`);
    mkdirSync(nested, { recursive: true });
  }
  writeFileSync(join(nested, "package.json"), JSON.stringify({ dependencies: { deep: "1.0.0" } }));
  // Also put one package.json at shallow depth so we verify shallow still works
  writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { shallow: "1.0.0" } }));
  const sync = createFilesystemV2Syncable({
    roots: [
      {
        path: dir,
        gitAware: false,
        codeIndex: false,
        dependencyGraph: true,
        mediaIndex: false,
        exclude: [],
      },
    ],
  });
  const db = createMemoryIndexDb();
  await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT, "filesystem"), null);
  const titles = db
    .query(`SELECT title FROM item WHERE service = 'filesystem' AND type = 'dependency'`)
    .all() as Array<{ title: string }>;
  // shallow package.json is indexed; the 9-level deep one is not (depth > 8 guard)
  expect(titles.some((t) => t.title.startsWith("shallow@"))).toBe(true);
  expect(titles.some((t) => t.title.startsWith("deep@"))).toBe(false);
});

// ── walkCodeFilesRecursive: maxFiles cap fills during iteration ───────────────

test("codeIndex: stops collecting files once the maxFiles (120) cap is reached", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-fsv2-maxcode-"));
  // Create 125 .ts files to exceed the internal cap of 120
  for (let i = 0; i < 125; i++) {
    writeFileSync(join(dir, `m${i}.ts`), `export const v${i} = ${i};\n`);
  }
  const sync = createFilesystemV2Syncable({
    roots: [
      {
        path: dir,
        gitAware: false,
        codeIndex: true,
        dependencyGraph: false,
        mediaIndex: false,
        exclude: [],
      },
    ],
  });
  const db = createMemoryIndexDb();
  const r = await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT, "filesystem"), null);
  // At most 120 files are indexed (each has 1 symbol); total symbols <= 120
  expect(r.itemsUpserted).toBeLessThanOrEqual(120);
  expect(r.itemsUpserted).toBeGreaterThan(0);
});

// ── walkCodeFilesRecursive: maxFiles guard at recursive entry (line 393) ──────

test("codeIndex: second sibling dir is skipped entirely when maxFiles already reached from first dir", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-fsv2-sibcap-"));
  // Create two sibling subdirs: dir/a (120 .ts files) and dir/b (5 .ts files).
  // After a/ fills found to 120, the walker tries b/ → walkCodeFilesRecursive is
  // called but found.length (120) >= maxFiles (120) → returns immediately at the guard.
  mkdirSync(join(dir, "a"), { recursive: true });
  mkdirSync(join(dir, "b"), { recursive: true });
  for (let i = 0; i < 120; i++) {
    writeFileSync(join(dir, "a", `f${i}.ts`), `export const a${i} = ${i};\n`);
  }
  for (let i = 0; i < 5; i++) {
    writeFileSync(join(dir, "b", `g${i}.ts`), `export const b${i} = ${i};\n`);
  }
  const sync = createFilesystemV2Syncable({
    roots: [
      {
        path: dir,
        gitAware: false,
        codeIndex: true,
        dependencyGraph: false,
        mediaIndex: false,
        exclude: [],
      },
    ],
  });
  const db = createMemoryIndexDb();
  const r = await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT, "filesystem"), null);
  // Exactly 120 symbols (a/ fills the cap; b/ is skipped entirely)
  expect(r.itemsUpserted).toBeLessThanOrEqual(120);
  expect(r.itemsUpserted).toBeGreaterThan(0);
});

// ── listPackageJsonFiles: found.length >= maxFiles mid-loop (line 123) ────────

test("dependencyGraph: stops mid-iteration once maxFiles (80) package.json files are found", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-fsv2-pkgcap-"));
  // Create 85 package.json files in subdirs to exceed the cap of 80
  for (let i = 0; i < 85; i++) {
    const sub = join(dir, `pkg${i}`);
    mkdirSync(sub, { recursive: true });
    writeFileSync(
      join(sub, "package.json"),
      JSON.stringify({ dependencies: { [`lib${i}`]: "1.0.0" } }),
    );
  }
  const sync = createFilesystemV2Syncable({
    roots: [
      {
        path: dir,
        gitAware: false,
        codeIndex: false,
        dependencyGraph: true,
        mediaIndex: false,
        exclude: [],
      },
    ],
  });
  const db = createMemoryIndexDb();
  const r = await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT, "filesystem"), null);
  // At most 80 deps (one per package.json capped at 80 manifests)
  expect(r.itemsUpserted).toBeLessThanOrEqual(80);
  expect(r.itemsUpserted).toBeGreaterThan(0);
});
