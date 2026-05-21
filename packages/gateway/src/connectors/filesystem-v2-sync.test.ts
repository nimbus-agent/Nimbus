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
  // Plan: directory-not-readable error branch. Pointing at a nonexistent
  // root exercises the existsSync() / statSync().isDirectory() guard
  // (line ~458) which is the same defence as a permission-error from the
  // fs layer.
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
  // Plan: symlink-cycle detector. The actual defence is the exclude list
  // (and the maxFiles+depth cap), not a realpath-based cycle check. Test
  // that an excluded directory's package.json is invisible to the walker.
  const dir = mkdtempSync(join(tmpdir(), "nimbus-fsv2-excl-"));
  // Top-level package.json: visible.
  writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { top: "1.0.0" } }));
  // Excluded subdir's package.json: invisible.
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
