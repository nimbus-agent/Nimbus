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

test("unknown tribal.* method is a miss", async () => {
  const out = await dispatchTribalRpc("tribal.bogus", null, makeCtx());
  expect(out.kind).toBe("miss");
});
