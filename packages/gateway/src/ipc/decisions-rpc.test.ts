import { describe, expect, it } from "bun:test";

import type { DecisionPassSummary } from "../decisions/decision-extract.ts";
import { type DecisionRefresher, DecisionRefresherError } from "../decisions/decision-refresh.ts";
import { DecisionsRpcError, dispatchDecisionsRpc } from "./decisions-rpc.ts";

const SUMMARY: DecisionPassSummary = {
  scanned: 1,
  discovered: 2,
  extracted: 1,
  vetoed: 0,
  upgraded: 0,
  failed: 0,
  noModel: 0,
  discoveryComplete: true,
};

function fakeRefresher(over: Partial<DecisionRefresher> = {}): DecisionRefresher {
  return {
    trigger: () => undefined,
    stop: () => undefined,
    run: () => Promise.resolve(SUMMARY),
    ...over,
  };
}

function collector() {
  const seen: Array<{ method: string; params: unknown }> = [];
  return {
    seen,
    notify: (method: string, params: unknown) => {
      seen.push({ method, params });
    },
  };
}

describe("dispatchDecisionsRpc", () => {
  it("misses on an unrelated method", async () => {
    const out = await dispatchDecisionsRpc(
      "agents.decisions",
      {},
      {
        refresher: fakeRefresher(),
        notify: () => undefined,
      },
    );
    expect(out.kind).toBe("miss");
  });

  it("decisions.refresh returns a jobId and emits passDone", async () => {
    const c = collector();
    const ctx = { refresher: fakeRefresher(), notify: c.notify };
    const out = await dispatchDecisionsRpc("decisions.refresh", {}, ctx);
    expect(out.kind).toBe("hit");
    expect((out as { value: { jobId: string } }).value.jobId).toStartWith("decisions_refresh_");
    await Bun.sleep(10);
    const done = c.seen.find((n) => n.method === "decisions.passDone");
    expect(done).toBeDefined();
    expect((done?.params as { extracted: number } | undefined)?.extracted).toBe(1);
  });

  it("decisions.rebuild returns a jobId prefixed decisions_rebuild and forwards rebuild: true", async () => {
    let sawRebuild: boolean | undefined;
    const ctx = {
      refresher: fakeRefresher({
        run: (o) => {
          sawRebuild = o?.rebuild;
          return Promise.resolve(SUMMARY);
        },
      }),
      notify: () => undefined,
    };
    const out = await dispatchDecisionsRpc("decisions.rebuild", {}, ctx);
    expect((out as { value: { jobId: string } }).value.jobId).toStartWith("decisions_rebuild_");
    await Bun.sleep(10);
    expect(sawRebuild).toBe(true);
  });

  it("decisions.refresh forwards rebuild: false", async () => {
    let sawRebuild: boolean | undefined;
    const ctx = {
      refresher: fakeRefresher({
        run: (o) => {
          sawRebuild = o?.rebuild;
          return Promise.resolve(SUMMARY);
        },
      }),
      notify: () => undefined,
    };
    await dispatchDecisionsRpc("decisions.refresh", {}, ctx);
    await Bun.sleep(10);
    expect(sawRebuild).toBe(false);
  });

  // Unlike glossary's synchronous "already running" rejection (glossary-rpc.ts — status()
  // is checked before startPass returns), DecisionRefresher has no status() probe, so
  // decisions.refresh ALWAYS returns a jobId; a concurrent-pass rejection from the
  // refresher's own single-flight guard surfaces afterwards as a passError instead.
  it("emits passError (not a synchronous rejection) when a pass is already running", async () => {
    const c = collector();
    const ctx = {
      refresher: fakeRefresher({
        run: () =>
          Promise.reject(
            new DecisionRefresherError(
              "ERR_DECISIONS_PASS_RUNNING: a decisions pass is already running",
            ),
          ),
      }),
      notify: c.notify,
    };
    const out = await dispatchDecisionsRpc("decisions.refresh", {}, ctx);
    expect(out.kind).toBe("hit");
    await Bun.sleep(10);
    const err = c.seen.find((n) => n.method === "decisions.passError");
    expect((err?.params as { code: number } | undefined)?.code).toBe(-32000);
    expect((err?.params as { message: string } | undefined)?.message).toContain(
      "ERR_DECISIONS_PASS_RUNNING",
    );
  });

  // `DecisionsRpcError` is this module's declared error contract: `ipc/server/
  // dispatchers.ts` re-throws it as `new RpcMethodError(e.rpcCode, e.message)`,
  // which needs BOTH the `instanceof Error` subclassing (for the `instanceof`
  // test to select it) and an untouched `rpcCode`/`message`.
  it("DecisionsRpcError is an Error carrying the rpc code and message verbatim", () => {
    const err = new DecisionsRpcError(-32004, "ERR_DECISIONS_X: nope");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("DecisionsRpcError");
    expect(err.message).toBe("ERR_DECISIONS_X: nope");
    expect(err.rpcCode).toBe(-32004);
  });

  it("a DecisionsRpcError from a pass reaches the wire with its own code, not -32603", async () => {
    const c = collector();
    const ctx = {
      refresher: fakeRefresher({
        run: () => Promise.reject(new DecisionsRpcError(-32004, "ERR_DECISIONS_X: nope")),
      }),
      notify: c.notify,
    };
    await dispatchDecisionsRpc("decisions.refresh", {}, ctx);
    await Bun.sleep(10);
    const err = c.seen.find((n) => n.method === "decisions.passError");
    expect((err?.params as { code: number } | undefined)?.code).toBe(-32004);
    expect((err?.params as { message: string } | undefined)?.message).toBe("ERR_DECISIONS_X: nope");
  });

  it("emits passError when the pass throws a plain error", async () => {
    const c = collector();
    const ctx = {
      refresher: fakeRefresher({
        run: () => Promise.reject(new Error("boom")),
      }),
      notify: c.notify,
    };
    await dispatchDecisionsRpc("decisions.refresh", {}, ctx);
    await Bun.sleep(10);
    const err = c.seen.find((n) => n.method === "decisions.passError");
    expect((err?.params as { message: string } | undefined)?.message).toBe("boom");
  });
});
