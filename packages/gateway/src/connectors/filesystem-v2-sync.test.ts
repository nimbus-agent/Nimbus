import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMemoryIndexDb,
  EMPTY_NIMBUS_VAULT,
  expectServiceItemCount,
  silentSyncContextExtras,
  syncTestContext,
  testConnectorSyncNoop,
} from "./connector-sync-test-helpers.ts";
import { createFilesystemV2Syncable } from "./filesystem-v2-sync.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";

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
        exclude: ["node_modules", ".git"],
      },
    ],
  });
  const db = createMemoryIndexDb();
  const r = await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT), null);
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
        exclude: ["node_modules", ".git"],
      },
    ],
  });
  const db = createMemoryIndexDb();
  const r = await sync.sync({ db, vault: EMPTY_NIMBUS_VAULT, ...silentSyncContextExtras() }, null);
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
        exclude: [],
      },
    ],
  });
  const db = createMemoryIndexDb();
  const r = await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT), null);
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
        exclude: ["node_modules", ".git"],
      },
    ],
  });
  const db = createMemoryIndexDb();
  await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT), null);
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
        exclude: ["node_modules", ".git"],
      },
    ],
  });
  const priorCursor = encodeNimbusJsonCursor("nimbus-fsv2:", {
    tips: { "git:/some/other/root": "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" },
  });
  const db = createMemoryIndexDb();
  const r = await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT), priorCursor);
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
        exclude: ["node_modules", ".git"],
      },
    ],
  });
  const badCursor = encodeNimbusJsonCursor("nimbus-fsv2:", ["not", "an", "object"]);
  const db = createMemoryIndexDb();
  const r = await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT), badCursor);
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
        exclude: ["node_modules", ".git"],
      },
    ],
  });
  const db = createMemoryIndexDb();
  const r = await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT), null);
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
        exclude: [],
      },
    ],
  });
  const db = createMemoryIndexDb();
  const r = await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT), null);
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
        exclude: [],
      },
    ],
  });
  const db = createMemoryIndexDb();
  const r = await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT), null);
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
        exclude: [],
      },
    ],
  });
  const db = createMemoryIndexDb();
  const r = await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT), null);
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
        exclude: ["node_modules", ".git"],
      },
    ],
  });
  const db = createMemoryIndexDb();
  const r = await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT), null);
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
        exclude: ["node_modules", ".git"],
      },
    ],
  });
  const db = createMemoryIndexDb();
  const r = await sync.sync({ db, vault: EMPTY_NIMBUS_VAULT, ...silentSyncContextExtras() }, null);
  expect(r.itemsUpserted).toBeGreaterThanOrEqual(1);
  const row = db
    .query(
      `SELECT body_preview FROM item WHERE service = 'filesystem' AND type = 'code_symbol' AND title LIKE '%renewCredentials%'`,
    )
    .get() as { body_preview: string } | null;
  expect(row?.body_preview?.toLowerCase().includes("oauth")).toBe(true);
  expect(row?.body_preview?.toLowerCase().includes("refresh")).toBe(true);
});
