import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse, resolve } from "node:path";
import { upsertGraphEntity, upsertGraphRelation } from "../graph/relationship-graph.ts";
import { upsertIndexedItem } from "../index/item-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import { materializeMigratedDb, openMigratedDb } from "../index/migrated-db-template.ts";
import {
  isVecLoaded,
  lastVecLoadFailure,
  resetVecLoadFailureForTest,
  tryLoadSqliteVec,
} from "../index/sqlite-vec-load.ts";
import { ensureFullSqlite } from "../platform/sqlite-runtime.ts";
import {
  type DiagnosticsRpcContext,
  DiagnosticsRpcError,
  dispatchDiagnosticsRpc,
} from "./diagnostics-rpc.ts";

/**
 * `diagnostics-rpc.ts` paths the main suite does not reach: a connector-health row with none of its
 * optional fields set (and no successful sync), the auto-update block of `diag.snapshot`, its
 * `vectorSearch` block on a connection WITHOUT sqlite-vec (with and without a recorded load
 * failure), an unusable telemetry-marker path failing closed with the filesystem's own error
 * (neither wrapped nor swallowed — though not the marker guard's non-ENOENT rethrow on its own, see
 * that test's stated bound), `telemetry.setEnabled(true)` with no marker, `index.querySql` with no
 * statement, and the `--no-downstream-incident` predicate honouring a `services` filter.
 */

const openDbs: Database[] = [];
const tempDirs: string[] = [];
afterEach(() => {
  // The recorded sqlite-vec failure is module state: never let one test's leak into the next file.
  resetVecLoadFailureForTest();
  for (const db of openDbs.splice(0)) db.close();
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 0, retryDelay: 0 });
    } catch {
      /* best-effort: the DB handle is closed first, so this only trips on a leaked handle */
    }
  }
});

function baseCtx(
  dataDir: string,
  over: Partial<DiagnosticsRpcContext> = {},
): DiagnosticsRpcContext {
  return {
    dataDir,
    configDir: dataDir,
    consent: { pendingCount: () => 0 } as never,
    gatewayVersion: "0.0.0-test",
    startedAtMs: Date.now(),
    ...over,
  };
}

function ctxWithIndex(over: Partial<DiagnosticsRpcContext> = {}): {
  ctx: DiagnosticsRpcContext;
  db: Database;
} {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-edges-"));
  tempDirs.push(dir);
  const db = openMigratedDb(join(dir, "nimbus.db"));
  openDbs.push(db);
  return { ctx: baseCtx(dir, { localIndex: new LocalIndex(db), ...over }), db };
}

async function hitValue<T>(out: unknown): Promise<T> {
  const settled = await out;
  expect((settled as { kind: string }).kind).toBe("hit");
  return (settled as { value: T }).value;
}

describe("diag.snapshot", () => {
  test("a health row with no optional fields serializes to the three required keys only", async () => {
    const { ctx, db } = ctxWithIndex();
    // Never synced successfully, never backed off, no error: every optional column NULL.
    db.run(
      `INSERT INTO sync_state
         (connector_id, last_sync_at, next_sync_token, health_state, retry_after, backoff_until, backoff_attempt, last_error)
       VALUES ('slack', NULL, NULL, 'healthy', NULL, NULL, 0, NULL)`,
    );
    const v = await hitValue<{
      connectorHealth: Array<Record<string, unknown>>;
      index: { lastSuccessfulSyncByConnector: Record<string, number | null> };
    }>(dispatchDiagnosticsRpc("diag.snapshot", null, ctx));
    const slack = v.connectorHealth.find((h) => h["connectorId"] === "slack");
    // Strict: an optional key present-but-undefined would pass a plain `toEqual`.
    expect(slack).toStrictEqual({ connectorId: "slack", state: "healthy", backoffAttempt: 0 });
    expect(Object.keys(slack ?? {}).sort()).toEqual(["backoffAttempt", "connectorId", "state"]);
    // A connector with a sync_state row but no successful sync is an explicit null, not absent.
    expect(Object.hasOwn(v.index.lastSuccessfulSyncByConnector, "slack")).toBe(true);
    expect(v.index.lastSuccessfulSyncByConnector["slack"]).toBeNull();
  });

  test("the auto-update block appears only when the gateway wired one, with its live count", async () => {
    let calls = 0;
    const { ctx } = ctxWithIndex({
      autoUpdateDiag: {
        cachedUpdatesCount: () => {
          calls++;
          return 3;
        },
        intervalHours: 12,
        airGapBlocked: true,
      },
    });
    const v = await hitValue<{ extensions: Record<string, unknown> }>(
      dispatchDiagnosticsRpc("diag.snapshot", null, ctx),
    );
    expect(v.extensions["auto_update"]).toEqual({
      cached_updates_count: 3,
      interval_hours: 12,
      air_gap_blocked: true,
    });
    expect(calls).toBe(1);

    const bare = await hitValue<{ extensions: Record<string, unknown> }>(
      dispatchDiagnosticsRpc("diag.snapshot", null, ctxWithIndex().ctx),
    );
    expect(bare.extensions).not.toHaveProperty("auto_update");
  });
});

describe("diag.snapshot — vectorSearch, the field `nimbus doctor` reads (issue #1029)", () => {
  /**
   * A fully migrated index opened WITHOUT loading sqlite-vec on this connection — the state every
   * macOS install was in before #1029 was diagnosed. `materializeMigratedDb` copies the migrated
   * template and leaves it closed; a bare `new Database` then never loads the extension.
   */
  function ctxWithoutVec(): DiagnosticsRpcContext {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-novec-"));
    tempDirs.push(dir);
    const file = join(dir, "nimbus.db");
    materializeMigratedDb(file);
    const db = new Database(file);
    openDbs.push(db);
    expect(isVecLoaded(db)).toBe(false); // premise: otherwise this proves nothing
    return baseCtx(dir, { localIndex: new LocalIndex(db) });
  }

  /**
   * Record a both-paths-failed load, exactly as a gateway connection that could not load vec would.
   * Starts from a clean slate so the failure read back is THIS one. Where the platform's sqlite-vec
   * package is installed (every CI leg) the upstream error is `message`, thrown by the fake handle;
   * where it is not, the package fails to resolve first and that is the recorded error instead —
   * either way it is a real recorded failure, which is all the snapshot is asked to carry.
   */
  function recordVecFailure(message: string) {
    resetVecLoadFailureForTest();
    const failing = {
      loadExtension: (_path: string): void => {
        throw new Error(message);
      },
    } as unknown as Database;
    expect(tryLoadSqliteVec(failing)).toBe(false);
    const failure = lastVecLoadFailure();
    if (failure === undefined) throw new Error("premise: the failed load was not recorded");
    expect(failure.upstreamError.length).toBeGreaterThan(0);
    return failure;
  }

  async function vectorSearch(ctx: DiagnosticsRpcContext): Promise<Record<string, unknown>> {
    const v = await hitValue<{ vectorSearch: Record<string, unknown> }>(
      dispatchDiagnosticsRpc("diag.snapshot", null, ctx),
    );
    return v.vectorSearch;
  }

  const runtime = ensureFullSqlite();

  /**
   * Whether this host can load sqlite-vec at all — the same probe the repo's other vec-dependent
   * suites use. Only the "HAS sqlite-vec" case needs it; the two vec-LESS cases run everywhere.
   */
  const VEC_AVAILABLE = ((): boolean => {
    const probe = new Database(":memory:");
    try {
      tryLoadSqliteVec(probe);
      return isVecLoaded(probe);
    } finally {
      probe.close();
    }
  })();

  test("not loaded and nothing recorded: loaded:false and the runtime verdict, no failure keys", async () => {
    const ctx = ctxWithoutVec();
    // After building the context: on a host that cannot load vec, materialising the migrated
    // template records a failure of its own, which is not what this case is about.
    resetVecLoadFailureForTest();
    expect(await vectorSearch(ctx)).toStrictEqual({
      loaded: false,
      sqliteRuntimeState: runtime.state,
      sqliteRuntimeDetail: runtime.detail,
    });
  });

  test("not loaded with a recorded failure: the failure's three facts travel verbatim", async () => {
    const ctx = ctxWithoutVec();
    const failure = recordVecFailure("upstream boom (diag.snapshot)");
    expect(await vectorSearch(ctx)).toStrictEqual({
      loaded: false,
      sqliteRuntimeState: runtime.state,
      sqliteRuntimeDetail: runtime.detail,
      upstreamError: failure.upstreamError,
      sidecarPath: failure.sidecarPath,
      sidecarError: failure.sidecarError,
    });
  });

  test.skipIf(!VEC_AVAILABLE)(
    "a connection that HAS sqlite-vec is reported loaded, whatever another connection recorded",
    async () => {
      const { ctx, db } = ctxWithIndex();
      expect(isVecLoaded(db)).toBe(true); // premise: openMigratedDb loads it where the probe could
      recordVecFailure("a failure on some other connection");
      const vs = await vectorSearch(ctx);
      expect(vs["loaded"]).toBe(true);
      for (const key of ["upstreamError", "sidecarPath", "sidecarError"]) {
        expect(vs).not.toHaveProperty(key);
      }
    },
  );
});

describe("telemetry marker", () => {
  test("an unusable marker path fails closed with the filesystem's own error, past the temp check", () => {
    // A NUL byte makes the path itself invalid (ERR_INVALID_ARG_VALUE) on every platform, before
    // anything touches the disk. The directory sits at the filesystem root, so `disableMark`'s
    // under-temp refusal (a DiagnosticsRpcError) does not fire and the marker-path guard is
    // reached. Stated bound: the guard's non-ENOENT rethrow is not distinguishable here from the
    // write that would follow it — both reject this path with the same error.
    const dataDir = resolve(parse(tmpdir()).root, "nimbus-diag-\u0000-edge");
    for (const [method, params] of [
      ["telemetry.disableMark", null],
      ["telemetry.setEnabled", { enabled: false }],
    ] as const) {
      let caught: unknown;
      try {
        dispatchDiagnosticsRpc(method, params, baseCtx(dataDir));
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(caught).not.toBeInstanceOf(DiagnosticsRpcError);
      expect((caught as NodeJS.ErrnoException).code).toBe("ERR_INVALID_ARG_VALUE");
    }
  });

  test("setEnabled(true) with no marker present is a no-op that still answers enabled:true", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-tele-"));
    tempDirs.push(dir);
    const v = await hitValue<{ enabled: boolean }>(
      dispatchDiagnosticsRpc("telemetry.setEnabled", { enabled: true }, baseCtx(dir)),
    );
    expect(v).toEqual({ enabled: true });
    expect(existsSync(join(dir, ".nimbus-telemetry-disabled"))).toBe(false);
  });
});

describe("index.querySql", () => {
  test("no sql at all is the guard's empty-statement refusal, as -32602", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-sql-"));
    tempDirs.push(dir);
    for (const params of [{}, { sql: 42 }, null]) {
      const err: unknown = await Promise.resolve(
        dispatchDiagnosticsRpc("index.querySql", params, baseCtx(dir)),
      ).then(
        (v) => new Error(`resolved: ${JSON.stringify(v)}`),
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(DiagnosticsRpcError);
      expect((err as DiagnosticsRpcError).rpcCode).toBe(-32602);
      expect((err as DiagnosticsRpcError).message).toBe("SQL statement is empty");
    }
  });
});

describe("index.queryItems --no-downstream-incident", () => {
  function seedDeployment(db: Database, service: string, externalId: string): string {
    upsertIndexedItem(db, {
      service,
      type: "deployment",
      externalId,
      title: `deploy ${externalId}`,
      modifiedAt: 1,
      syncedAt: 1,
    });
    const itemId = `${service}:${externalId}`;
    return upsertGraphEntity(db, { type: "deployment", externalId: itemId, label: itemId });
  }

  test("a services filter narrows the clean deployments to those services", async () => {
    const { ctx, db } = ctxWithIndex();
    // One correlated deploy so the substrate probe passes, then a clean deploy per service.
    const hot = seedDeployment(db, "github", "d-hot");
    const incident = upsertGraphEntity(db, { type: "incident", externalId: "inc-1", label: "inc" });
    upsertGraphRelation(db, hot, incident, "correlates_with", 1);
    seedDeployment(db, "github", "d-gh-clean");
    seedDeployment(db, "gitlab", "d-gl-clean");

    // An item's wire `id` is its EXTERNAL id; `service` says which connector it came from.
    const key = (i: { service: string; id: string }) => `${i.service}/${i.id}`;

    const all = await hitValue<{ items: Array<{ service: string; id: string }> }>(
      dispatchDiagnosticsRpc("index.queryItems", { noDownstreamIncident: true }, ctx),
    );
    expect(all.items.map(key).sort()).toEqual(["github/d-gh-clean", "gitlab/d-gl-clean"]);

    const scoped = await hitValue<{ items: Array<{ service: string; id: string }> }>(
      dispatchDiagnosticsRpc(
        "index.queryItems",
        { noDownstreamIncident: true, services: ["gitlab"] },
        ctx,
      ),
    );
    expect(scoped.items.map(key)).toEqual(["gitlab/d-gl-clean"]);
  });
});
