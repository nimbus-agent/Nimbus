import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_ONCALL_PUSH_CONFIG } from "../config/oncall-push-toml.ts";
import {
  createMemoryIndexDb,
  createStubVault,
  syncTestContext,
} from "../connectors/connector-sync-test-helpers.ts";
import { syncPagerdutyIncidentItems } from "../connectors/pagerduty-sync.ts";
import { AgentsRpcError } from "../ipc/agents-rpc.ts";
import { findPersonByCanonicalEmail } from "../people/person-store.ts";
import {
  createOncallPushRunner,
  type PushDelivery,
  type PushDispatch,
  PushRetryRefusedError,
} from "./push-runner.ts";
import { PushStore } from "./push-store.ts";

const ME = "me@acme.example";
const T0 = Date.parse("2026-10-02T12:00:00.000Z");
let db: Database;
let store: PushStore;
let personId: string;

function seedIncident(id: string): void {
  const ctx = syncTestContext(db, createStubVault({ "pagerduty.api_token": "tok" }), "pagerduty");
  syncPagerdutyIncidentItems(
    ctx,
    [
      {
        id,
        status: "triggered",
        title: `inc ${id}`,
        priority: { name: "P1" },
        created_at: new Date(T0).toISOString(),
        updated_at: new Date(T0).toISOString(),
        service: { id: "PSVC" },
        assignments: [{ assignee: { id: "U1", type: "user", email: ME } }],
      },
    ],
    new Date(T0 - 86_400_000).toISOString(),
    T0,
    new Map(),
  );
}

beforeEach(() => {
  db = createMemoryIndexDb();
  store = new PushStore(db);
  store.reconcileEnabledState(true, T0 - 60_000);
  seedIncident("PA");
  const me = findPersonByCanonicalEmail(db, ME);
  if (me === null) throw new Error("fixture: no person");
  personId = me.id;
});
afterEach(() => db.close());

/** A dispatch that answers like emitBriefWithSynthesis: sessionId now, briefReady later. */
const readyDispatch =
  (calls: unknown[]): PushDispatch =>
  async (method, params, ctx) => {
    calls.push({ method, params, kind: ctx.caller.kind, hasRunner: "runner" in ctx });
    queueMicrotask(() =>
      ctx.notify("oncall.briefReady", {
        sessionId: "s1",
        brief: "# brief\n## Gaps\n",
        findings: { ok: true },
      }),
    );
    return { sessionId: "s1" };
  };

function makeRunner(over: Partial<Parameters<typeof createOncallPushRunner>[0]> = {}) {
  const delivered: PushDelivery[] = [];
  const runner = createOncallPushRunner({
    db,
    store,
    config: { ...DEFAULT_ONCALL_PUSH_CONFIG, enabled: true },
    pagerdutyAliases: [],
    configDir: "unused-in-unit-tests",
    resolveSelf: async () => personId,
    deliver: async (items) => {
      delivered.push(...items);
    },
    now: () => T0,
    timeoutMs: 200,
    ...over,
  });
  return { runner, delivered };
}

describe("push runner", () => {
  test("dispatches agents.oncall {incidentId} as kind push, with NO runner, stores ok, delivers", async () => {
    const calls: unknown[] = [];
    const { runner, delivered } = makeRunner({ dispatch: readyDispatch(calls) });
    expect(await runner.run("pagerduty")).toEqual({ selected: 1, ok: 1, failed: 0 });
    expect(calls).toEqual([
      {
        method: "agents.oncall",
        params: { incidentId: "pagerduty:PA" },
        kind: "push",
        hasRunner: false,
      },
    ]);
    expect(store.get("pagerduty:PA")).toMatchObject({
      status: "ok",
      briefMarkdown: "# brief\n## Gaps\n",
      briefJson: '{"ok":true}',
    });
    expect(delivered.map((d) => d.row.incidentId)).toEqual(["pagerduty:PA"]);
  });

  test("a second run pushes nothing — dedup", async () => {
    const { runner } = makeRunner({ dispatch: readyDispatch([]) });
    await runner.run("pagerduty");
    expect(await runner.run("pagerduty")).toEqual({ selected: 0, ok: 0, failed: 0 });
  });

  test("non-pagerduty / disabled / unresolved identity / not reconciled → skipped, nothing dispatched", async () => {
    const calls: unknown[] = [];
    expect(
      (await makeRunner({ dispatch: readyDispatch(calls) }).runner.run("github")).skipped,
    ).toBe("not_pagerduty");
    expect(
      (
        await makeRunner({
          dispatch: readyDispatch(calls),
          config: DEFAULT_ONCALL_PUSH_CONFIG,
        }).runner.run("pagerduty")
      ).skipped,
    ).toBe("disabled");
    expect(
      (
        await makeRunner({
          dispatch: readyDispatch(calls),
          resolveSelf: async () => null,
        }).runner.run("pagerduty")
      ).skipped,
    ).toBe("identity_unresolved");
    store.reconcileEnabledState(false, T0);
    expect(
      (await makeRunner({ dispatch: readyDispatch(calls) }).runner.run("pagerduty")).skipped,
    ).toBe("not_reconciled");
    expect(calls).toEqual([]);
  });

  test("a SYNCHRONOUS refusal (thrown AgentsRpcError) is a failed row, not a rejection", async () => {
    const dispatch: PushDispatch = async () => {
      throw new AgentsRpcError(-32000, "incident not found");
    };
    const { runner, delivered } = makeRunner({ dispatch });
    expect(await runner.run("pagerduty")).toEqual({ selected: 1, ok: 0, failed: 1 });
    expect(store.get("pagerduty:PA")?.failureCode).toBe("refused: incident not found");
    expect(delivered[0]?.row.status).toBe("failed");
  });

  test("briefError is a failed row", async () => {
    const dispatch: PushDispatch = async (_m, _p, ctx) => {
      queueMicrotask(() => ctx.notify("oncall.briefError", { sessionId: "s1", error: "boom" }));
      return { sessionId: "s1" };
    };
    await makeRunner({ dispatch }).runner.run("pagerduty");
    expect(store.get("pagerduty:PA")?.failureCode).toBe("brief_error: boom");
  });

  test("no notification within the timeout is a failed 'timeout' row", async () => {
    const dispatch: PushDispatch = async () => ({ sessionId: "s1" });
    await makeRunner({ dispatch, timeoutMs: 20 }).runner.run("pagerduty");
    expect(store.get("pagerduty:PA")?.failureCode).toBe("timeout: no brief in 20ms");
  });

  test("a notification for ANOTHER session is ignored", async () => {
    const dispatch: PushDispatch = async (_m, _p, ctx) => {
      queueMicrotask(() =>
        ctx.notify("oncall.briefReady", { sessionId: "other", brief: "x", findings: {} }),
      );
      return { sessionId: "s1" };
    };
    await makeRunner({ dispatch, timeoutMs: 20 }).runner.run("pagerduty");
    expect(store.get("pagerduty:PA")?.status).toBe("failed");
  });

  test("a notification that arrives BEFORE dispatch returns is still matched", async () => {
    const dispatch: PushDispatch = async (_m, _p, ctx) => {
      ctx.notify("oncall.briefReady", { sessionId: "s1", brief: "early", findings: {} });
      return { sessionId: "s1" };
    };
    await makeRunner({ dispatch }).runner.run("pagerduty");
    expect(store.get("pagerduty:PA")?.briefMarkdown).toBe("early");
  });

  test("single-flight: overlapping calls collapse into ONE trailing run that sees the new incident", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const seen: unknown[] = [];
    const dispatch: PushDispatch = async (_m, params, ctx) => {
      seen.push(params);
      if (seen.length === 1) await gate;
      queueMicrotask(() =>
        ctx.notify("oncall.briefReady", { sessionId: `s${seen.length}`, brief: "b", findings: {} }),
      );
      return { sessionId: `s${seen.length}` };
    };
    const { runner } = makeRunner({ dispatch });
    const first = runner.run("pagerduty");
    seedIncident("PB"); // arrives while the first run is in flight
    const second = runner.run("pagerduty");
    const third = runner.run("pagerduty");
    release();
    await Promise.all([first, second, third]);
    expect(seen).toEqual([{ incidentId: "pagerduty:PA" }, { incidentId: "pagerduty:PB" }]);
  });

  test("retry: refused on ok and on missing; a failed row becomes ok in place", async () => {
    const failing: PushDispatch = async () => {
      throw new AgentsRpcError(-32000, "x");
    };
    await makeRunner({ dispatch: failing }).runner.run("pagerduty");
    const { runner, delivered } = makeRunner({ dispatch: readyDispatch([]), now: () => T0 + 5000 });
    await expect(runner.retry("pagerduty:NOPE")).rejects.toBeInstanceOf(PushRetryRefusedError);
    const row = await runner.retry("pagerduty:PA");
    expect(row).toMatchObject({ status: "ok", createdAt: T0, retriedAt: T0 + 5000 });
    expect(delivered).toHaveLength(1);
    await expect(runner.retry("pagerduty:PA")).rejects.toMatchObject({
      code: "ERR_ONCALL_PUSH_NOT_FAILED",
    });
  });
});
