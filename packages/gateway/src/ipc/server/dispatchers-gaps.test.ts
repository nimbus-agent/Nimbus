import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { LocalIndex } from "../../index/local-index.ts";
import { createMockVault } from "../../vault/mock.ts";
import { ConsentCoordinatorImpl } from "../consent.ts";
import { createStreamRegistry } from "../engine-ask-stream.ts";
import {
  phase4RpcSkipped,
  registryRpcSkipped,
  type ServerCtx,
  trustRpcSkipped,
} from "./context.ts";
import {
  tryDispatchAuditRpc,
  tryDispatchCaptureRpc,
  tryDispatchIndexDemoSymbolRpc,
  tryDispatchNotificationsRpc,
  tryDispatchRegistryRpc,
  tryDispatchTrustRpc,
} from "./dispatchers.ts";
import { RpcMethodError } from "./rpc-error.ts";

const dbs: Database[] = [];
afterEach(() => {
  for (const d of dbs) d.close();
  dbs.length = 0;
});

function indexWithDb(): LocalIndex {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  dbs.push(db);
  return { getDatabase: () => db } as unknown as LocalIndex;
}

function makeCtx(overrides: Partial<ServerCtx["options"]> = {}): ServerCtx {
  return {
    options: { listenPath: "", vault: createMockVault(), version: "test", ...overrides },
    consentImpl: new ConsentCoordinatorImpl(() => undefined),
    startedAtMs: Date.now(),
    streamRegistry: createStreamRegistry(),
    broadcastNotification: () => {},
    getAgentInvokeHandler: () => undefined,
    getWorkflowRunHandler: () => undefined,
    getClientKind: () => "unknown",
  };
}

describe("trust.* dispatch", () => {
  test("a non-trust method is skipped", async () => {
    const out = await tryDispatchTrustRpc(makeCtx(), "registry.list");
    expect(out).toBe(trustRpcSkipped);
  });
  test("without a local index it fails with -32603", async () => {
    const err = await tryDispatchTrustRpc(makeCtx(), "trust.status").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcMethodError);
    expect((err as RpcMethodError).rpcCode).toBe(-32603);
  });
  test("trust.status answers from the store", async () => {
    const out = (await tryDispatchTrustRpc(
      makeCtx({ localIndex: indexWithDb() }),
      "trust.status",
    )) as Record<string, unknown>;
    expect(out).toHaveProperty("counts");
  });
  test("an unknown trust method is -32601", async () => {
    const err = await tryDispatchTrustRpc(
      makeCtx({ localIndex: indexWithDb() }),
      "trust.nope",
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcMethodError);
    expect((err as RpcMethodError).rpcCode).toBe(-32601);
  });
});

describe("registry.* dispatch", () => {
  test("a non-registry method is skipped, not served", async () => {
    expect(await tryDispatchRegistryRpc(makeCtx(), "c1", "trust.status", {})).toBe(
      registryRpcSkipped,
    );
  });
  test("without a local index it fails with -32603", async () => {
    const err = await tryDispatchRegistryRpc(makeCtx(), "c1", "registry.list", {}).catch(
      (e: unknown) => e,
    );
    expect((err as RpcMethodError).rpcCode).toBe(-32603);
  });
  test("an unknown registry method is -32601", async () => {
    const err = await tryDispatchRegistryRpc(
      makeCtx({ localIndex: indexWithDb() }),
      "c1",
      "registry.nope",
      {},
    ).catch((e: unknown) => e);
    expect((err as RpcMethodError).rpcCode).toBe(-32601);
  });
});

describe("skip paths", () => {
  test("notifications.* without its context is skipped", async () => {
    expect(await tryDispatchNotificationsRpc(makeCtx(), "notifications.status", {})).toBe(
      phase4RpcSkipped,
    );
    expect(await tryDispatchNotificationsRpc(makeCtx(), "other.status", {})).toBe(phase4RpcSkipped);
  });
  test("capture.* without its context is skipped", async () => {
    expect(await tryDispatchCaptureRpc(makeCtx(), "captures.list", {}, "c1")).toBe(
      phase4RpcSkipped,
    );
    expect(await tryDispatchCaptureRpc(makeCtx(), "other.list", {}, "c1")).toBe(phase4RpcSkipped);
  });
  test("an unknown audit.* method falls through to skipped", async () => {
    expect(
      await tryDispatchAuditRpc(makeCtx({ localIndex: indexWithDb() }), "audit.nope", {}),
    ).toBe(phase4RpcSkipped);
  });
  test("index.demoSymbol requires a local index", async () => {
    const err = await tryDispatchIndexDemoSymbolRpc(makeCtx(), "index.demoSymbol", {}).catch(
      (e: unknown) => e,
    );
    expect((err as RpcMethodError).rpcCode).toBe(-32603);
  });
});
