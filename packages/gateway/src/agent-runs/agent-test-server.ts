/**
 * Test-only harness for the agents-over-HTTP surface. Boots a REAL `startReadOnlyHttpServer` on
 * port 0 with a fresh temp-dir SQLite DB (migrated to latest), an in-memory vault holding one
 * known token, a real `AgentRunController` over an injectable clock, and the real
 * `buildAgentHttpInvoker`.
 *
 * Modelled on `briefs/brief-test-server.ts`. NOT itself a `*.test.ts` file — the e2e suite imports
 * `startAgentTestServer` rather than redefining it, so this stays the single source of the harness.
 */

import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import type { ReadOnlyHttpServerHandle } from "../ipc/http-server.ts";
import { startReadOnlyHttpServer } from "../ipc/http-server.ts";
import { createSeededTokenVault } from "../ipc/test-token-vault.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { buildAgentHttpInvoker } from "./agent-http-invoke.ts";
import { AgentRunController, MAX_CONCURRENT_AGENT_RUNS } from "./agent-run-store.ts";

const KNOWN_TOKEN = "agent-test-token-0123456789abcdef0123456789abcd";
const KNOWN_LABEL = "agent-test-harness";

function makeInMemoryVault(tokensJson?: string): NimbusVault {
  // The scoped form WITH `agents`, unlike the briefs harness's legacy default: every agents route
  // is agents-scoped, so a legacy seed would 403 the positive tests for the wrong reason. The
  // override exists so the legacy and narrow-scope cases can still be exercised explicitly.
  return createSeededTokenVault(
    tokensJson ??
      JSON.stringify({
        [KNOWN_LABEL]: { token: KNOWN_TOKEN, scopes: ["clip", "briefs", "agents"] },
      }),
  );
}

export type AgentTestServer = {
  readonly port: number;
  readonly token: string;
  readonly db: Database;
  advance(ms: number): void;
  /** Reserves every concurrency slot so a test can exercise the busy 429 deterministically. */
  fillRunCapacity(): void;
  stop(): void;
};

export async function startAgentTestServer(opts?: {
  ttlMs?: number;
  /** false => omit agentRuns, so the seam is absent (every /v1/agents route 404s). */
  enabled?: boolean;
  /** Raw JSON for `http_api.web_clipper_tokens`. Omit for the scoped agents-capable default. */
  tokensJson?: string;
}): Promise<AgentTestServer> {
  const enabled = opts?.enabled ?? true;

  const tmpDir = mkdtempSync(join(tmpdir(), "nimbus-agent-e2e-"));
  const dbPath = join(tmpDir, "nimbus.db");

  // Migrate + close (same pattern as brief-test-server.ts): the server opens its own readonly +
  // writable handles on `dbPath`, so the setup connection must not linger.
  const setupDb = new Database(dbPath);
  runIndexedSchemaMigrations(setupDb, CURRENT_SCHEMA_VERSION);
  setupDb.close();

  // A separate writable handle held only by this harness, for asserting on ledger rows — distinct
  // from the server's own handles.
  const db = new Database(dbPath, { create: false, readwrite: true });

  let clockMs = Date.now();
  const nowMs = (): number => clockMs;

  const vault = makeInMemoryVault(opts?.tokensJson);
  const runs = new AgentRunController({
    nowMs,
    ...(opts?.ttlMs === undefined ? {} : { ttlMs: opts.ttlMs }),
  });

  const handle: ReadOnlyHttpServerHandle = startReadOnlyHttpServer(dbPath, 0, {
    nowMs,
    ...(enabled
      ? {
          clipsVault: vault,
          agentRuns: runs,
          // No LLM registry in this harness — explicit `undefined` (router is now required, not
          // optional) so a future HTTP boot path can't leave it out silently.
          agentInvoke: buildAgentHttpInvoker({ db, runs, router: undefined }),
        }
      : // Opens the I13 write surface for an UNRELATED reason (no deployment token check is
        // exercised) so POST /v1/agents/{agent} still reaches dispatchWriteRoute's per-route
        // `ctx.agents === undefined` check (agents_disabled, 404) instead of the generic
        // writeDb===null 405 — proving the disabled-seam 404 + hint, not a method-not-allowed.
        { resolveDeploymentToken: async () => "agent-test-server-unused-deploy-token" }),
  });

  return {
    port: handle.port,
    token: KNOWN_TOKEN,
    db,
    advance(ms: number): void {
      clockMs += ms;
    },
    fillRunCapacity(): void {
      // RESERVES rather than opens: a real invocation's brief can reach a terminal state before the
      // next request and free the slot, which would make a busy-refusal test flaky.
      for (let i = 0; i < MAX_CONCURRENT_AGENT_RUNS; i++) runs.admit();
    },
    stop(): void {
      try {
        handle.stop();
      } catch {
        /* ignore */
      }
      try {
        db.close();
      } catch {
        /* ignore */
      }
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}
