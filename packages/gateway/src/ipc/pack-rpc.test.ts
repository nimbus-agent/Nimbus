import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initLayeredConfig, resetLayeredConfigsForTests } from "../config/layered-config.ts";
import { BUNDLED_PACKS } from "../packs/bundled-packs.ts";
import type { PackDeps, PackOwnerGate } from "../packs/pack-install.ts";
import { createPackLayerStore } from "../packs/pack-layer-store.ts";
import { buildPackDeps, dispatchPackRpc } from "./pack-rpc.ts";
import { RpcMethodError } from "./server/rpc-error.ts";

let dir: string;
let deps: PackDeps;

beforeEach(() => {
  resetLayeredConfigsForTests();
  dir = mkdtempSync(join(tmpdir(), "nimbus-pack-rpc-"));
  const store = createPackLayerStore({ configDir: dir });
  initLayeredConfig(dir, { packs: store });
  deps = buildPackDeps({ store, configDir: dir, isConfigured: async () => false });
});
afterEach(() => {
  resetLayeredConfigsForTests();
  rmSync(dir, { recursive: true, force: true });
});

const approve: PackOwnerGate = async () => true;

async function rpcError(p: Promise<unknown>): Promise<RpcMethodError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof RpcMethodError) return err;
    throw err;
  }
  throw new Error("expected an RpcMethodError");
}

async function hit(method: string, params: unknown, gate?: PackOwnerGate): Promise<unknown> {
  const out = await dispatchPackRpc(method, params, deps, gate);
  if (out.kind !== "hit") throw new Error(`${method} skipped`);
  return out.value;
}

describe("buildPackDeps", () => {
  test("binds the bundled packs and the live catalog", () => {
    expect(deps.bundled).toBe(BUNDLED_PACKS);
    expect(deps.isProduction()).toBe(false);
    expect(deps.connectorIds.has("slack")).toBe(true);
    expect(deps.agentNames.has("decisions")).toBe(true);
    expect(deps.now()).toBeInstanceOf(Date);
  });
});

describe("dispatchPackRpc", () => {
  test("a method outside the four is a skip", async () => {
    expect(await dispatchPackRpc("pack.nope", {}, deps, undefined)).toEqual({ kind: "skip" });
    expect(await dispatchPackRpc("registry.list", {}, deps, undefined)).toEqual({ kind: "skip" });
  });

  const badParams: { method: string; params: unknown }[] = [
    { method: "pack.list", params: { x: 1 } },
    { method: "pack.list", params: "pm" },
    { method: "pack.show", params: {} },
    { method: "pack.show", params: [] },
    { method: "pack.show", params: { id: "" } },
    { method: "pack.show", params: { id: 7 } },
    { method: "pack.show", params: { id: "pm", fileText: "{}" } },
    { method: "pack.show", params: { fileText: "{}" } },
    { method: "pack.show", params: { fileText: "", filePath: join(tmpdir(), "p.json") } },
    { method: "pack.show", params: { fileText: "{}", filePath: "relative/p.json" } },
    { method: "pack.install", params: null },
    { method: "pack.install", params: { filePath: join(tmpdir(), "p.json") } },
    { method: "pack.remove", params: {} },
    { method: "pack.remove", params: { id: "" } },
  ];
  for (const c of badParams) {
    test(`${c.method} ${JSON.stringify(c.params)} → -32602`, async () => {
      const err = await rpcError(dispatchPackRpc(c.method, c.params, deps, approve));
      expect(err.rpcCode).toBe(-32602);
      expect(err.message.startsWith("ERR_INVALID_PARAMS: ")).toBe(true);
    });
  }

  test("pack.list routes to listPacks (null and {} both accepted)", async () => {
    const r = (await hit("pack.list", null)) as { available: { id: string }[] };
    expect(r.available.map((p) => p.id).sort()).toEqual(["devops", "pm"]);
    expect(await hit("pack.list", {})).toEqual(r);
    expect(await hit("pack.list", undefined)).toEqual(r);
  });

  test("pack.show routes to previewPack", async () => {
    const r = (await hit("pack.show", { id: "pm" })) as { mode: string; prompt: string };
    expect(r.mode).toBe("install");
    expect(r.prompt).toContain("Install role pack Product (pm)");
  });

  test("pack.install without a gate → -32603", async () => {
    const err = await rpcError(dispatchPackRpc("pack.install", { id: "pm" }, deps, undefined));
    expect(err.rpcCode).toBe(-32603);
  });

  test("pack.install routes to installPack; pack.remove then removes it", async () => {
    expect(await hit("pack.install", { id: "pm" }, approve)).toMatchObject({
      outcome: "installed",
      id: "pm",
    });
    expect(await hit("pack.remove", { id: "pm" })).toMatchObject({ removed: true });
    expect(await hit("pack.remove", { id: "pm" })).toEqual({
      removed: false,
      snapshotVersion: null,
    });
  });

  test("a PackError becomes -32000 '<code>: <detail>'", async () => {
    const err = await rpcError(dispatchPackRpc("pack.install", { id: "nope" }, deps, approve));
    expect(err.rpcCode).toBe(-32000);
    expect(err.message).toBe('ERR_PACK_NOT_FOUND: no bundled pack "nope"');
  });

  test("any other error propagates unchanged", async () => {
    const broken: PackDeps = {
      ...deps,
      isConfigured: async () => {
        throw new Error("vault locked");
      },
    };
    await expect(dispatchPackRpc("pack.show", { id: "pm" }, broken, undefined)).rejects.toThrow(
      "vault locked",
    );
  });
});
