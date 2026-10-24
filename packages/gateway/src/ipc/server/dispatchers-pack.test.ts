/**
 * `tryDispatchPackRpc` — the seam between the socket and `pack.*`: the skip sentinel by identity,
 * the not-wired refusal, and `pack.install` raised through the gate-only executor on the CALLING
 * client's consent channel (approve writes, deny writes nothing). No `mock.module`: the ctx is
 * built by hand and the consent coordinator answers for the owner.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSeededInMemoryDb } from "../../../test/helpers/migrated-db-seed.ts";
import { initLayeredConfig, resetLayeredConfigsForTests } from "../../config/layered-config.ts";
import { CURRENT_SCHEMA_VERSION, LocalIndex } from "../../index/local-index.ts";
import { createPackLayerStore, type PackLayerStore } from "../../packs/pack-layer-store.ts";
import { createMockVault } from "../../vault/mock.ts";
import { ConsentCoordinatorImpl } from "../consent.ts";
import { createStreamRegistry } from "../engine-ask-stream.ts";
import { packRpcSkipped, type ServerCtx } from "./context.ts";
import { tryDispatchPackRpc } from "./dispatchers.ts";
import type { CreateIpcServerOptions } from "./options.ts";
import { RpcMethodError } from "./rpc-error.ts";

let dir: string;
let store: PackLayerStore;
const openDbs: Database[] = [];

beforeEach(() => {
  resetLayeredConfigsForTests();
  dir = mkdtempSync(join(tmpdir(), "nimbus-disp-pack-"));
  store = createPackLayerStore({ configDir: dir });
  initLayeredConfig(dir, { packs: store });
});
afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
  resetLayeredConfigsForTests();
  rmSync(dir, { recursive: true, force: true });
});

function freshIndex(): LocalIndex {
  const db = openSeededInMemoryDb(CURRENT_SCHEMA_VERSION);
  openDbs.push(db);
  return new LocalIndex(db);
}

/** The owner answers every consent request to the calling client; `prompts` records them. */
function consent(approved: boolean, prompts: string[]): ConsentCoordinatorImpl {
  const impl: ConsentCoordinatorImpl = new ConsentCoordinatorImpl((clientId) => (notification) => {
    const params = notification.params as Record<string, unknown> | undefined;
    const requestId = params?.["requestId"];
    if (typeof requestId !== "string") throw new Error("consent.request without a requestId");
    prompts.push(`${clientId}:${String(params?.["prompt"])}`);
    queueMicrotask(() => impl.handleRespond(clientId, { requestId, approved }));
  });
  return impl;
}

function ctxWith(
  overrides: Partial<CreateIpcServerOptions>,
  consentImpl = new ConsentCoordinatorImpl(() => undefined),
): ServerCtx {
  return {
    options: { listenPath: "", vault: createMockVault(), version: "test", ...overrides },
    consentImpl,
    startedAtMs: Date.now(),
    streamRegistry: createStreamRegistry(),
    broadcastNotification: () => {},
    getAgentInvokeHandler: () => undefined,
    getWorkflowRunHandler: () => undefined,
    getClientKind: () => "cli",
  };
}

async function rpcError(p: Promise<unknown>): Promise<RpcMethodError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof RpcMethodError) return err;
    throw err;
  }
  throw new Error("expected an RpcMethodError");
}

describe("tryDispatchPackRpc", () => {
  test("a non-pack method is skipped without reading the store", async () => {
    const ctx = ctxWith({});
    Object.defineProperty(ctx.options, "packLayerStore", {
      get(): never {
        throw new Error("packLayerStore must not be read for a non-pack method");
      },
    });
    expect(await tryDispatchPackRpc(ctx, "c1", "registry.list", {})).toBe(packRpcSkipped);
  });

  test("no store or no configDir → -32603", async () => {
    expect(
      (await rpcError(tryDispatchPackRpc(ctxWith({ configDir: dir }), "c1", "pack.list", null)))
        .rpcCode,
    ).toBe(-32603);
    expect(
      (
        await rpcError(
          tryDispatchPackRpc(ctxWith({ packLayerStore: store }), "c1", "pack.list", null),
        )
      ).rpcCode,
    ).toBe(-32603);
  });

  test("pack.list answers; an unknown pack.* method is -32601", async () => {
    const ctx = ctxWith({ packLayerStore: store, configDir: dir });
    const r = (await tryDispatchPackRpc(ctx, "c1", "pack.list", null)) as { available: unknown[] };
    expect(r.available).toHaveLength(2);
    expect((await rpcError(tryDispatchPackRpc(ctx, "c1", "pack.nope", {}))).rpcCode).toBe(-32601);
  });

  test("pack.install without a local index has no gate → -32603", async () => {
    const ctx = ctxWith({ packLayerStore: store, configDir: dir });
    const err = await rpcError(tryDispatchPackRpc(ctx, "c1", "pack.install", { id: "pm" }));
    expect(err.rpcCode).toBe(-32603);
  });

  test("pack.install asks the calling client and writes on approval", async () => {
    const prompts: string[] = [];
    const ctx = ctxWith(
      { packLayerStore: store, configDir: dir, localIndex: freshIndex() },
      consent(true, prompts),
    );
    const r = await tryDispatchPackRpc(ctx, "c7", "pack.install", { id: "pm" });
    expect(r).toMatchObject({ outcome: "installed", id: "pm" });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toStartWith("c7:");
    expect(prompts[0]).toContain("Install role pack Product (pm)");
    expect(existsSync(join(dir, "packs", "default", "pm.toml"))).toBe(true);
  });

  test("a denied pack.install writes nothing and returns the not-approved code", async () => {
    const ctx = ctxWith(
      { packLayerStore: store, configDir: dir, localIndex: freshIndex() },
      consent(false, []),
    );
    const err = await rpcError(tryDispatchPackRpc(ctx, "c1", "pack.install", { id: "pm" }));
    expect(err.rpcCode).toBe(-32000);
    expect(err.message).toStartWith("ERR_PACK_INSTALL_NOT_APPROVED: ");
    expect(existsSync(join(dir, "packs"))).toBe(false);
  });
});
