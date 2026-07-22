/**
 * Test-only harness for the research-briefs HTTP surface. Boots a REAL
 * `startReadOnlyHttpServer` on port 0 with a fresh temp-dir SQLite DB (migrated
 * to latest), an in-memory vault holding one known clip/brief token, a real
 * `BriefRunController` over an injectable clock, and a `startRun` closure that
 * drives a run collecting -> running -> done/failed via `runSynthesis`.
 *
 * Modelled on `clips/clip-e2e.test.ts`. NOT itself a `*.test.ts` file — Task 14
 * (a later task) imports `startBriefTestServer` rather than redefining it, so
 * this stays the single source of the harness.
 */

import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import type { ReadOnlyHttpServerHandle } from "../ipc/http-server.ts";
import { startReadOnlyHttpServer } from "../ipc/http-server.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { buildRegistry } from "./brief-registry.ts";
import { BriefRunController } from "./brief-run-store.ts";
import { saveBriefReport } from "./brief-save.ts";
import type { BriefSynthesizerLlm } from "./brief-synthesis.ts";
import { runSynthesis } from "./brief-synthesis.ts";

const KNOWN_TOKEN = "brief-test-token-0123456789abcdef0123456789abcdef";
const KNOWN_LABEL = "brief-test-harness";

function makeInMemoryVault(): NimbusVault {
  const store = new Map<string, string>();
  store.set(
    "http_api.web_clipper_tokens",
    JSON.stringify({ [KNOWN_LABEL]: KNOWN_TOKEN } satisfies Record<string, string>),
  );
  return {
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
    listKeys: async (prefix?: string) => {
      const keys = [...store.keys()];
      return prefix === undefined ? keys : keys.filter((k) => k.startsWith(prefix));
    },
  };
}

/** Kicks off synthesis fire-and-forget — same contract as `BriefsWriteSurface.startRun`. */
function makeStartRun(
  controller: BriefRunController,
  llm: BriefSynthesizerLlm | null,
): (runId: string) => void {
  return (runId: string): void => {
    const run = controller.get(runId);
    if (run === null) return;
    controller.markRunning(run);
    void (async () => {
      const { registry, indexHits, semanticAvailable, searchFailed } = await buildRegistry(
        run,
        null,
      );
      const result = await runSynthesis({
        run,
        registry,
        indexHits,
        semanticAvailable,
        searchFailed,
        llm,
      });
      if ("report" in result) {
        controller.finish(run, result.report);
      } else {
        controller.fail(run, result.error);
      }
    })();
  };
}

function makeSave(
  controller: BriefRunController,
  db: Database,
): (runId: string) => { itemId: string } {
  return (runId: string): { itemId: string } => {
    const run = controller.get(runId);
    if (run === null) {
      throw new Error(`brief-test-server: save called for unknown/expired run ${runId}`);
    }
    return saveBriefReport(db, run);
  };
}

export type BriefTestServer = {
  readonly port: number;
  readonly token: string;
  readonly db: Database;
  advance(ms: number): void;
  stop(): void;
};

export async function startBriefTestServer(opts?: {
  llm?: BriefSynthesizerLlm | null;
  ttlMs?: number;
  /** false => omit briefRuns, so the seam is absent (every /v1/briefs route 404s). */
  enabled?: boolean;
}): Promise<BriefTestServer> {
  const enabled = opts?.enabled ?? true;
  const llm = opts?.llm ?? null;

  const tmpDir = mkdtempSync(join(tmpdir(), "nimbus-brief-e2e-"));
  const dbPath = join(tmpDir, "nimbus.db");

  // Migrate + close (same pattern as clip-e2e.test.ts / http-server.test.ts): the server opens
  // its own readonly + writable handles on `dbPath`, so the setup connection must not linger.
  const setupDb = new Database(dbPath);
  runIndexedSchemaMigrations(setupDb, 44);
  setupDb.close();

  // A separate writable handle, held only by this harness, for `save` (saveBriefReport) and for
  // the `db` field callers use to assert on saved items — distinct from the server's own handles.
  const db = new Database(dbPath, { create: false, readwrite: true });

  let clockMs = Date.now();
  const nowMs = (): number => clockMs;

  const vault = makeInMemoryVault();
  const controller = new BriefRunController({
    nowMs,
    ...(opts?.ttlMs === undefined ? {} : { ttlMs: opts.ttlMs }),
  });

  const handle: ReadOnlyHttpServerHandle = startReadOnlyHttpServer(dbPath, 0, {
    nowMs,
    ...(enabled
      ? {
          clipsVault: vault,
          briefRuns: controller,
          briefStartRun: makeStartRun(controller, llm),
          briefSave: makeSave(controller, db),
        }
      : // Opens the I13 write surface for an UNRELATED reason (no deployment token check is
        // exercised) so POST /v1/briefs still reaches dispatchWriteRoute's per-route
        // `ctx.briefs === undefined` check (briefsDisabled, 404) instead of the generic
        // writeDb===null 405 — proving the disabled-seam 404 + hint, not a method-not-allowed.
        { resolveDeploymentToken: async () => "brief-test-server-unused-deploy-token" }),
  });

  return {
    port: handle.port,
    token: KNOWN_TOKEN,
    db,
    advance(ms: number): void {
      clockMs += ms;
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
