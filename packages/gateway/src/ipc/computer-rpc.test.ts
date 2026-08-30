import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  CuActionConsentBroker,
  CuEnvelopeConsentBroker,
} from "../computer-use/cu-consent-broker.ts";
import type { CuGateDeps } from "../computer-use/cu-gate.ts";
import { DEFAULT_NIMBUS_COMPUTER_USE_TOML } from "../config/nimbus-toml.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import type { SandboxRunner } from "../platform/sandbox/sandbox-runner.ts";
import { type ComputerRpcCtx, dispatchComputerRpc } from "./computer-rpc.ts";

const brokers: Array<CuEnvelopeConsentBroker | CuActionConsentBroker> = [];
// Pending approvals hold live TTL timers; without this, a test that leaves one pending hangs
// `bun test` teardown on Windows.
afterEach(() => {
  for (const b of brokers.splice(0)) b.clear();
});

const inertRunner: Pick<SandboxRunner, "canConfine"> = {
  canConfine: () => null,
};

function makeCtx(over: Partial<CuGateDeps> = {}): ComputerRpcCtx {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 57);
  const envelopeConsent = new CuEnvelopeConsentBroker();
  const actionConsent = new CuActionConsentBroker();
  brokers.push(envelopeConsent, actionConsent);
  return {
    envelopeConsent,
    actionConsent,
    gateDeps: {
      config: { ...DEFAULT_NIMBUS_COMPUTER_USE_TOML, enabled: true, allowedLanes: ["browser"] },
      enforced: { capabilitiesDisabled: new Set<string>() },
      runner: inertRunner,
      resolveBrowserPath: () => null,
      openLane: () => {
        throw new Error("openLane should not be reached in these tests");
      },
      db,
      now: () => 1_700_000_000_000,
      newId: () => "s1",
      requestApproval: (input) =>
        "seq" in input
          ? actionConsent.request(input, 5_000)
          : envelopeConsent.request(input, 5_000),
      ...over,
    },
  };
}

describe("computer RPC", () => {
  test("an unknown computer.* method MISSES rather than throwing", async () => {
    const out = await dispatchComputerRpc("computer.nope", {}, makeCtx());
    expect(out.kind).toBe("miss");
  });

  test('computer.sessionOpen requires lane to be exactly "browser"', async () => {
    await expect(
      dispatchComputerRpc("computer.sessionOpen", { lane: "terminal" }, makeCtx()),
    ).rejects.toThrow();
    await expect(dispatchComputerRpc("computer.sessionOpen", {}, makeCtx())).rejects.toThrow();
  });

  test("computer.sessionOpen refuses (no browser) rather than throwing once params are valid", async () => {
    const out = await dispatchComputerRpc(
      "computer.sessionOpen",
      { lane: "browser", navigateOrigins: ["https://example.com"], scriptOrigins: [] },
      makeCtx(),
    );
    expect(out.kind).toBe("hit");
    if (out.kind !== "hit") throw new Error("unreachable");
    expect((out.value as { status: string }).status).toBe("refused");
    expect((out.value as { status: string; code?: string }).code).toBe("ERR_CU_NO_BROWSER");
  });

  test("a malformed navigateOrigins array yields an EMPTY list, never a partial one", async () => {
    const ctx = makeCtx();
    let seenReq: unknown;
    const capturingCtx: ComputerRpcCtx = {
      ...ctx,
      gateDeps: {
        ...ctx.gateDeps,
        resolveBrowserPath: () => "/fake/chrome",
        requestApproval: async (input) => {
          seenReq = input;
          return false;
        },
      },
    };
    await dispatchComputerRpc(
      "computer.sessionOpen",
      { lane: "browser", navigateOrigins: ["https://example.com", 42], scriptOrigins: [] },
      capturingCtx,
    );
    expect((seenReq as { navigateOrigins: string[] }).navigateOrigins).toEqual([]);
  });

  test("computer.sessionClose requires a sessionId", async () => {
    await expect(dispatchComputerRpc("computer.sessionClose", {}, makeCtx())).rejects.toThrow();
  });

  test("computer.sessionClose reports not_found for an unknown id", async () => {
    const out = await dispatchComputerRpc(
      "computer.sessionClose",
      { sessionId: "nope" },
      makeCtx(),
    );
    if (out.kind !== "hit") throw new Error("unreachable");
    expect((out.value as { status: string }).status).toBe("not_found");
  });

  test("computer.act rejects an unrecognised kind BEFORE any session work happens", async () => {
    // No session was ever opened. If `kind` were validated AFTER session lookup, the gate itself
    // would throw `ERR_CU_NO_SESSION` (a `CuGateError`, not a `ComputerRpcError`) -- so asserting
    // the specific RPC-layer error class proves the ordering, not merely that SOMETHING threw.
    const { ComputerRpcError } = await import("./computer-rpc.ts");
    let caught: unknown;
    try {
      await dispatchComputerRpc(
        "computer.act",
        { sessionId: "does-not-exist", kind: "explode" },
        makeCtx(),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ComputerRpcError);
  });

  test("computer.act requires a sessionId", async () => {
    await expect(
      dispatchComputerRpc("computer.act", { kind: "click" }, makeCtx()),
    ).rejects.toThrow();
  });

  test("computer.sessionStatus returns an empty list for an unknown session and when the store is empty", async () => {
    const ctx = makeCtx();
    const empty = await dispatchComputerRpc("computer.sessionStatus", {}, ctx);
    if (empty.kind !== "hit") throw new Error("unreachable");
    expect((empty.value as { sessions: unknown[] }).sessions).toEqual([]);

    const missing = await dispatchComputerRpc("computer.sessionStatus", { sessionId: "nope" }, ctx);
    if (missing.kind !== "hit") throw new Error("unreachable");
    expect((missing.value as { sessions: unknown[] }).sessions).toEqual([]);
  });

  test("computer.approvalRespond resolves the pending envelope approval the broker broadcast", async () => {
    const ctx = makeCtx();
    const broadcasts: Array<Record<string, unknown>> = [];
    ctx.envelopeConsent.setBroadcast((_m, params) => {
      broadcasts.push(params as Record<string, unknown>);
    });
    const runCtx: ComputerRpcCtx = {
      ...ctx,
      gateDeps: { ...ctx.gateDeps, resolveBrowserPath: () => "/fake/chrome" },
    };
    const run = dispatchComputerRpc(
      "computer.sessionOpen",
      { lane: "browser", navigateOrigins: ["https://example.com"], scriptOrigins: [] },
      runCtx,
    );
    await Bun.sleep(1);
    const requestId = broadcasts[0]?.["requestId"] as string;
    expect(typeof requestId).toBe("string");

    const resp = await dispatchComputerRpc(
      "computer.approvalRespond",
      { requestId, approved: false },
      ctx,
    );
    if (resp.kind !== "hit") throw new Error("unreachable");
    expect((resp.value as { matched: boolean }).matched).toBe(true);

    const out = await run;
    if (out.kind !== "hit") throw new Error("unreachable");
    expect((out.value as { status: string }).status).toBe("denied");
  });

  test("computer.approvalRespond reports no match for an unknown requestId on either broker", async () => {
    const out = await dispatchComputerRpc(
      "computer.approvalRespond",
      { requestId: "nope", approved: true },
      makeCtx(),
    );
    if (out.kind !== "hit") throw new Error("unreachable");
    expect((out.value as { matched: boolean }).matched).toBe(false);
  });

  test("approved defaults to FALSE (denial) when the field is absent", async () => {
    const ctx = makeCtx();
    const broadcasts: Array<Record<string, unknown>> = [];
    ctx.envelopeConsent.setBroadcast((_m, params) => {
      broadcasts.push(params as Record<string, unknown>);
    });
    const runCtx: ComputerRpcCtx = {
      ...ctx,
      gateDeps: { ...ctx.gateDeps, resolveBrowserPath: () => "/fake/chrome" },
    };
    const run = dispatchComputerRpc(
      "computer.sessionOpen",
      { lane: "browser", navigateOrigins: ["https://example.com"], scriptOrigins: [] },
      runCtx,
    );
    await Bun.sleep(1);
    const requestId = broadcasts[0]?.["requestId"] as string;
    await dispatchComputerRpc("computer.approvalRespond", { requestId }, ctx);
    const out = await run;
    if (out.kind !== "hit") throw new Error("unreachable");
    expect((out.value as { status: string }).status).toBe("denied");
  });

  test("approved defaults to FALSE (denial) when the field is a non-boolean truthy value", async () => {
    const ctx = makeCtx();
    const broadcasts: Array<Record<string, unknown>> = [];
    ctx.envelopeConsent.setBroadcast((_m, params) => {
      broadcasts.push(params as Record<string, unknown>);
    });
    const runCtx: ComputerRpcCtx = {
      ...ctx,
      gateDeps: { ...ctx.gateDeps, resolveBrowserPath: () => "/fake/chrome" },
    };
    const run = dispatchComputerRpc(
      "computer.sessionOpen",
      { lane: "browser", navigateOrigins: ["https://example.com"], scriptOrigins: [] },
      runCtx,
    );
    await Bun.sleep(1);
    const requestId = broadcasts[0]?.["requestId"] as string;
    await dispatchComputerRpc("computer.approvalRespond", { requestId, approved: "yes" }, ctx);
    const out = await run;
    if (out.kind !== "hit") throw new Error("unreachable");
    expect((out.value as { status: string }).status).toBe("denied");
  });
});
