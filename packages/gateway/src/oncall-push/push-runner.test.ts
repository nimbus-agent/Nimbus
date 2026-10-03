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
    let entered: () => void = () => {};
    const firstEntered = new Promise<void>((r) => {
      entered = r;
    });
    const seen: unknown[] = [];
    let resolveSelfCalls = 0;
    const dispatch: PushDispatch = async (_m, params, ctx) => {
      seen.push(params);
      const n = seen.length;
      if (n === 1) {
        entered();
        await gate;
      }
      queueMicrotask(() =>
        ctx.notify("oncall.briefReady", { sessionId: `s${n}`, brief: "b", findings: {} }),
      );
      return { sessionId: `s${n}` };
    };
    const { runner } = makeRunner({
      dispatch,
      resolveSelf: async () => {
        resolveSelfCalls += 1;
        return personId;
      },
    });
    const first = runner.run("pagerduty");
    await firstEntered; // the first run has selected [PA] and is blocked inside its dispatch
    seedIncident("PB"); // arrives while the first run is in flight
    const second = runner.run("pagerduty");
    const third = runner.run("pagerduty");
    release();
    await Promise.all([first, second, third]);
    expect(seen).toEqual([{ incidentId: "pagerduty:PA" }, { incidentId: "pagerduty:PB" }]);
    // One first run + exactly ONE trailing run for the two overlapping calls.
    expect(resolveSelfCalls).toBe(2);
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
  test("retry: two concurrent retries share ONE attempt — one dispatch, one delivery", async () => {
    await makeRunner({
      dispatch: async () => {
        throw new AgentsRpcError(-32000, "x");
      },
    }).runner.run("pagerduty");
    const calls: unknown[] = [];
    const { runner, delivered } = makeRunner({ dispatch: readyDispatch(calls) });
    const [a, b] = await Promise.all([runner.retry("pagerduty:PA"), runner.retry("pagerduty:PA")]);
    expect(a).toEqual(b);
    expect(a.status).toBe("ok");
    expect(calls).toHaveLength(1);
    expect(delivered).toHaveLength(1);
    // The in-flight entry is released: a later retry sees the ok row and is refused.
    await expect(runner.retry("pagerduty:PA")).rejects.toMatchObject({
      code: "ERR_ONCALL_PUSH_NOT_FAILED",
    });
  });

  test("retry: a prune that deletes the row mid-retry is a NOT_FOUND refusal, not a raw error", async () => {
    const failing: PushDispatch = async () => {
      throw new AgentsRpcError(-32000, "x");
    };
    await makeRunner({ dispatch: failing }).runner.run("pagerduty");
    expect(store.get("pagerduty:PA")?.status).toBe("failed");
    const pruning: PushDispatch = async (method, params, ctx) => {
      // Retention runs between retry's get() and applyRetry().
      store.pruneOlderThan(Number.MAX_SAFE_INTEGER);
      return readyDispatch([])(method, params, ctx);
    };
    const { runner, delivered } = makeRunner({ dispatch: pruning });
    await expect(runner.retry("pagerduty:PA")).rejects.toMatchObject({
      code: "ERR_ONCALL_PUSH_NOT_FOUND",
    });
    expect(delivered).toHaveLength(0);
  });

  test("an insert that throws on the 2nd incident still delivers the 1st row, then rejects", async () => {
    seedIncident("PB");
    class FlakyStore extends PushStore {
      private inserts = 0;
      override insert(...a: Parameters<PushStore["insert"]>): ReturnType<PushStore["insert"]> {
        this.inserts += 1;
        if (this.inserts === 2) throw new Error("disk full");
        return super.insert(...a);
      }
    }
    const flaky = new FlakyStore(db);
    const { runner, delivered } = makeRunner({ store: flaky, dispatch: readyDispatch([]) });
    await expect(runner.run("pagerduty")).rejects.toThrow("disk full");
    expect(delivered).toHaveLength(1);
    expect(store.get(delivered[0]?.row.incidentId ?? "")).not.toBeNull();
  });

  test("dispatch returning no usable sessionId is a failed 'no_session' row (null, non-object, empty string, missing key)", async () => {
    for (const bad of [null, "s1", { sessionId: "" }, { other: 1 }, { sessionId: 7 }]) {
      store.pruneOlderThan(Number.MAX_SAFE_INTEGER);
      const dispatch: PushDispatch = async () => bad;
      await makeRunner({ dispatch }).runner.run("pagerduty");
      expect(store.get("pagerduty:PA")?.failureCode).toBe(
        "no_session: agents.oncall returned no sessionId",
      );
    }
  });

  test("a briefError longer than the detail cap is clipped with an ellipsis; a missing error says unknown", async () => {
    const long: PushDispatch = async (_m, _p, ctx) => {
      queueMicrotask(() =>
        ctx.notify("oncall.briefError", { sessionId: "s1", error: "x".repeat(600) }),
      );
      return { sessionId: "s1" };
    };
    await makeRunner({ dispatch: long }).runner.run("pagerduty");
    const code = store.get("pagerduty:PA")?.failureCode ?? "";
    expect(code).toBe(`brief_error: ${"x".repeat(500)}…`);

    store.pruneOlderThan(Number.MAX_SAFE_INTEGER);
    const bare: PushDispatch = async (_m, _p, ctx) => {
      queueMicrotask(() => ctx.notify("oncall.briefError", { sessionId: "s1" }));
      return { sessionId: "s1" };
    };
    await makeRunner({ dispatch: bare }).runner.run("pagerduty");
    expect(store.get("pagerduty:PA")?.failureCode).toBe("brief_error: unknown");
  });

  test("a briefError whose error is not a string says unknown, never [object Object]", async () => {
    const dispatch: PushDispatch = async (_m, _p, ctx) => {
      queueMicrotask(() =>
        ctx.notify("oncall.briefError", { sessionId: "s1", error: { code: "E_BRIEF" } }),
      );
      return { sessionId: "s1" };
    };
    await makeRunner({ dispatch }).runner.run("pagerduty");
    expect(store.get("pagerduty:PA")?.failureCode).toBe("brief_error: unknown");
  });

  test("a briefReady with no brief/findings keys stores an empty brief and '{}' findings", async () => {
    const dispatch: PushDispatch = async (_m, _p, ctx) => {
      queueMicrotask(() => ctx.notify("oncall.briefReady", { sessionId: "s1" }));
      return { sessionId: "s1" };
    };
    await makeRunner({ dispatch }).runner.run("pagerduty");
    expect(store.get("pagerduty:PA")).toMatchObject({
      status: "ok",
      briefMarkdown: "",
      briefJson: "{}",
    });
  });

  test("an unrelated notification method for the right session is ignored; a late duplicate after settle is ignored", async () => {
    let notifyLater: () => void = () => {};
    const dispatch: PushDispatch = async (_m, _p, ctx) => {
      queueMicrotask(() => {
        ctx.notify("oncall.progress", { sessionId: "s1" });
        ctx.notify("oncall.briefReady", { sessionId: "s1", brief: "first", findings: {} });
        ctx.notify("oncall.briefReady", { sessionId: "s1", brief: "second", findings: {} });
      });
      notifyLater = () => ctx.notify("oncall.briefError", { sessionId: "s1", error: "late" });
      return { sessionId: "s1" };
    };
    await makeRunner({ dispatch }).runner.run("pagerduty");
    notifyLater();
    expect(store.get("pagerduty:PA")).toMatchObject({ status: "ok", briefMarkdown: "first" });
  });

  test("a dispatch that outlives the timeout: the timeout row has no session, and a later throw/return cannot overwrite it", async () => {
    let releaseThrow: () => void = () => {};
    const gate = new Promise<void>((r) => {
      releaseThrow = r;
    });
    let lateThrowDone: () => void = () => {};
    const lateThrowSettled = new Promise<void>((r) => {
      lateThrowDone = r;
    });
    const slowThrow: PushDispatch = async () => {
      try {
        await gate;
        throw new Error("too late");
      } finally {
        lateThrowDone();
      }
    };
    await makeRunner({ dispatch: slowThrow, timeoutMs: 15 }).runner.run("pagerduty");
    expect(store.get("pagerduty:PA")).toMatchObject({
      status: "failed",
      failureCode: "timeout: no brief in 15ms",
    });
    releaseThrow();
    await lateThrowSettled;
    await new Promise((r) => setTimeout(r, 0)); // let the runner's catch run
    expect(store.get("pagerduty:PA")?.failureCode).toBe("timeout: no brief in 15ms");
  });

  test("a non-Error throw from dispatch is stringified and clipped in a 'refused' row", async () => {
    const dispatch: PushDispatch = async () => {
      throw "y".repeat(700);
    };
    await makeRunner({ dispatch }).runner.run("pagerduty");
    expect(store.get("pagerduty:PA")?.failureCode).toBe(`refused: ${"y".repeat(500)}…`);
  });

  test("a candidate pushed by someone else mid-run is skipped, not re-inserted", async () => {
    seedIncident("PB");
    const seen: string[] = [];
    const dispatch: PushDispatch = async (_m, params, ctx) => {
      const id = (params as { incidentId: string }).incidentId;
      seen.push(id);
      if (seen.length === 1) {
        const other = id === "pagerduty:PA" ? "pagerduty:PB" : "pagerduty:PA";
        store.insert(other, { status: "failed", sessionId: null, failureCode: "x" }, T0);
      }
      queueMicrotask(() => ctx.notify("oncall.briefReady", { sessionId: "s", brief: "b" }));
      return { sessionId: "s" };
    };
    const { runner, delivered } = makeRunner({ dispatch });
    expect(await runner.run("pagerduty")).toEqual({ selected: 2, ok: 1, failed: 0 });
    expect(seen).toHaveLength(1);
    expect(delivered).toHaveLength(1);
  });

  test("retry: a failing applyRetry whose row still exists rethrows the ORIGINAL error", async () => {
    await makeRunner({
      dispatch: async () => {
        throw new AgentsRpcError(-32000, "x");
      },
    }).runner.run("pagerduty");
    class BrokenRetryStore extends PushStore {
      override applyRetry(
        ...a: Parameters<PushStore["applyRetry"]>
      ): ReturnType<PushStore["applyRetry"]> {
        void a;
        throw new Error("disk full on retry");
      }
    }
    const { runner } = makeRunner({
      store: new BrokenRetryStore(db),
      dispatch: readyDispatch([]),
    });
    await expect(runner.retry("pagerduty:PA")).rejects.toThrow("disk full on retry");
  });

  test("retry: a retried brief that fails again, or whose incident is gone from the index, is stored but NOT delivered", async () => {
    await makeRunner({
      dispatch: async () => {
        throw new AgentsRpcError(-32000, "x");
      },
    }).runner.run("pagerduty");
    const again = makeRunner({
      dispatch: async () => {
        throw new AgentsRpcError(-32000, "still broken");
      },
    });
    const failedAgain = await again.runner.retry("pagerduty:PA");
    expect(failedAgain.status).toBe("failed");
    expect(again.delivered).toHaveLength(0);

    store.insert("pagerduty:GONE", { status: "failed", sessionId: null, failureCode: "x" }, T0);
    const gone = makeRunner({ dispatch: readyDispatch([]) });
    const row = await gone.runner.retry("pagerduty:GONE");
    expect(row.status).toBe("ok");
    expect(gone.delivered).toHaveLength(0);
  });
});
