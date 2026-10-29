import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvalReport } from "@nimbus-dev/registry-format";

import type { ServerSpec } from "../connectors/lazy-mesh/slot.ts";
import { LocalIndex } from "../index/local-index.ts";
import { MockVault } from "../vault/mock.ts";
import type { EvalMcpClient } from "./eval/eval-runtime.ts";
import { type EvalPackageSource, EvalRunError } from "./eval/eval-source.ts";
import type { ExtensionRunGrantEnv } from "./extension-run-grants.ts";
import { signatureDisabledRegistry } from "./hard-disable.ts";
import { installExtensionFromLocalDirectory } from "./install-from-local.ts";
import {
  EvalApprovalDenied,
  evaluateInstalledExtensions,
  type InstalledEvalDeps,
} from "./installed-eval.ts";
import { ExtensionRunGrantError } from "./run-grant-error.ts";
import { getRunGrant } from "./run-grant-store.ts";
import type { VerifiedExtensionForEval } from "./verified-extension.ts";
import { encodeBase64, generateEd25519Keypair, signManifest } from "./verify-signature.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
  signatureDisabledRegistry.reset();
});

const ENV: ExtensionRunGrantEnv = {
  platform: process.platform,
  protectedRoots: [],
  runtimeReadPaths: [],
  realpath: (p) => p,
};

const REPORT = { score: 100, cases: 1, passed: 1, results: [] } as unknown as EvalReport;

/** Everything the fakes did, in order: `load:<id>`, `verify:<id>`, `gate`, `run:<id>`. */
interface Recorder {
  calls: string[];
  gatePayloads: Array<{ type: string; payload: Record<string, unknown> }>;
}

interface FakeOpts {
  /** per id: throw from verify on the Nth call (1-based) */
  verifyThrows?: Record<string, { call: number; error: unknown }>;
  /** per id: the tree digest verify reports on the Nth call (default `tree-<id>`) */
  digestOnCall?: Record<string, { call: number; digest: string }>;
  loadThrows?: Record<string, unknown>;
  runThrows?: Record<string, unknown>;
  approve?: boolean;
}

function fakeDeps(opts: FakeOpts = {}): { deps: InstalledEvalDeps; rec: Recorder } {
  const rec: Recorder = { calls: [], gatePayloads: [] };
  const verifyCalls = new Map<string, number>();
  const verify: InstalledEvalDeps["verify"] = async (id) => {
    rec.calls.push(`verify:${id}`);
    const n = (verifyCalls.get(id) ?? 0) + 1;
    verifyCalls.set(id, n);
    const t = opts.verifyThrows?.[id];
    if (t !== undefined && t.call === n) throw t.error;
    const d = opts.digestOnCall?.[id];
    const treeDigest = d !== undefined && d.call === n ? d.digest : `tree-${id}`;
    const v: VerifiedExtensionForEval = {
      extensionId: id,
      version: "1.0.0",
      installPath: `/ext/${id}`,
      treeDigest,
    };
    return v;
  };
  const load: InstalledEvalDeps["load"] = async (dir) => {
    const id = dir.replace("/ext/", "");
    rec.calls.push(`load:${id}`);
    const err = opts.loadThrows?.[id];
    if (err !== undefined) throw err;
    return {
      dir,
      extensionId: id,
      version: "1.0.0",
      serviceId: `ext_${id.replaceAll(".", "_")}`,
      entryRel: "dist/index.js",
      files: ["dist/index.js"],
      filesDigest: `files-${id}`,
      suites: [
        { file: "evals/a.eval.json", name: "a", cases: [{}, {}] },
        { file: "evals/b.eval.json", name: "b", cases: [{}] },
      ],
    } as unknown as EvalPackageSource;
  };
  const run: InstalledEvalDeps["run"] = async (src) => {
    rec.calls.push(`run:${src.extensionId}`);
    const err = opts.runThrows?.[src.extensionId];
    if (err !== undefined) throw err;
    return REPORT;
  };
  const deps: InstalledEvalDeps = {
    db: new Database(":memory:"),
    vault: new MockVault(),
    env: ENV,
    sandboxDir: "/sandbox",
    runtimeReadPaths: [],
    canConfine: () => null,
    createClient: () => {
      throw new Error("no client in a fake run");
    },
    ownerGate: async (action) => {
      rec.calls.push("gate");
      rec.gatePayloads.push(action);
      return opts.approve ?? true;
    },
    verify,
    load,
    run,
  };
  cleanups.push(() => deps.db.close());
  return { deps, rec };
}

describe("evaluateInstalledExtensions (fakes)", () => {
  test("ONE extension.eval approval lists every prepared id once, then each is evaluated", async () => {
    const { deps, rec } = fakeDeps();
    const results = await evaluateInstalledExtensions(["a.x", "b.y"], deps);
    expect(rec.gatePayloads).toEqual([
      {
        type: "extension.eval",
        payload: {
          extensions: [
            { id: "a.x", version: "1.0.0", cases: 3 },
            { id: "b.y", version: "1.0.0", cases: 3 },
          ],
        },
      },
    ]);
    expect(results).toEqual([
      { id: "a.x", version: "1.0.0", ok: true, report: REPORT },
      { id: "b.y", version: "1.0.0", ok: true, report: REPORT },
    ]);
  });

  test("the order is: every pre-consent check, the gate, then per id load -> verify -> run", async () => {
    const { deps, rec } = fakeDeps();
    await evaluateInstalledExtensions(["a.x", "b.y"], deps);
    expect(rec.calls).toEqual([
      "verify:a.x",
      "load:a.x",
      "verify:b.y",
      "load:b.y",
      "gate",
      "load:a.x",
      "verify:a.x",
      "run:a.x",
      "load:b.y",
      "verify:b.y",
      "run:b.y",
    ]);
  });

  test("a denial throws ERR_EXTENSION_EVAL_NOT_APPROVED and runs nothing", async () => {
    const { deps, rec } = fakeDeps({ approve: false });
    const err = await evaluateInstalledExtensions(["a.x"], deps).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(EvalApprovalDenied);
    expect((err as EvalApprovalDenied).code).toBe("ERR_EXTENSION_EVAL_NOT_APPROVED");
    expect(rec.calls.filter((c) => c.startsWith("run:"))).toEqual([]);
    expect(rec.calls.at(-1)).toBe("gate");
  });

  test("a gate that throws: the error propagates unchanged and nothing runs", async () => {
    const { deps, rec } = fakeDeps();
    const boom = new Error("consent channel closed");
    const err = await evaluateInstalledExtensions(["a.x", "b.y"], {
      ...deps,
      ownerGate: async () => {
        rec.calls.push("gate");
        throw boom;
      },
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBe(boom);
    expect(rec.calls.filter((c) => c.startsWith("run:"))).toHaveLength(0);
    expect(rec.calls.at(-1)).toBe("gate");
  });

  test("a pre-consent failure is that id's error; the others are prompted and run", async () => {
    const { deps, rec } = fakeDeps({
      verifyThrows: {
        "a.x": {
          call: 1,
          error: new ExtensionRunGrantError("ERR_EXTENSION_NOT_FOUND", "not installed"),
        },
      },
      loadThrows: { "c.z": new EvalRunError("ERR_EVAL_NO_SUITES", "no suites") },
    });
    const results = await evaluateInstalledExtensions(["a.x", "b.y", "c.z"], deps);
    expect(results[0]).toEqual({
      id: "a.x",
      version: null,
      ok: false,
      error: { code: "ERR_EXTENSION_NOT_FOUND", message: "ERR_EXTENSION_NOT_FOUND: not installed" },
    });
    expect(results[1]).toEqual({ id: "b.y", version: "1.0.0", ok: true, report: REPORT });
    // verify passed, so the version is known even though the load failed
    expect(results[2]).toEqual({
      id: "c.z",
      version: "1.0.0",
      ok: false,
      error: { code: "ERR_EVAL_NO_SUITES", message: "no suites" },
    });
    expect(rec.gatePayloads[0]?.payload).toEqual({
      extensions: [{ id: "b.y", version: "1.0.0", cases: 3 }],
    });
    expect(rec.calls.filter((c) => c.startsWith("run:"))).toEqual(["run:b.y"]);
  });

  test("when every id fails pre-consent there is no prompt", async () => {
    const { deps, rec } = fakeDeps({
      loadThrows: { "a.x": new Error("boom") },
    });
    const results = await evaluateInstalledExtensions(["a.x"], deps);
    expect(results).toEqual([
      {
        id: "a.x",
        version: "1.0.0",
        ok: false,
        error: { code: "ERR_EVAL_INTERNAL", message: "boom" },
      },
    ]);
    expect(rec.calls).not.toContain("gate");
  });

  test("no ids: no prompt, no results", async () => {
    const { deps, rec } = fakeDeps();
    expect(await evaluateInstalledExtensions([], deps)).toEqual([]);
    expect(rec.calls).toEqual([]);
  });

  test("a tree that changed after consent refuses ERR_EXTENSION_EVAL_CHANGED and is not run", async () => {
    const { deps, rec } = fakeDeps({ digestOnCall: { "a.x": { call: 2, digest: "tampered" } } });
    const results = await evaluateInstalledExtensions(["a.x", "b.y"], deps);
    expect(results[0]?.ok).toBe(false);
    expect(results[0]).toMatchObject({
      id: "a.x",
      version: "1.0.0",
      error: { code: "ERR_EXTENSION_EVAL_CHANGED" },
    });
    expect(results[1]?.ok).toBe(true);
    expect(rec.calls.filter((c) => c.startsWith("run:"))).toEqual(["run:b.y"]);
  });

  test("a post-consent verification refusal is that id's error and the next id still runs", async () => {
    const { deps, rec } = fakeDeps({
      verifyThrows: {
        "a.x": {
          call: 2,
          error: new ExtensionRunGrantError("ERR_EXTENSION_RUN_DISABLED", "a.x is disabled"),
        },
      },
    });
    const results = await evaluateInstalledExtensions(["a.x", "b.y"], deps);
    expect(results[0]).toMatchObject({
      id: "a.x",
      version: "1.0.0",
      ok: false,
      error: { code: "ERR_EXTENSION_RUN_DISABLED" },
    });
    expect(results[1]?.ok).toBe(true);
    expect(rec.calls.filter((c) => c.startsWith("run:"))).toEqual(["run:b.y"]);
  });

  test("an EvalRunError from the run is that id's error and the next id still runs", async () => {
    const { deps } = fakeDeps({
      runThrows: { "a.x": new EvalRunError("ERR_EVAL_START_FAILED", "did not start") },
    });
    const results = await evaluateInstalledExtensions(["a.x", "b.y"], deps);
    expect(results).toEqual([
      {
        id: "a.x",
        version: "1.0.0",
        ok: false,
        error: { code: "ERR_EVAL_START_FAILED", message: "did not start" },
      },
      { id: "b.y", version: "1.0.0", ok: true, report: REPORT },
    ]);
  });

  test("a post-consent reload failure is that id's error, before any re-verification or run", async () => {
    const { deps, rec } = fakeDeps();
    let loads = 0;
    const baseLoad = deps.load;
    const results = await evaluateInstalledExtensions(["a.x"], {
      ...deps,
      load: async (dir, o) => {
        loads += 1;
        if (loads === 2) throw new EvalRunError("ERR_EVAL_SUITE_INVALID", "bad suite");
        if (baseLoad === undefined) throw new Error("unreachable");
        return baseLoad(dir, o);
      },
    });
    expect(results[0]).toMatchObject({ ok: false, error: { code: "ERR_EVAL_SUITE_INVALID" } });
    expect(rec.calls.filter((c) => c === "verify:a.x")).toHaveLength(1);
    expect(rec.calls.filter((c) => c.startsWith("run:"))).toEqual([]);
  });

  test("a package whose manifest names another id or version is refused as changed", async () => {
    const { deps, rec } = fakeDeps();
    const baseLoad = deps.load;
    const results = await evaluateInstalledExtensions(["a.x"], {
      ...deps,
      load: async (dir, o) => {
        if (baseLoad === undefined) throw new Error("unreachable");
        return { ...(await baseLoad(dir, o)), version: "2.0.0" };
      },
    });
    expect(results[0]).toMatchObject({
      ok: false,
      version: "1.0.0",
      error: { code: "ERR_EXTENSION_EVAL_CHANGED" },
    });
    expect(rec.calls).not.toContain("gate");
  });

  test("files that changed between the two loads are refused as changed", async () => {
    const { deps, rec } = fakeDeps();
    const baseLoad = deps.load;
    let loads = 0;
    const results = await evaluateInstalledExtensions(["a.x"], {
      ...deps,
      load: async (dir, o) => {
        if (baseLoad === undefined) throw new Error("unreachable");
        loads += 1;
        const src = await baseLoad(dir, o);
        return loads === 2 ? { ...src, filesDigest: "other" } : src;
      },
    });
    expect(results[0]).toMatchObject({ ok: false, error: { code: "ERR_EXTENSION_EVAL_CHANGED" } });
    expect(rec.calls.filter((c) => c.startsWith("run:"))).toEqual([]);
  });

  test("duplicate ids are approved and evaluated once; results keep request order", async () => {
    const { deps, rec } = fakeDeps();
    const results = await evaluateInstalledExtensions(["b.y", "a.x", "b.y"], deps);
    expect(results.map((r) => r.id)).toEqual(["b.y", "a.x", "b.y"]);
    expect(results[2]).toEqual(results[0]);
    expect(rec.gatePayloads[0]?.payload).toEqual({
      extensions: [
        { id: "b.y", version: "1.0.0", cases: 3 },
        { id: "a.x", version: "1.0.0", cases: 3 },
      ],
    });
    expect(rec.calls.filter((c) => c.startsWith("run:"))).toEqual(["run:b.y", "run:a.x"]);
  });

  test("the run receives the sandbox deps and the injected client factory", async () => {
    const { deps } = fakeDeps();
    let seen: Parameters<NonNullable<InstalledEvalDeps["run"]>>[1] | undefined;
    await evaluateInstalledExtensions(["a.x"], {
      ...deps,
      runtimeReadPaths: ["/bun"],
      run: async (_src, d) => {
        seen = d;
        return REPORT;
      },
    });
    expect(seen?.sandboxDir).toBe("/sandbox");
    expect(seen?.runtimeReadPaths).toEqual(["/bun"]);
    expect(seen?.canConfine).toBe(deps.canConfine);
    expect(seen?.createClient).toBe(deps.createClient);
  });

  test("with no injected factory the run gets the role's @mastra/mcp adapter, loaded after consent", async () => {
    const { deps } = fakeDeps();
    const { createClient: _omit, ...rest } = deps;
    const factories: unknown[] = [];
    const results = await evaluateInstalledExtensions(["a.x", "b.y"], {
      ...rest,
      run: async (_src, d) => {
        factories.push(d.createClient);
        return REPORT;
      },
    });
    expect(results.every((r) => r.ok)).toBe(true);
    expect(typeof factories[0]).toBe("function");
    // resolved once per call, shared by every extension
    expect(factories[1]).toBe(factories[0]);
  });
});

// ── In process, end to end: the REAL verifier and loader, a fake MCP client (nothing spawns) ──

async function installWithEvals(signed: boolean): Promise<{
  db: Database;
  vault: MockVault;
  env: ExtensionRunGrantEnv;
  id: string;
  root: string;
  installPath: string;
}> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "nimbus-installed-eval-")));
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  cleanups.push(() => db.close());
  const id = "com.example.evalme";
  const vault = new MockVault();
  const src = join(root, "src");
  mkdirSync(join(src, "dist"), { recursive: true });
  mkdirSync(join(src, "evals"), { recursive: true });
  const manifest: Record<string, unknown> = { id, version: "1.0.0", entry: "dist/index.js" };
  let publisherKeyPath: string | undefined;
  if (signed) {
    const kp = generateEd25519Keypair();
    manifest["publisher"] = { id: "test-pub", key: encodeBase64(kp.pubkey) };
    manifest["signature"] = await signManifest(manifest, kp.privkey);
    publisherKeyPath = join(root, "pub.key");
    writeFileSync(publisherKeyPath, `${encodeBase64(kp.pubkey)}\n`);
  }
  writeFileSync(join(src, "nimbus.extension.json"), JSON.stringify(manifest));
  writeFileSync(join(src, "dist", "index.js"), "export {};\n");
  writeFileSync(
    join(src, "evals", "basic.eval.json"),
    JSON.stringify({
      format: 1,
      name: "basic",
      cases: [
        {
          name: "c1",
          tool: "echo",
          input: { say: "hi" },
          expect: { rubric: "exact", value: "hi" },
        },
        {
          name: "c2",
          tool: "echo",
          input: { say: "yo" },
          expect: { rubric: "exact", value: "no" },
        },
      ],
    }),
  );
  const extensionsDir = join(root, "data", "extensions");
  await installExtensionFromLocalDirectory({
    db,
    extensionsDir,
    sourcePath: src,
    approve: async () => true,
    ...(publisherKeyPath === undefined ? {} : { vault, publisherKeyPath }),
  });
  mkdirSync(join(root, "sandbox"), { recursive: true });
  const env: ExtensionRunGrantEnv = {
    platform: process.platform,
    protectedRoots: [join(root, "data")],
    runtimeReadPaths: [],
    realpath: (p) => realpathSync.native(p),
  };
  return { db, vault, env, id, root, installPath: join(extensionsDir, id) };
}

function echoClientFactory(created: Array<Record<string, ServerSpec>>) {
  return (_id: string, servers: Record<string, ServerSpec>): EvalMcpClient => {
    created.push(servers);
    const [serverKey] = Object.keys(servers);
    return {
      listToolsWithErrors: async () => ({
        tools: {
          [`${serverKey}_echo`]: {
            execute: async (input: unknown) => ({
              content: [{ type: "text", text: String((input as { say?: unknown }).say) }],
            }),
          },
        },
        errors: {},
      }),
      disconnect: async () => {},
    };
  };
}

describe("evaluateInstalledExtensions (real verifier + loader, fake client)", () => {
  test("an installed signed extension is approved once, evaluated, and gains no run grant", async () => {
    const f = await installWithEvals(true);
    const created: Array<Record<string, ServerSpec>> = [];
    const gates: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const results = await evaluateInstalledExtensions([f.id], {
      db: f.db,
      vault: f.vault,
      env: f.env,
      sandboxDir: join(f.root, "sandbox"),
      runtimeReadPaths: [],
      canConfine: () => null,
      createClient: echoClientFactory(created),
      ownerGate: async (a) => {
        gates.push(a);
        return true;
      },
    });
    expect(gates).toEqual([
      {
        type: "extension.eval",
        payload: { extensions: [{ id: f.id, version: "1.0.0", cases: 2 }] },
      },
    ]);
    expect(results).toHaveLength(1);
    const r = results[0];
    if (r?.ok !== true) throw new Error(`expected a report, got ${JSON.stringify(r)}`);
    expect(r.id).toBe(f.id);
    expect(r.version).toBe("1.0.0");
    expect(r.report.cases).toBe(2);
    expect(r.report.passed).toBe(1);
    expect(created).toHaveLength(1);
    expect(getRunGrant(f.db, f.id)).toBeNull();
  });

  test("a denial spawns nothing (no client is ever built)", async () => {
    const f = await installWithEvals(false);
    const created: Array<Record<string, ServerSpec>> = [];
    const err = await evaluateInstalledExtensions([f.id], {
      db: f.db,
      vault: f.vault,
      env: f.env,
      sandboxDir: join(f.root, "sandbox"),
      runtimeReadPaths: [],
      canConfine: () => null,
      createClient: echoClientFactory(created),
      ownerGate: async () => false,
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(EvalApprovalDenied);
    expect(created).toEqual([]);
  });

  test("a file changed while the prompt was open is refused after consent, nothing spawned", async () => {
    const f = await installWithEvals(false);
    const created: Array<Record<string, ServerSpec>> = [];
    const results = await evaluateInstalledExtensions([f.id], {
      db: f.db,
      vault: f.vault,
      env: f.env,
      sandboxDir: join(f.root, "sandbox"),
      runtimeReadPaths: [],
      canConfine: () => null,
      createClient: echoClientFactory(created),
      ownerGate: async () => {
        writeFileSync(join(f.installPath, "dist", "index.js"), "export const evil = 1;\n");
        return true;
      },
    });
    expect(results[0]?.ok).toBe(false);
    expect(results[0]).toMatchObject({ error: { code: "ERR_EXTENSION_RUN_UNVERIFIED" } });
    expect(created).toEqual([]);
  });

  test("a suite changed while the prompt was open: the reload sees it, the re-verify refuses it", async () => {
    const f = await installWithEvals(false);
    const created: Array<Record<string, ServerSpec>> = [];
    const results = await evaluateInstalledExtensions([f.id], {
      db: f.db,
      vault: f.vault,
      env: f.env,
      sandboxDir: join(f.root, "sandbox"),
      runtimeReadPaths: [],
      canConfine: () => null,
      createClient: echoClientFactory(created),
      ownerGate: async () => {
        writeFileSync(
          join(f.installPath, "evals", "basic.eval.json"),
          JSON.stringify({
            format: 1,
            name: "basic",
            cases: [
              { name: "c1", tool: "echo", input: {}, expect: { rubric: "exact", value: "" } },
            ],
          }),
        );
        return true;
      },
    });
    expect(results[0]).toMatchObject({
      ok: false,
      version: "1.0.0",
      error: { code: "ERR_EXTENSION_RUN_TREE_CHANGED" },
    });
    expect(created).toEqual([]);
  });
});
