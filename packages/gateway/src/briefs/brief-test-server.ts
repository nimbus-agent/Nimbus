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
import { materializeMigratedDb } from "../index/migrated-db-template.ts";
import type { ReadOnlyHttpServerHandle } from "../ipc/http-server.ts";
import { startReadOnlyHttpServer } from "../ipc/http-server.ts";
import { createSeededTokenVault } from "../ipc/test-token-vault.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import type { IndexHit, IndexSearch } from "./brief-registry.ts";
import { buildRegistry } from "./brief-registry.ts";
import { BriefRunController } from "./brief-run-store.ts";
import { saveBriefReport } from "./brief-save.ts";
import type { BriefSynthesizerLlm } from "./brief-synthesis.ts";
import { runSynthesis } from "./brief-synthesis.ts";
import type { Report } from "./brief-types.ts";

const KNOWN_TOKEN = "brief-test-token-0123456789abcdef0123456789abcdef";
const KNOWN_LABEL = "brief-test-harness";

function makeInMemoryVault(tokensJson?: string): NimbusVault {
  // Default stays the LEGACY bare-string shape on purpose: every existing test that uses this
  // harness then proves, for free, that a pre-scopes token still works.
  return createSeededTokenVault(
    tokensJson ?? JSON.stringify({ [KNOWN_LABEL]: KNOWN_TOKEN } satisfies Record<string, string>),
  );
}

/** Turns a fixed hit list into the `IndexSearch` seam, ignoring the query and limit. */
function makeIndexSearch(hits: IndexHit[]): IndexSearch {
  // `async` already wraps the return value in a promise; `Promise.resolve` on top of it is
  // redundant (S7746). The seam's signature is unchanged.
  return async (_query: string, limit: number) => ({
    hits: hits.slice(0, limit),
    semanticAvailable: true,
  });
}

/** Kicks off synthesis fire-and-forget — same contract as `BriefsWriteSurface.startRun`. */
function makeStartRun(
  controller: BriefRunController,
  llm: BriefSynthesizerLlm | null,
  search: IndexSearch | null,
): (runId: string) => void {
  return (runId: string): void => {
    const run = controller.get(runId);
    if (run === null) return;
    controller.markRunning(run);
    void (async () => {
      const { registry, indexHits, semanticAvailable, searchFailed } = await buildRegistry(
        run,
        search,
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
  /** Raw JSON for `http_api.web_clipper_tokens`. Omit for the legacy single-token default. */
  tokensJson?: string;
  /** Index hits served to any run with `useIndex: true`. Omit to leave the index seam unwired. */
  hits?: IndexHit[];
}): Promise<BriefTestServer> {
  const enabled = opts?.enabled ?? true;
  const llm = opts?.llm ?? null;
  const search = opts?.hits === undefined ? null : makeIndexSearch(opts.hits);

  const tmpDir = mkdtempSync(join(tmpdir(), "nimbus-brief-e2e-"));
  const dbPath = join(tmpDir, "nimbus.db");

  // Materialize a migrated database at `dbPath` and hold no handle on it: the server opens its
  // own readonly + writable handles, so a lingering setup connection would be a second writer.
  // This copies a template migrated once per process rather than replaying every migration per
  // harness — `materializeMigratedDb` closes its builder connection before copying, so the file
  // it leaves is complete and unowned, which is exactly what the old migrate-then-close did.
  materializeMigratedDb(dbPath);

  // A separate writable handle, held only by this harness, for `save` (saveBriefReport) and for
  // the `db` field callers use to assert on saved items — distinct from the server's own handles.
  const db = new Database(dbPath, { create: false, readwrite: true });

  let clockMs = Date.now();
  const nowMs = (): number => clockMs;

  const vault = makeInMemoryVault(opts?.tokensJson);
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
          briefStartRun: makeStartRun(controller, llm, search),
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

function mustMatch(m: RegExpMatchArray, group: number, what: string): string {
  const v = m[group];
  if (v === undefined) throw new Error(`${what}: capture group ${group} missing`);
  return v;
}

/**
 * Cites EVERY source and index-hit token the prompt carries (S1, S2, ..., C1, C2, ...) —
 * same trick as `brief-e2e.test.ts`'s `citeAllLlm`, widened to also catch `C*` tokens so a
 * finding cites each injected index hit deterministically, regardless of how many hits (or
 * which `itemType`s) the caller passes to `runBriefWithIndexHits`.
 */
function citeAllTokensLlm(): BriefSynthesizerLlm {
  return {
    generateJson: async (prompt: string) => {
      const tokens = [
        ...new Set(
          [...prompt.matchAll(/"token":"([A-Z]\d+)"/g)].map((m) =>
            mustMatch(m, 1, "citeAllTokensLlm token match"),
          ),
        ),
      ];
      const findings = tokens.map((t, i) => ({
        text: `Finding ${i + 1} supported by ${t}.`,
        refs: [t],
      }));
      // `generateJson` is already `async`, so the wrapper is redundant (S7746).
      return {
        text: JSON.stringify({
          summary: "Synthesized summary citing every available token.",
          findings,
          conflicts: [],
          gaps: [],
        }),
        model: "stub-cite-all-tokens",
        remote: false,
      };
    },
  };
}

/**
 * Drives one brief run through the same create -> feed -> run -> poll sequence as
 * `brief-e2e.test.ts`, with `hits` injected as the run's `IndexSearch`, and returns the
 * finished `Report`. Exported so callers (e.g. `brief-e2e.test.ts`) import this rather than
 * redefining the flow — this file stays the single source of the harness.
 */
export async function runBriefWithIndexHits(hits: IndexHit[]): Promise<Report> {
  const s = await startBriefTestServer({ llm: citeAllTokensLlm(), hits });
  try {
    const base = `http://127.0.0.1:${s.port}`;
    const authHeaders = { authorization: `Bearer ${s.token}` };
    const sourceUrl = "https://example.com/index-hits-source";

    const createRes = await fetch(`${base}/v1/briefs`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({
        brief: "What changed in the worker pool?",
        sources: [{ url: sourceUrl, title: "Source" }],
        useIndex: true,
      }),
    });
    if (createRes.status !== 200) {
      throw new Error(`runBriefWithIndexHits: create failed with ${createRes.status}`);
    }
    const created = (await createRes.json()) as { id: string };

    const feedRes = await fetch(`${base}/v1/briefs/${created.id}/sources`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({
        url: sourceUrl,
        title: "Source",
        body: "A fed source so the run has at least one declared source satisfied.",
        capturedAt: Date.now(),
        truncated: false,
      }),
    });
    if (feedRes.status !== 200) {
      throw new Error(`runBriefWithIndexHits: feeding the source failed with ${feedRes.status}`);
    }

    const runRes = await fetch(`${base}/v1/briefs/${created.id}/run`, {
      method: "POST",
      headers: authHeaders,
    });
    if (runRes.status !== 200) {
      throw new Error(`runBriefWithIndexHits: starting the run failed with ${runRes.status}`);
    }

    for (let i = 0; i < 200; i++) {
      const pollRes = await fetch(`${base}/v1/briefs/${created.id}`, { headers: authHeaders });
      if (pollRes.status !== 200) {
        throw new Error(`runBriefWithIndexHits: unexpected GET status ${pollRes.status}`);
      }
      const body = (await pollRes.json()) as { status: string; report?: Report };
      if (body.status === "done") {
        if (body.report === undefined) {
          throw new Error("runBriefWithIndexHits: done status but no report in the body");
        }
        return body.report;
      }
      if (body.status === "failed") {
        throw new Error("runBriefWithIndexHits: run reached status failed");
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(
      "runBriefWithIndexHits: run never reached a terminal state within the poll budget",
    );
  } finally {
    s.stop();
  }
}
