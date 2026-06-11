import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { dispatchFederationRpc, type FederationRpcContext } from "./federation-rpc.ts";

function ctx(db: Database, over: Partial<FederationRpcContext> = {}): FederationRpcContext {
  return {
    db,
    consentTimeoutMs: 1000,
    notify: () => {},
    discovery: { list: async () => [] } as unknown as FederationRpcContext["discovery"],
    pairing: { listPeers: () => [] } as unknown as FederationRpcContext["pairing"],
    preflight: {
      isPeerGranted: () => true,
      resolveCommand: () => ({ command: "bun", args: ["test"], cwd: "/x", timeoutSeconds: 60 }),
      requestApproval: async () => true,
      runCommand: async () => ({ passed: true, summary: "ok", durationMs: 1 }),
      audit: () => {},
    },
    ...over,
  };
}

test("federation.preflight routes to the gate and returns ok", async () => {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 38);
  const out = await dispatchFederationRpc(
    "federation.preflight",
    { namespace: "n", ref: "HEAD", changedSurface: ["a.ts"], purpose: "x", peerId: "peer:a" },
    ctx(db),
  );
  expect(out.kind).toBe("hit");
  if (out.kind === "hit") expect(out.value).toEqual({ kind: "ok", passed: true, summary: "ok" });
});

test("federation.preflight fails closed when preflight ctx is absent", async () => {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 38);
  const c = ctx(db);
  delete (c as { preflight?: unknown }).preflight;
  await expect(
    dispatchFederationRpc(
      "federation.preflight",
      { namespace: "n", ref: "HEAD", changedSurface: [], purpose: "x", peerId: "peer:a" },
      c,
    ),
  ).rejects.toThrow();
});

test("federation.preflightRespond returns matched:false for an unknown id", async () => {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 38);
  const out = await dispatchFederationRpc(
    "federation.preflightRespond",
    { requestId: "nope", approved: true },
    ctx(db),
  );
  expect(out.kind).toBe("hit");
  if (out.kind === "hit") expect(out.value).toEqual({ matched: false });
});
