/**
 * Test-only harness for the small family of bearer-authed HTTP routes mounted INLINE in the
 * `fetch` handler, ahead of the unauthenticated GET table — `GET /v1/items/resolve` today, and a
 * later task's `POST /v1/items/fetch` behind the same seam. Boots a REAL
 * `startReadOnlyHttpServer` on port 0 with a fresh temp-dir SQLite DB (migrated to latest) and an
 * in-memory vault seeded with exactly ONE token minted with the caller's chosen scopes.
 *
 * Modelled on `agent-runs/agent-test-server.ts` / `briefs/brief-test-server.ts`. NOT itself a
 * `*.test.ts` file — importers use `startServerWithClipToken` rather than redefining it, so this
 * stays the single source of the harness.
 *
 * `extraOpts` is spread BEFORE `clipsVault` in the options object handed to
 * `startReadOnlyHttpServer`, so a caller's own options can never accidentally strip the minted
 * vault by supplying a `clipsVault` key of their own — this is the seam a later task needs (e.g.
 * wiring `fetchItem` in for `POST /v1/items/fetch`) without a second parallel harness.
 */

import { Database } from "bun:sqlite";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeInMemoryVault } from "../../test/helpers/in-memory-vault.ts";
import type { ApiScope } from "../clips/api-scopes.ts";
import { addApiToken, generateClipToken } from "../clips/clip-token-store.ts";
import { applyWritablePragmas } from "../db/writable-pragmas.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { runQuietly } from "../testing/harness-teardown.ts";
import type { ReadOnlyHttpServerHandle, ReadOnlyHttpServerOptions } from "./http-server.ts";
import { startReadOnlyHttpServer } from "./http-server.ts";

export type ClipTestServer = {
  readonly port: number;
  readonly token: string;
  readonly db: Database;
  stop(): void;
};

/**
 * Boots a real server with exactly one clip token minted with `scopes`. `extraOpts` passes
 * straight through to `startReadOnlyHttpServer` for anything beyond `clipsVault` (e.g. a later
 * task's `fetchItem` closure for the `POST /v1/items/fetch` write seam).
 */
export async function startServerWithClipToken(
  scopes: readonly ApiScope[],
  extraOpts: Partial<ReadOnlyHttpServerOptions> = {},
): Promise<ClipTestServer> {
  const tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "nimbus-http-api-e2e-")));
  const dbPath = join(tmpDir, "nimbus.db");

  // Migrate + close, then reopen writable — the server opens its own readonly + (conditionally)
  // writable handles on `dbPath`, so the setup connection must not linger (same pattern as
  // agent-runs/agent-test-server.ts / briefs/brief-test-server.ts).
  const setupDb = new Database(dbPath);
  applyWritablePragmas(setupDb);
  runIndexedSchemaMigrations(setupDb, CURRENT_SCHEMA_VERSION);
  setupDb.close();
  const db = new Database(dbPath, { create: false, readwrite: true });

  const token = generateClipToken();
  const vault = makeInMemoryVault();
  await addApiToken(vault, "http-api-e2e-harness", token, scopes);

  const handle: ReadOnlyHttpServerHandle = startReadOnlyHttpServer(dbPath, 0, {
    ...extraOpts,
    clipsVault: vault,
  });

  return {
    port: handle.port,
    token,
    db,
    stop(): void {
      runQuietly([
        () => handle.stop(),
        () => db.close(),
        () => rmSync(tmpDir, { recursive: true, force: true }),
      ]);
    },
  };
}

/**
 * Same as `startServerWithClipToken`, but omits `clipsVault` entirely — the "surface not mounted"
 * shape every route behind this seam must degrade to (a named 404, never a fall-through to the
 * unauthenticated GET table). No token is minted since there is no vault to mint it into.
 */
export async function startServerWithoutClipsVault(
  // `clipsVault` is EXCLUDED at the type level, not merely omitted by convention: this helper exists
  // to prove the "surface not mounted" branch, and a caller who spread a vault in through `extraOpts`
  // would silently mount the clip-token surface while the function name still promised the opposite —
  // turning a fail-closed regression test into one that asserts nothing.
  extraOpts: Partial<Omit<ReadOnlyHttpServerOptions, "clipsVault">> = {},
): Promise<Omit<ClipTestServer, "token">> {
  const tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "nimbus-http-api-e2e-unmounted-")));
  const dbPath = join(tmpDir, "nimbus.db");
  const setupDb = new Database(dbPath);
  applyWritablePragmas(setupDb);
  runIndexedSchemaMigrations(setupDb, CURRENT_SCHEMA_VERSION);
  setupDb.close();
  const db = new Database(dbPath, { create: false, readwrite: true });

  const handle: ReadOnlyHttpServerHandle = startReadOnlyHttpServer(dbPath, 0, { ...extraOpts });

  return {
    port: handle.port,
    db,
    stop(): void {
      runQuietly([
        () => handle.stop(),
        () => db.close(),
        () => rmSync(tmpDir, { recursive: true, force: true }),
      ]);
    },
  };
}
