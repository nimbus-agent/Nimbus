import { expect, test } from "bun:test";
import { dispatchTribalRpc, type TribalRpcCtx } from "./tribal-rpc.ts";

function makeCtx(over: Partial<TribalRpcCtx> = {}): TribalRpcCtx {
  return {
    status: () => ({ enabled: true, clusters: 2 }),
    start: async () => {},
    stop: async () => {},
    list: (status) => [{ clusterId: "k1", status: status ?? "all" }],
    dismiss: async () => {},
    scan: async () => ({ scanned: 5, fired: 1 }),
    capture: async (clusterId, target) => ({
      ok: true,
      pageRef: `${target ?? "notion"}:${clusterId}`,
    }),
    ...over,
  };
}

test("tribal.status returns the ctx status", async () => {
  const out = await dispatchTribalRpc("tribal.status", null, makeCtx());
  expect(out).toEqual({ kind: "hit", value: { enabled: true, clusters: 2 } });
});

test("tribal.list passes the optional status filter", async () => {
  const out = await dispatchTribalRpc("tribal.list", { status: "suggested" }, makeCtx());
  expect(out).toEqual({ kind: "hit", value: [{ clusterId: "k1", status: "suggested" }] });
});

test("tribal.dismiss requires a clusterId", async () => {
  await expect(dispatchTribalRpc("tribal.dismiss", {}, makeCtx())).rejects.toThrow(/clusterId/);
});

test("tribal.dismiss calls ctx.dismiss with the clusterId", async () => {
  const dismissed: string[] = [];
  const out = await dispatchTribalRpc(
    "tribal.dismiss",
    { clusterId: "k9" },
    makeCtx({ dismiss: async (id) => void dismissed.push(id) }),
  );
  expect(out).toEqual({ kind: "hit", value: { ok: true } });
  expect(dismissed).toEqual(["k9"]);
});

test("tribal.scan returns the scan summary", async () => {
  const out = await dispatchTribalRpc("tribal.scan", null, makeCtx());
  expect(out).toEqual({ kind: "hit", value: { scanned: 5, fired: 1 } });
});

test("tribal.start / tribal.stop return ok", async () => {
  expect(await dispatchTribalRpc("tribal.start", null, makeCtx())).toEqual({
    kind: "hit",
    value: { ok: true },
  });
  expect(await dispatchTribalRpc("tribal.stop", null, makeCtx())).toEqual({
    kind: "hit",
    value: { ok: true },
  });
});

test("tribal.capture is NOT in the pure dispatcher (handled in the dispatcher with per-call HITL)", async () => {
  // capture needs a per-call consent channel → it is special-cased in tryDispatchTribalRpc, not here.
  const out = await dispatchTribalRpc("tribal.capture", { clusterId: "k1" }, makeCtx());
  expect(out.kind).toBe("miss");
});

test("unknown tribal.* method is a miss", async () => {
  const out = await dispatchTribalRpc("tribal.bogus", null, makeCtx());
  expect(out.kind).toBe("miss");
});

test("tribal.dismiss rejects a non-object params payload (requireString guard)", async () => {
  // A non-object (string) params hits the `rec === null || typeof rec !== "object"` arm of
  // requireString — the value reads as undefined → ERR_INVALID_PARAMS.
  await expect(dispatchTribalRpc("tribal.dismiss", "not-an-object", makeCtx())).rejects.toThrow(
    /clusterId/,
  );
  // A null params hits the same guard via the `rec === null` side.
  await expect(dispatchTribalRpc("tribal.dismiss", null, makeCtx())).rejects.toThrow(/clusterId/);
});

test("tribal.list tolerates a non-object params payload (optionalString guard → undefined)", async () => {
  // optionalString returns undefined for a non-object payload, so list() runs with no filter.
  const seen: (string | undefined)[] = [];
  const out = await dispatchTribalRpc(
    "tribal.list",
    "not-an-object",
    makeCtx({
      list: (status) => {
        seen.push(status);
        return [];
      },
    }),
  );
  expect(out).toEqual({ kind: "hit", value: [] });
  expect(seen).toEqual([undefined]);
});

test("tribal.list ignores a non-string status value (optionalString typeof guard)", async () => {
  const seen: (string | undefined)[] = [];
  await dispatchTribalRpc(
    "tribal.list",
    { status: 42 },
    makeCtx({
      list: (status) => {
        seen.push(status);
        return [];
      },
    }),
  );
  expect(seen).toEqual([undefined]);
});
