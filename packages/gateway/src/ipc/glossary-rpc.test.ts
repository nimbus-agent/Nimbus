import { describe, expect, it } from "bun:test";

import type { GlossaryPassSummary } from "../glossary/glossary-extract.ts";
import { type GlossaryRefresher, GlossaryRefresherError } from "../glossary/glossary-refresh.ts";
import { dispatchGlossaryRpc, GlossaryRpcError } from "./glossary-rpc.ts";

const SUMMARY: GlossaryPassSummary = {
  scanned: 1,
  discovered: 2,
  demoted: 0,
  consolidated: 3,
  upgraded: 1,
  vetoed: 0,
  upgradesVetoed: 0,
  vetoedTerms: [],
  retried: 0,
  llmConfigured: true,
  llmProduced: true,
  aborted: false,
};

function fakeRefresher(over: Partial<GlossaryRefresher> = {}): GlossaryRefresher {
  return {
    trigger: () => undefined,
    stop: () => undefined,
    status: () => "idle",
    runNow: () => Promise.resolve(SUMMARY),
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

describe("dispatchGlossaryRpc", () => {
  it("misses on an unrelated method", async () => {
    const out = await dispatchGlossaryRpc(
      "agents.glossary",
      {},
      {
        refresher: fakeRefresher(),
        notify: () => undefined,
      },
    );
    expect(out.kind).toBe("miss");
  });

  it("glossary.refresh returns a jobId and emits passDone", async () => {
    const c = collector();
    const ctx = { refresher: fakeRefresher(), notify: c.notify };
    const out = await dispatchGlossaryRpc("glossary.refresh", {}, ctx);
    expect(out.kind).toBe("hit");
    expect((out as { value: { jobId: string } }).value.jobId).toStartWith("glossary_refresh_");
    await Bun.sleep(10);
    const done = c.seen.find((n) => n.method === "glossary.passDone");
    expect(done).toBeDefined();
    expect((done?.params as { upgraded: number } | undefined)?.upgraded).toBe(1);
  });

  it("glossary.rebuild forwards rebuild: true", async () => {
    let sawRebuild: boolean | undefined;
    const ctx = {
      refresher: fakeRefresher({
        runNow: (o) => {
          sawRebuild = o.rebuild;
          return Promise.resolve(SUMMARY);
        },
      }),
      notify: () => undefined,
    };
    await dispatchGlossaryRpc("glossary.rebuild", {}, ctx);
    await Bun.sleep(10);
    expect(sawRebuild).toBe(true);
  });

  it("glossary.refresh forwards rebuild: false", async () => {
    let sawRebuild: boolean | undefined;
    const ctx = {
      refresher: fakeRefresher({
        runNow: (o) => {
          sawRebuild = o.rebuild;
          return Promise.resolve(SUMMARY);
        },
      }),
      notify: () => undefined,
    };
    await dispatchGlossaryRpc("glossary.refresh", {}, ctx);
    await Bun.sleep(10);
    expect(sawRebuild).toBe(false);
  });

  // A concurrent request must be an immediate RPC ERROR, not a jobId whose
  // passError arrives later — the caller would otherwise think it started.
  it("rejects synchronously when a pass is already running", async () => {
    const ctx = { refresher: fakeRefresher({ status: () => "running" }), notify: () => undefined };
    await expect(dispatchGlossaryRpc("glossary.refresh", {}, ctx)).rejects.toThrow(
      "ERR_GLOSSARY_PASS_RUNNING",
    );
  });

  it("rejects when the glossary is disabled", async () => {
    const ctx = { refresher: fakeRefresher({ status: () => "disabled" }), notify: () => undefined };
    await expect(dispatchGlossaryRpc("glossary.refresh", {}, ctx)).rejects.toBeInstanceOf(
      GlossaryRpcError,
    );
  });

  // Reachable shutdown state: GlossaryRefresher.status() returns "stopped" after
  // stop() runs (glossary-refresh.ts). A write-class RPC must fail closed here too,
  // not merely for "running"/"disabled" — a copy-paste or inverted-comparison bug in
  // this specific branch would not be caught by the other two branches' tests.
  it("rejects when the gateway is shutting down (status stopped)", async () => {
    const ctx = { refresher: fakeRefresher({ status: () => "stopped" }), notify: () => undefined };
    await expect(dispatchGlossaryRpc("glossary.refresh", {}, ctx)).rejects.toThrow(
      "ERR_GLOSSARY_STOPPED",
    );
  });

  it("emits passError when the pass throws", async () => {
    const c = collector();
    const ctx = {
      refresher: fakeRefresher({
        runNow: () => Promise.reject(new GlossaryRefresherError("ERR_BOOM: nope")),
      }),
      notify: c.notify,
    };
    await dispatchGlossaryRpc("glossary.refresh", {}, ctx);
    await Bun.sleep(10);
    const err = c.seen.find((n) => n.method === "glossary.passError");
    expect((err?.params as { code: number } | undefined)?.code).toBe(-32000);
  });
});
