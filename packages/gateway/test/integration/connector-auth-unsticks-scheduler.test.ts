import { describe, expect, test } from "bun:test";
import { getConnectorHealth, transitionHealth } from "../../src/connectors/health.ts";
import { LocalIndex } from "../../src/index/local-index.ts";
import { handleConnectorAuth } from "../../src/ipc/connector-rpc-handlers/auth.ts";
import type { ConnectorRpcHandlerContext } from "../../src/ipc/connector-rpc-handlers/context.ts";
import { SyncScheduler } from "../../src/sync/scheduler.ts";
import type { Syncable, SyncResult, SyncRuntimeContext } from "../../src/sync/types.ts";
import {
  createMemoryVault,
  createSyncTestContext,
  openMemoryIndexDatabase,
} from "../../src/testing/bun-test-support.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Polls until `counter.runs` reaches `min` or `timeoutMs` elapses. Used only for
 * the "this SHOULD happen" assertion below — a fixed sleep there would be a race
 * on a loaded CI runner (if no tick lands inside a fixed window the test fails
 * for a reason unrelated to the behaviour under test). The "this should NOT
 * happen" assertion earlier in the test stays a fixed sleep on purpose: waiting
 * longer only makes that assertion stronger, and there is no "done" signal to
 * poll for when proving an absence.
 */
async function waitForRuns(
  counter: { runs: number },
  min: number,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (counter.runs < min && Date.now() < deadline) {
    await sleep(10);
  }
}

/**
 * A syncable that just counts invocations — the only thing this test needs to
 * observe whether the scheduler's tick loop actually dispatched a run. The
 * scheduler's health-gate check (`healthGatePreventsDispatchSnapshot`) and its
 * `SKIP_HEALTH_STATES` membership test are both private, so this counter is the
 * one externally-observable signal of "did the scheduler decide to sync me".
 */
function countingSyncable(
  serviceId: string,
  intervalMs: number,
  counter: { runs: number },
): Syncable {
  return {
    serviceId,
    defaultIntervalMs: intervalMs,
    initialSyncDepthDays: 30,
    async sync(): Promise<SyncResult> {
      counter.runs += 1;
      return { cursor: null, itemsUpserted: 0, itemsDeleted: 0, hasMore: false, durationMs: 0 };
    },
  };
}

describe("connector re-auth unsticks a scheduler stuck on unauthenticated health", () => {
  test("re-auth after an expired token lets the scheduled tick dispatch again", async () => {
    const db = openMemoryIndexDatabase();
    const vault = createMemoryVault();
    const localIndex = new LocalIndex(db);
    // A SyncScheduler takes the GATEWAY-side context: it holds the handles because it is what
    // MINTS a capability per service. A connector-facing SyncContext has neither.
    const syncCtx: SyncRuntimeContext = {
      ...createSyncTestContext(db, vault, "github"),
      db,
      vault,
    };

    const counter = { runs: 0 };
    const scheduler = new SyncScheduler(syncCtx);
    scheduler.register(countingSyncable("github", 20, counter));

    // 1. The token expires: a real sync would throw UnauthenticatedError and the
    // health latches (this simulates that latch directly, the way the scheduler
    // itself does inside its own error-handling path).
    transitionHealth(db, "github", { type: "unauthenticated" });
    expect(getConnectorHealth(db, "github").state).toBe("unauthenticated");

    scheduler.start();
    // Everything past `start()` runs inside try/finally: an assertion failing below would
    // otherwise skip `stop()` and leak a live 25ms interval into whatever test runs next,
    // turning one real failure into unrelated downstream noise (or a suite-wide timeout).
    try {
      // Several 25ms tick cycles pass; SKIP_HEALTH_STATES + the unconditional-true
      // arm for "unauthenticated" must keep every one of them from dispatching.
      await sleep(180);
      expect(counter.runs).toBe(0);
      expect(getConnectorHealth(db, "github").state).toBe("unauthenticated");

      // 2. The user runs `nimbus connector auth github` with a good token. This
      // goes through the SAME `verifyBeforeStore` → `markConnectorReauthenticated`
      // path Task 3 wired, with the real credential-probe network call replaced by
      // the injected test seam so nothing leaves the machine.
      const authCtx: ConnectorRpcHandlerContext = {
        rec: { service: "github", token: "fresh-pat" },
        vault,
        localIndex,
        openUrl: async (_url: string): Promise<void> => {},
        syncScheduler: undefined,
        connectorMesh: undefined,
        runCredentialProbe: async () => ({ kind: "valid" }),
      };
      await handleConnectorAuth(authCtx);

      // 3. The health event fired synchronously inside handleConnectorAuth.
      expect(getConnectorHealth(db, "github").state).toBe("healthy");

      // 4. Without Task 1's `reauthenticated` event (and Task 3's call to it) this
      // stays stuck forever: SKIP_HEALTH_STATES contains "unauthenticated" and the
      // gate returns an unconditional true for it — only a FORCED sync bypasses
      // that gate, and the scheduled (tick-driven) path never does. The scheduler
      // is still running from step 1 (never stopped/restarted — `start()` is a
      // no-op once `stop()` has been called), so the very next tick must now pick
      // the connector back up on its own.
      await waitForRuns(counter, 1);
      expect(counter.runs).toBeGreaterThanOrEqual(1);
    } finally {
      await scheduler.stop();
    }
  });
});
