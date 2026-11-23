import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { LocalIndex } from "../../../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../../../index/migrations/runner.ts";
import { phase4RpcSkipped, type ServerCtx } from "../context.ts";
import { RpcMethodError } from "../rpc-error.ts";
import { tryDispatchSchedulingRpc } from "./scheduling-rpcs.ts";

const indexes: LocalIndex[] = [];
afterEach(() => {
  for (const i of indexes.splice(0)) i.close();
});

function ctx(opts: { booted: boolean; kind: string }): ServerCtx {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, LocalIndex.SCHEMA_VERSION);
  const index = new LocalIndex(db);
  indexes.push(index);
  return {
    options: {
      localIndex: index,
      ...(opts.booted ? { federationPairing: {} } : {}),
    },
    getClientKind: () => opts.kind,
  } as unknown as ServerCtx;
}

test("another namespace is skipped", async () => {
  expect(
    await tryDispatchSchedulingRpc(
      ctx({ booted: true, kind: "cli" }),
      "federation.peers",
      {},
      "c1",
    ),
  ).toBe(phase4RpcSkipped);
});

test("without a booted federation the namespace is skipped, not served", async () => {
  expect(
    await tryDispatchSchedulingRpc(ctx({ booted: false, kind: "cli" }), "scheduling.ask", {}, "c1"),
  ).toBe(phase4RpcSkipped);
});

test("the connection's declared kind decides, and an error becomes an RPC error", async () => {
  const refused = await tryDispatchSchedulingRpc(
    ctx({ booted: true, kind: "mcp" }),
    "scheduling.respond",
    { requestId: "x" },
    "c1",
  ).catch((e: unknown) => e);
  expect(refused).toBeInstanceOf(RpcMethodError);
  expect((refused as RpcMethodError).message).toMatch(/FORBIDDEN_CLIENT/);
  expect(
    await tryDispatchSchedulingRpc(
      ctx({ booted: true, kind: "cli" }),
      "scheduling.respond",
      { requestId: "nope", approved: true, answerSource: "human" },
      "c1",
    ),
  ).toEqual({ matched: false });
});

test("an unknown scheduling method is skipped", async () => {
  expect(
    await tryDispatchSchedulingRpc(
      ctx({ booted: true, kind: "cli" }),
      "scheduling.other",
      {},
      "c1",
    ),
  ).toBe(phase4RpcSkipped);
});
