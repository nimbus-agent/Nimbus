import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRolePackManifestValue } from "@nimbus-dev/registry-format";
import { stripComments, stripStringLiterals } from "../../../../scripts/structure-audit/lib.ts";
import { read, readDirFiles } from "../../test/helpers/security-invariants.ts";
import { CATALOG_AGENT_NAMES } from "../catalog/agent-catalog.ts";
import { builtinCatalogConnectorIds } from "../catalog/catalog-list.ts";
import {
  getLayeredConfig,
  initLayeredConfig,
  resetLayeredConfigsForTests,
} from "../config/layered-config.ts";
import { NULL_EGRESS_SINK } from "../egress/egress-ledger.ts";
import { HITL_REQUIRED } from "../engine/executor.ts";
import { demoRefusal } from "../ipc/server/demo-gate.ts";
import { BUNDLED_PACKS } from "../packs/bundled-packs.ts";
import {
  installPack,
  type PackDeps,
  PackError,
  type PackOwnerGate,
  type PackRequest,
} from "../packs/pack-install.ts";
import { createPackLayerStore, type PackLayerStore } from "../packs/pack-layer-store.ts";

describe("I47 — a role-pack layer is written only after the owner approved pack.install over its exact text", () => {
  let dir: string;
  let store: PackLayerStore;

  beforeEach(() => {
    resetLayeredConfigsForTests();
    dir = mkdtempSync(join(tmpdir(), "nimbus-i47-"));
    store = createPackLayerStore({ configDir: dir });
    initLayeredConfig(dir, { packs: store });
  });

  afterEach(() => {
    resetLayeredConfigsForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  function packDeps(over: Partial<PackDeps> = {}): PackDeps {
    return {
      store,
      configDir: dir,
      bundled: BUNDLED_PACKS,
      isProduction: () => false,
      isConfigured: async () => false,
      connectorIds: new Set(builtinCatalogConnectorIds()),
      agentNames: new Set(CATALOG_AGENT_NAMES),
      now: () => new Date("2026-10-24T00:00:00.000Z"),
      ...over,
    };
  }

  const PM_DEFAULTS = BUNDLED_PACKS.get("pm")?.defaults ?? "";
  const packDir = (): string => join(dir, "packs", getLayeredConfig(dir).profile.name);

  /** A gate-only executor shaped as `tryDispatchPackRpc` builds one, answered by `approve`. */
  async function executorGate(approve: boolean): Promise<{
    gate: PackOwnerGate;
    prompts: string[];
    audit: string[];
  }> {
    const { NO_POLICY_OVERLAY, ToolExecutor } = await import("../engine/executor.ts");
    const prompts: string[] = [];
    const audit: string[] = [];
    const exec = new ToolExecutor(
      {
        requestApproval: async (prompt: string) => {
          prompts.push(prompt);
          return { approved: approve, answerSource: "human" as const };
        },
      },
      { recordAudit: (row: { actionJson: string }) => void audit.push(row.actionJson) },
      { dispatch: () => Promise.reject(new Error("the pack gate never dispatches")) },
      undefined,
      NULL_EGRESS_SINK,
      NO_POLICY_OVERLAY,
    );
    return {
      gate: async (action) => (await exec.gate(action)) === "proceed",
      prompts,
      audit,
    };
  }

  async function refusedBeforeTheGate(req: PackRequest, deps: PackDeps): Promise<string> {
    let asked = 0;
    const gate: PackOwnerGate = async () => {
      asked += 1;
      return true;
    };
    let code = "";
    try {
      await installPack(req, deps, gate);
    } catch (err) {
      if (!(err instanceof PackError)) throw err;
      code = err.code;
    }
    expect(asked).toBe(0);
    expect(existsSync(join(dir, "packs"))).toBe(false);
    return code;
  }

  test("pack.install is in the frozen HITL set and falls back past a delegate", async () => {
    expect(HITL_REQUIRED.has("pack.install")).toBe(true);
    const { NO_POLICY_OVERLAY, ToolExecutor } = await import("../engine/executor.ts");
    let prompts = 0;
    let remote = 0;
    const exec = new ToolExecutor(
      {
        requestApproval: async () => {
          prompts += 1;
          return { approved: false, answerSource: "human" as const };
        },
      },
      { recordAudit: () => {} },
      { dispatch: async () => ({}) },
      {
        store: { activeDelegateFor: () => true, activeDelegateePeer: () => "peer-1" },
        isOperatorValid: () => true,
        requestRemote: async () => {
          remote += 1;
          return { kind: "answered", peerId: "peer-1", approved: true };
        },
      },
      NULL_EGRESS_SINK,
      NO_POLICY_OVERLAY,
    );
    const res = await exec.execute({ type: "pack.install", payload: { packId: "pm" } });
    expect(res.status).toBe("rejected");
    expect(remote).toBe(0);
    expect(prompts).toBe(1);
  });

  test("a denied approval writes no layer, record or active.json", async () => {
    const g = await executorGate(false);
    let code = "";
    try {
      await installPack({ id: "pm" }, packDeps(), g.gate);
    } catch (err) {
      if (!(err instanceof PackError)) throw err;
      code = err.code;
    }
    expect(code).toBe("ERR_PACK_INSTALL_NOT_APPROVED");
    expect(g.prompts).toHaveLength(1);
    expect(existsSync(join(packDir(), "pm.toml"))).toBe(false);
    expect(existsSync(join(packDir(), "pm.pack.json"))).toBe(false);
    expect(existsSync(join(packDir(), "active.json"))).toBe(false);
  });

  test("the approved prompt contained the defaults text verbatim, and the audit row does not", async () => {
    expect(PM_DEFAULTS.length).toBeGreaterThan(0);
    const g = await executorGate(true);
    const r = await installPack({ id: "pm" }, packDeps(), g.gate);
    expect(r.outcome).toBe("installed");
    expect(g.prompts).toHaveLength(1);
    expect(g.prompts[0]).toContain(PM_DEFAULTS);
    // What was written is what was shown.
    expect(readFileSync(join(packDir(), "pm.toml"), "utf8")).toBe(PM_DEFAULTS);
    expect(g.audit).toHaveLength(1);
    const row = g.audit[0] ?? "";
    expect(row).toContain('"packId":"pm"');
    expect(row).not.toContain("promptText");
    expect(row).not.toContain(PM_DEFAULTS.split("\n")[0] ?? "missing");
  });

  test("a member-extension pack and a production local file are refused before the gate", async () => {
    const pm = BUNDLED_PACKS.get("pm");
    if (pm === undefined) throw new Error("premise: the bundled pm pack");
    const withMembers = parseRolePackManifestValue({ ...pm, members: ["com.example.pack"] });
    // A bundled pack with members: refused for every caller, the owner included.
    expect(
      await refusedBeforeTheGate(
        { id: "pm" },
        packDeps({ bundled: new Map([["pm", withMembers]]) }),
      ),
    ).toBe("ERR_PACK_MEMBERS_UNSUPPORTED");
    const fileText = JSON.stringify({
      schema: 1,
      id: "mine",
      name: "Mine",
      version: "1.0.0",
      description: "A local pack.",
      roles: [],
      suggestedConnectors: [],
      members: ["com.example.pack"],
      defaults: "[decisions]\nmin_confidence = 0.5\n",
    });
    const filePath = join(dir, "mine.json");
    expect(await refusedBeforeTheGate({ fileText, filePath }, packDeps())).toBe(
      "ERR_PACK_MEMBERS_UNSUPPORTED",
    );
    expect(
      await refusedBeforeTheGate({ fileText, filePath }, packDeps({ isProduction: () => true })),
    ).toBe("ERR_PACK_LOCAL_FILE_PRODUCTION");
    // The production predicate the RPC hands in is the runtime's, not a constant.
    const rpc = await read("packages/gateway/src/ipc/pack-rpc.ts");
    expect(rpc).toContain("isProduction: () => isProductionRuntime(),");
  });

  test("a renderer pack.install takes a bundled id only: the file form is refused before any read or prompt", async () => {
    const { dispatchPackRpc, buildPackDeps } = await import("../ipc/pack-rpc.ts");
    const deps = buildPackDeps({ store, configDir: dir, isConfigured: async () => false });
    let prompts = 0;
    const gate = async (): Promise<boolean> => {
      prompts += 1;
      return true;
    };
    await expect(
      dispatchPackRpc(
        "pack.install",
        { fileText: "{}", filePath: join(dir, "x.json") },
        deps,
        gate,
        true,
      ),
    ).rejects.toThrow(/^ERR_PACK_RENDERER_FILE:/);
    expect(prompts).toBe(0);
    // The kind is the connection's declared one, filled by the dispatcher — never a request field.
    const src = stripComments(
      await read("packages/gateway/src/ipc/server/dispatchers/platform-rpcs.ts"),
    );
    const fnAt = src.indexOf("export async function tryDispatchPackRpc(");
    const body = src.slice(fnAt, src.indexOf("\n}\n", fnAt));
    expect(body).toContain('ctx.getClientKind(clientId) === "ui"');
    // And the refusal runs before the request is parsed.
    const rpc = stripComments(await read("packages/gateway/src/ipc/pack-rpc.ts"));
    const dAt = rpc.indexOf("export async function dispatchPackRpc(");
    const dBody = rpc.slice(dAt);
    expect(dBody.indexOf("refuseRendererFile(")).toBeGreaterThan(-1);
    expect(dBody.indexOf("refuseRendererFile(")).toBeLessThan(dBody.indexOf("run(method"));
  });

  test("pack.install and pack.remove are demo-refused; the pack namespace is LAN-forbidden", async () => {
    for (const m of ["pack.install", "pack.remove"]) {
      expect(demoRefusal(m)?.message).toContain("ERR_DEMO_FORBIDDEN");
    }
    const { checkLanMethodAllowed } = await import("../ipc/lan-rpc.ts");
    const peer = { peerId: "peer:x", writeAllowed: true };
    for (const m of ["pack.install", "pack.remove", "pack.list", "pack.show", "pack.later"]) {
      expect(() => checkLanMethodAllowed(m, peer)).toThrow(/ERR_METHOD_NOT_ALLOWED/);
    }
  });

  test("the RPC raises pack.install through the gate-only executor, which carries NULL_EGRESS_SINK", async () => {
    const src = stripComments(
      await read("packages/gateway/src/ipc/server/dispatchers/platform-rpcs.ts"),
    );
    const fnAt = src.indexOf("export async function tryDispatchPackRpc(");
    expect(fnAt).toBeGreaterThan(-1);
    const body = src.slice(fnAt, src.indexOf("\n}\n", fnAt));
    expect(body).toContain("buildExtensionGateExecutor(ctx, localIndex, clientId)");
    expect(body).toContain('(await toolExecutor.gate(action)) === "proceed"');
    const builderSrc = stripComments(
      await read("packages/gateway/src/ipc/server/dispatchers/automation-rpcs.ts"),
    );
    const builderAt = builderSrc.indexOf("function buildExtensionGateExecutor(");
    expect(builderAt).toBeGreaterThan(-1);
    const builder = builderSrc.slice(builderAt, builderSrc.indexOf("\n}\n", builderAt));
    expect(builder).toContain("NULL_EGRESS_SINK");
    expect(builder).toContain('reject(new Error("extension gate does not dispatch to MCP"))');
  });

  test("only pack-install.ts and the store name setPackLayer/removePackLayer", async () => {
    const files = await readDirFiles("packages/gateway/src");
    const naming = files
      .filter((f) =>
        /\b(?:setPackLayer|removePackLayer)\b/.test(stripStringLiterals(stripComments(f.contents))),
      )
      .map((f) => `packages/gateway/src/${f.rel}`)
      .sort();
    expect(naming).toEqual([
      "packages/gateway/src/packs/pack-install.ts",
      "packages/gateway/src/packs/pack-layer-store.ts",
    ]);
  });
});
