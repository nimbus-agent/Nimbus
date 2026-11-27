import { Database } from "bun:sqlite";
import { join } from "node:path";
import type { Logger } from "pino";
import type { loadNimbusFilesystemRootsFromConfigDir } from "../../config/filesystem-toml.ts";
import {
  loadNimbusEmbeddingFromConfigDir,
  loadTomlSectionFromConfig,
} from "../../config/nimbus-toml.ts";
import type { loadNimbusSessionFromConfigDir } from "../../config/session-toml.ts";
import { Config } from "../../config.ts";
import { createBlameIndexSyncable } from "../../connectors/blame-index-sync.ts";
import { defaultSyncIntervalMsForService } from "../../connectors/connector-catalog.ts";
import { readConnectorSecret } from "../../connectors/connector-vault.ts";
import { createFilesystemV2Syncable } from "../../connectors/filesystem-v2-sync.ts";
import { createObsidianSyncable } from "../../connectors/obsidian-sync.ts";
import {
  DEFAULT_OPENAPI_CONFIG,
  type OpenapiConfig,
  parseOpenapiToml,
} from "../../connectors/openapi-indexer-config.ts";
import { createOpenapiIndexerSyncable } from "../../connectors/openapi-indexer-sync.ts";
import { startLatencyFlushScheduler } from "../../db/latency-ring-buffer.ts";
import { applyWritablePragmas, optimizeQueryPlanner } from "../../db/writable-pragmas.ts";
import { createBatteryBackfillGate } from "../../embedding/backfill-gate.ts";
import { createEmbeddingRuntimeNonBlocking } from "../../embedding/create-embedding-runtime.ts";
import {
  embedQueryBestEffort,
  embedQueryDualOutcome,
} from "../../embedding/embedding-readiness.ts";
import type { EmbeddingRuntime as ConcreteEmbeddingRuntime } from "../../embedding/embedding-runtime.ts";
import {
  LocalIndex,
  type LocalIndexOptions,
  type SemanticSearchDeps,
} from "../../index/local-index.ts";
import { readIndexedUserVersion } from "../../index/migrations/runner.ts";
import { mergeRoots } from "../../index/registered-roots-store.ts";
import { SessionMemoryStore } from "../../memory/session-memory-store.ts";
import type { SyncScheduler } from "../../sync/scheduler.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import type { HostActivity } from "../host-activity.ts";
import { ensureOwnerOnlyFile, tightenToOwnerOnly } from "../owner-only-mode.ts";
import type { PlatformPaths } from "../paths.ts";
import { ensureFullSqlite } from "../sqlite-runtime.ts";

function loadOpenapiConfig(configDir: string): OpenapiConfig {
  return loadTomlSectionFromConfig(configDir, "openapi", DEFAULT_OPENAPI_CONFIG, parseOpenapiToml);
}

export type EmbeddingRuntime = ConcreteEmbeddingRuntime | null;

export function openGatewaySqlite(
  dataDir: string,
  sidecarStops: Array<() => void>,
): { db: Database; dbPath: string } {
  const dbPath = join(dataDir, "nimbus.db");
  // Before the first `new Database(...)` in this process: on macOS `Database.setCustomSQLite`
  // only works while no database is open, and without it `loadExtension` — and therefore
  // sqlite-vec — cannot work at all. No-op off darwin. See platform/sqlite-runtime.ts.
  ensureFullSqlite();
  // Owner-only before the first open, so SQLite creates `-wal`/`-shm` with the same mode; the
  // sidecars of an older install are tightened explicitly.
  ensureOwnerOnlyFile(dbPath);
  tightenToOwnerOnly(`${dbPath}-wal`);
  tightenToOwnerOnly(`${dbPath}-shm`);
  const db = new Database(dbPath);
  // Before ensureSchema: migrations write, and this is the handle that converts
  // nimbus.db to WAL for every other connection (journal_mode is a file property).
  applyWritablePragmas(db);
  LocalIndex.ensureSchema(db, { backupDir: join(dataDir, "backups"), dbPath });
  optimizeQueryPlanner(db);
  const stopLatency = startLatencyFlushScheduler(db);
  sidecarStops.push(() => stopLatency.stop());
  return { db, dbPath };
}

/**
 * #928 — bind-first. This used to `await` the embedding runtime, which on a cold machine
 * awaited a MiniLM fetch from a third-party CDN: the IPC socket stayed unbound for as long
 * as the download took (up to the 600 s worker init window), and `nimbus init` looked hung.
 * `createEmbeddingRuntimeNonBlocking` returns on the same tick and warms up in the background,
 * so assembly reaches `ipc.start()` immediately.
 */
export function createLocalIndexWithEmbeddingRuntime(
  db: Database,
  paths: PlatformPaths,
  vault: NimbusVault,
  syncLogger: Logger,
  configDir: string,
  hostActivity: HostActivity,
  sidecarStops: Array<() => void>,
): {
  localIndex: LocalIndex;
  scheduleItemEmbedding: ((itemId: string) => void) | undefined;
  rt: EmbeddingRuntime;
} {
  const tomlEmbedding = loadNimbusEmbeddingFromConfigDir(configDir);
  // `[embedding] pause_on_battery` has parsed and defaulted to `true` since it was added and
  // nothing has ever read it — a key that lied about what it does. This is its consumer.
  //
  // Built HERE rather than inside the runtime factory because it owns a cancellable poll timer and
  // this is the scope that holds `sidecarStops`: the timer is deliberately not `unref`'d (an
  // unref'd timer never fires when nothing else holds the loop, which would make the pause
  // permanent in a quiet process), so it needs a real teardown.
  const backfill = createBatteryBackfillGate({
    pauseOnBattery: tomlEmbedding.pauseOnBattery,
    hostActivity,
  });
  sidecarStops.push(() => backfill.stop());
  process.stdout.write("[gateway] starting embedding runtime (background)\n");
  const rt = createEmbeddingRuntimeNonBlocking(
    db,
    paths,
    syncLogger,
    tomlEmbedding,
    Config.embeddingsEnabled,
    vault,
    { backfillGate: backfill.gate },
  );
  let scheduleItemEmbedding: ((itemId: string) => void) | undefined;
  let semanticSearch: SemanticSearchDeps | undefined;
  if (rt) {
    scheduleItemEmbedding = rt.scheduleItemEmbedding.bind(rt);
    // DELIBERATE degradation seam. `searchRankedAsync` runs on every ask/agent/brief path, and
    // a warming or timed-out embed throwing there would take `nimbus ask` down with it. It
    // therefore degrades to BM25 — and the degrade is NOT hidden: `embedQueryDualOutcome` keeps
    // the reason, and `searchRankedAsync` hands every caller a `retrieval` block saying the
    // results were keyword-only and why (see `index/search-retrieval.ts`).
    semanticSearch = {
      model: rt.getEmbeddingModel(),
      embedQuery: (text: string) => embedQueryBestEffort(rt, text),
      embedQueryDualOutcome: (text: string) => embedQueryDualOutcome(rt, text),
      activeBackfillPass: () => rt.getActiveBackfillPass(),
    };
  }
  const localIndexOpts: LocalIndexOptions = {};
  if (scheduleItemEmbedding !== undefined) {
    localIndexOpts.scheduleItemEmbedding = scheduleItemEmbedding;
  }
  if (semanticSearch !== undefined) {
    localIndexOpts.semanticSearch = semanticSearch;
  }
  const hasEmbeddingIndexOpts = scheduleItemEmbedding !== undefined || semanticSearch !== undefined;
  const localIndex = hasEmbeddingIndexOpts
    ? new LocalIndex(db, localIndexOpts)
    : new LocalIndex(db);
  return { localIndex, scheduleItemEmbedding, rt };
}

export async function ensureGithubCircleCiSchedulerCompanions(
  localIndex: LocalIndex,
  vault: NimbusVault,
): Promise<void> {
  const pat = await readConnectorSecret(vault, "github", "pat");
  localIndex.ensureGithubActionsSchedulerCompanionIfNeeded({
    githubPatPresent: pat !== null && pat !== "",
    now: Date.now(),
    intervalMs: defaultSyncIntervalMsForService("github_actions"),
  });
  // Phase 7 slice 5: the billing usage sync is a companion of github too (it does nothing until
  // `[cost.github] orgs` is set), on its own daily interval.
  if (pat !== null && pat !== "") {
    localIndex.ensureConnectorSchedulerRegistration(
      "github_billing",
      defaultSyncIntervalMsForService("github_billing"),
      Date.now(),
    );
  }
  const cciTok = await readConnectorSecret(vault, "circleci", "api_token");
  localIndex.ensureCircleciSchedulerCompanionIfNeeded({
    circleciTokenPresent: cciTok !== null && cciTok !== "",
    now: Date.now(),
    intervalMs: defaultSyncIntervalMsForService("circleci"),
  });
}

const DEFAULT_EMBEDDING_DIMS = 384;

export function maybeAttachSessionMemoryStore(
  db: Database,
  rt: EmbeddingRuntime,
  sessionToml: ReturnType<typeof loadNimbusSessionFromConfigDir>,
  sidecarStops: Array<() => void>,
): SessionMemoryStore | undefined {
  if (readIndexedUserVersion(db) < 10) {
    return undefined;
  }
  const sessionMemoryStore =
    rt == null
      ? new SessionMemoryStore({
          db,
          dims: DEFAULT_EMBEDDING_DIMS,
          embedText: () => Promise.resolve(null),
        })
      : new SessionMemoryStore({
          db,
          dims: rt.getEmbeddingDims(),
          // Best-effort by design: session-memory recall ADDS optional context and never
          // reports "no results" to a human, so a warming model degrades it rather than
          // failing the turn. Explicit, not accidental (#928).
          embedText: (t) => embedQueryBestEffort(rt, t),
        });
  const ttlMs = Math.max(1, sessionToml.memoryTtlHours) * 3_600_000;
  const timer = setInterval(() => {
    try {
      sessionMemoryStore.pruneExpired(ttlMs, Date.now());
    } catch {
      /* ignore */
    }
  }, 3_600_000);
  sidecarStops.push(() => clearInterval(timer));
  return sessionMemoryStore;
}

// Register the filesystem-root-backed syncables (filesystem-v2 / openapi-indexer / obsidian) on the
// real scheduler. These are NOT policy connectors, so they register directly (no allowlist filter).
export function registerFilesystemRootSyncables(
  syncScheduler: SyncScheduler,
  localIndex: LocalIndex,
  configDir: string,
  tomlRoots: ReturnType<typeof loadNimbusFilesystemRootsFromConfigDir>,
  registeredRoots: ReturnType<typeof loadNimbusFilesystemRootsFromConfigDir>,
): void {
  // filesystem-v2 (git commits + optional symbols/deps per the root's own flags) and the blame
  // indexer act on the full set — a CLI-registered blame root needs git_commit items so its blame
  // SHAs resolve (the why-lens join). TOML wins on collision; a missing folder is dropped.
  const allRoots = mergeRoots(tomlRoots, registeredRoots);
  if (allRoots.length > 0) {
    localIndex.ensureConnectorSchedulerRegistration("filesystem", 10 * 60 * 1000, Date.now());
    syncScheduler.register(createFilesystemV2Syncable({ roots: allRoots }));
    localIndex.ensureConnectorSchedulerRegistration("blame", 10 * 60 * 1000, Date.now());
    syncScheduler.register(createBlameIndexSyncable({ roots: allRoots }));
  }
  // OpenAPI spec indexing and Obsidian vault semantics are opt-in via [[filesystem.roots]] only:
  // `nimbus index add <repo>` registers a blame/index root, NOT an API-spec source or a note vault.
  if (tomlRoots.length > 0) {
    localIndex.ensureConnectorSchedulerRegistration("openapi", 10 * 60 * 1000, Date.now());
    syncScheduler.register(
      createOpenapiIndexerSyncable({
        roots: tomlRoots,
        config: loadOpenapiConfig(configDir),
      }),
    );
    localIndex.ensureConnectorSchedulerRegistration("obsidian", 10 * 60 * 1000, Date.now());
    syncScheduler.register(createObsidianSyncable({ roots: tomlRoots }));
  }
}
