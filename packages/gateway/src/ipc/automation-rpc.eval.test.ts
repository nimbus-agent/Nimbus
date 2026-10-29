import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { EvalReport } from "@nimbus-dev/registry-format";

import type { ExtensionRunGrantEnv } from "../extensions/extension-run-grants.ts";
import type { InstalledEvalDeps } from "../extensions/installed-eval.ts";
import { LocalIndex } from "../index/local-index.ts";
import { MockVault } from "../vault/mock.ts";
import {
  type AutomationEvalDeps,
  AutomationRpcError,
  dispatchAutomationRpc,
} from "./automation-rpc.ts";

const dbs: Database[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

const ENV: ExtensionRunGrantEnv = {
  platform: process.platform,
  protectedRoots: [],
  runtimeReadPaths: [],
  realpath: (p) => p,
};
const REPORT = { score: 100, cases: 1, passed: 1, results: [] } as unknown as EvalReport;

type Load = NonNullable<InstalledEvalDeps["load"]>;

function fakes(calls: string[]): AutomationEvalDeps {
  const verify: NonNullable<InstalledEvalDeps["verify"]> = async (id) => ({
    extensionId: id,
    version: "1.0.0",
    serviceId: "ext_x",
    installPath: `/ext/${id}`,
    treeDigest: "t",
  });
  const load: Load = async (dir) =>
    ({
      dir,
      extensionId: dir.replace("/ext/", ""),
      version: "1.0.0",
      serviceId: "ext_x",
      entryRel: "dist/index.js",
      files: [],
      filesDigest: "f",
      suites: [{ name: "s", cases: [{}] }],
    }) as unknown as Awaited<ReturnType<Load>>;
  const run: NonNullable<InstalledEvalDeps["run"]> = async () => {
    calls.push("run");
    return REPORT;
  };
  return {
    sandboxDir: "/sb",
    runtimeReadPaths: [],
    canConfine: () => null,
    createClient: (() => {
      throw new Error("unused");
    }) as unknown as NonNullable<InstalledEvalDeps["createClient"]>,
    verify,
    load,
    run,
  };
}

type Opts = Parameters<typeof dispatchAutomationRpc>[0];

type Omittable = "ownerGate" | "runGrantEnv" | "vault" | "evalDeps";

function call(params: unknown, over: Partial<Opts> = {}, omit?: Omittable) {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  dbs.push(db);
  const opts: Opts = {
    method: "extension.eval",
    params,
    db,
    vault: new MockVault(),
    runGrantEnv: ENV,
    ownerGate: async () => true,
    evalDeps: fakes([]),
    ...over,
  };
  if (omit !== undefined) delete opts[omit];
  return dispatchAutomationRpc(opts);
}

async function code(p: Promise<unknown>): Promise<{ rpc: number; message: string }> {
  try {
    await p;
  } catch (e) {
    if (e instanceof AutomationRpcError) return { rpc: e.rpcCode, message: e.message };
    throw e;
  }
  throw new Error("expected AutomationRpcError");
}

describe("extension.eval handler", () => {
  test.each([
    ["no params", undefined],
    ["ids not an array", { ids: "a" }],
    ["empty ids", { ids: [] }],
    ["blank id", { ids: ["a", " "] }],
    ["non-string id", { ids: [1] }],
    ["51 ids", { ids: Array.from({ length: 51 }, (_, i) => `e${i}`) }],
  ])("bad params (%s) is -32602, before consent", async (_n, params) => {
    let asked = 0;
    const r = await code(
      call(params, {
        evalDeps: fakes([]),
        ownerGate: async () => {
          asked++;
          return true;
        },
      }),
    );
    expect(r.rpc).toBe(-32602);
    expect(asked).toBe(0);
  });

  test.each([
    ["no owner gate", "ownerGate"],
    ["no run-grant env", "runGrantEnv"],
    ["no vault", "vault"],
    ["no eval deps", "evalDeps"],
  ] as const)("%s is -32603", async (_n, omit) => {
    const r = await code(call({ ids: ["a"] }, {}, omit));
    expect(r.rpc).toBe(-32603);
    expect(r.message).toContain("extension.eval requires");
  });

  test("a denial is -32603 ERR_EXTENSION_EVAL_NOT_APPROVED and nothing runs", async () => {
    const calls: string[] = [];
    const r = await code(
      call({ ids: ["a.b"] }, { evalDeps: fakes(calls), ownerGate: async () => false }),
    );
    expect(r.rpc).toBe(-32603);
    expect(r.message).toContain("ERR_EXTENSION_EVAL_NOT_APPROVED");
    expect(calls).toEqual([]);
  });

  test("an approved call returns { results } in request order", async () => {
    const calls: string[] = [];
    const out = await call({ ids: [" a.b ", "c.d"] }, { evalDeps: fakes(calls) });
    const value = (out as { value: { results: Array<{ id: string; ok: boolean }> } }).value;
    expect(value.results.map((r) => [r.id, r.ok])).toEqual([
      ["a.b", true],
      ["c.d", true],
    ]);
    expect(calls).toEqual(["run", "run"]);
  });
});
