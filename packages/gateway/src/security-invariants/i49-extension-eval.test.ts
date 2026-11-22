import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { checkEvalConfinement } from "../../../../scripts/structure-audit/check-nimbus-invariants.ts";
import { stripComments } from "../../../../scripts/structure-audit/lib.ts";
import { read, readDirFiles, SRC_ROOT } from "../../test/helpers/security-invariants.ts";
import { NULL_EGRESS_SINK } from "../egress/egress-ledger.ts";

describe("I49 — extension code runs for evaluation only offline, without credentials", () => {
  // The eval runtime is driven for real (a real package on disk, the real loader, stager and spec
  // builder); only the MCP client is a fake, which RECORDS the spec it would have spawned. Nothing
  // here spawns a process.
  const roots: string[] = [];
  const PLANTED: Readonly<Record<string, string>> = {
    I49_TOKEN: "pl49a-tok",
    GITHUB_TOKEN: "pl49b-ghp",
    NIMBUS_I49_SECRET: "pl49c-sec",
  };
  const saved = new Map<string, string | undefined>();
  beforeEach(() => {
    for (const [k, v] of Object.entries(PLANTED)) {
      saved.set(k, process.env[k]);
      process.env[k] = v;
    }
  });
  afterEach(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    saved.clear();
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  /** A package that DECLARES a credential and a network host: neither may reach the eval spawn. */
  function writePackage(): { pkg: string; sandboxDir: string; runtimeReadPaths: string[] } {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "nimbus-i49-")));
    roots.push(root);
    const pkg = join(root, "pkg");
    mkdirSync(join(pkg, "dist"), { recursive: true });
    mkdirSync(join(pkg, "evals"), { recursive: true });
    writeFileSync(
      join(pkg, "nimbus.extension.json"),
      JSON.stringify({
        id: "com.example.i49",
        version: "1.0.0",
        entry: "dist/index.js",
        permissions: { network: ["api.example.com"], filesystem: { read: [], write: [] } },
        credentials: { token: { env: "I49_TOKEN" } },
      }),
    );
    writeFileSync(join(pkg, "dist", "index.js"), "export {};\n");
    writeFileSync(
      join(pkg, "evals", "basic.eval.json"),
      JSON.stringify({
        format: 1,
        name: "basic",
        cases: [{ name: "c1", tool: "echo", input: {}, expect: { rubric: "exact", value: "x" } }],
      }),
    );
    const sandboxDir = join(root, "sandbox");
    mkdirSync(sandboxDir, { recursive: true });
    return { pkg, sandboxDir, runtimeReadPaths: [join(root, "bun-bin")] };
  }

  interface Captured {
    order: string[];
    policies: unknown[];
    specs: { env: Record<string, string> }[];
  }

  async function runOnce(confineReason: string | null = null) {
    const { loadEvalPackage } = await import("../extensions/eval/eval-source.ts");
    const { runEvalSession } = await import("../extensions/eval/eval-runtime.ts");
    const { pkg, sandboxDir, runtimeReadPaths } = writePackage();
    const src = await loadEvalPackage(pkg);
    const cap: Captured = { order: [], policies: [], specs: [] };
    const run = runEvalSession(src, {
      sandboxDir,
      runtimeReadPaths,
      canConfine: (p) => {
        cap.order.push("canConfine");
        cap.policies.push(p);
        return confineReason;
      },
      createClient: (_id, servers) => {
        cap.order.push("createClient");
        const [key] = Object.keys(servers);
        for (const spec of Object.values(servers)) cap.specs.push(spec);
        return {
          listToolsWithErrors: async () => ({
            tools: {
              [`${key}_echo`]: {
                execute: async () => ({ content: [{ type: "text", text: "x" }] }),
              },
            },
            errors: {},
          }),
          disconnect: async () => {},
        };
      },
    });
    return { run, cap, src, sandboxDir, runtimeReadPaths };
  }

  test("behavioural: a package that declares a credential and a host is evaluated with no network and baseline env only", async () => {
    const { SANDBOX_POLICY_ENV, SANDBOX_CWD_ENV } = await import(
      "../platform/sandbox/sandbox-policy.ts"
    );
    const { isExtensionBaselineEnvKey } = await import("../extensions/spawn-env.ts");
    const { run, cap, src, sandboxDir, runtimeReadPaths } = await runOnce();
    const report = await run;
    expect(report.score).toBe(100);
    // The sandbox is asked first, about the same zero-reach policy, under the eval identity.
    expect(cap.order).toEqual(["canConfine", "createClient"]);
    expect(cap.policies).toEqual([
      {
        id: `eval.${src.serviceId}`,
        permissions: { network: [], filesystem: { read: runtimeReadPaths, write: [] } },
      },
    ]);
    expect(cap.specs).toHaveLength(1);
    const env = cap.specs[0]?.env ?? {};
    const policy = JSON.parse(env[SANDBOX_POLICY_ENV] ?? "null") as {
      id: string;
      permissions: { network: unknown[]; filesystem: { read: string[]; write: string[] } };
    };
    expect(policy.id).toBe(`eval.${src.serviceId}`);
    expect(policy.permissions.network).toEqual([]);
    expect(policy.permissions.filesystem).toEqual({ read: runtimeReadPaths, write: [] });
    // The child runs from a stage under the sandbox dir, never from the package itself.
    const cwd = env[SANDBOX_CWD_ENV] ?? "";
    expect(isAbsolute(cwd)).toBe(true);
    expect(relative(sandboxDir, cwd).startsWith("..")).toBe(false);
    // No planted secret, by name or by value; every key is a baseline key or the sandbox pair.
    const plantedValues = Object.values(PLANTED);
    for (const [k, v] of Object.entries(env)) {
      expect(Object.hasOwn(PLANTED, k)).toBe(false);
      expect(plantedValues).not.toContain(v);
      const allowed =
        isExtensionBaselineEnvKey(k) || k === SANDBOX_POLICY_ENV || k === SANDBOX_CWD_ENV;
      expect(allowed).toBe(true);
    }
  });

  test("behavioural: a sandbox that cannot confine the eval refuses it before anything is spawned", async () => {
    const { EvalRunError } = await import("../extensions/eval/eval-source.ts");
    const { run, cap } = await runOnce("no sandbox here");
    const err = await run.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(EvalRunError);
    expect((err as InstanceType<typeof EvalRunError>).code).toBe("ERR_EVAL_SANDBOX_UNAVAILABLE");
    expect(cap.order).toEqual(["canConfine"]);
  });

  test("source pins: D38 holds on the real tree, and the spec builder takes no credential input", async () => {
    const files = await readDirFiles("packages/gateway/src");
    expect(
      checkEvalConfinement(
        files.map((f) => ({ relPath: `packages/gateway/src/${f.rel}`, contents: f.contents })),
      ),
    ).toEqual([]);
    // The one env construction in the eval builder is the empty-extra call: baseline keys only.
    const builder = stripComments(
      await read("packages/gateway/src/extensions/eval/eval-spawn-spec.ts"),
    );
    expect([...builder.matchAll(/\bextensionProcessEnv\s*\(/g)]).toHaveLength(1);
    expect(builder).toMatch(/\bextensionProcessEnv\s*\(\s*\{\s*\}\s*\)/);
    expect(builder).toMatch(/\bnetwork:\s*\[\s*\]/);
    expect(builder).not.toMatch(/credential/i);
    // runEvalSession is reached from exactly two production modules: the eval role (`--package`)
    // and the gateway's installed-extension eval, which runs it only after the owner approved
    // `extension.eval`. Any REFERENCE counts, not only a call: `deps.run ?? runEvalSession` is a
    // caller that never writes `runEvalSession(`.
    const callers = files
      .filter((f) => /\brunEvalSession\b/.test(stripComments(f.contents)))
      .map((f) => f.rel)
      .sort();
    expect(callers).toEqual([
      "extensions/eval/eval-role.ts",
      "extensions/eval/eval-runtime.ts",
      "extensions/installed-eval.ts",
    ]);
    // The baseline door is a second entry to the same spawn: only the role (`--baseline`) and the
    // runtime that defines it name it.
    const baselineCallers = files
      .filter((f) => /\brunEvalBaselineSession\b/.test(stripComments(f.contents)))
      .map((f) => f.rel)
      .sort();
    expect(baselineCallers).toEqual([
      "extensions/eval/eval-role.ts",
      "extensions/eval/eval-runtime.ts",
    ]);
    // The record door is a third entry to the same spawn: only the role (`--record`) and the
    // runtime that defines it name it.
    const recordCallers = files
      .filter((f) => /\brunEvalRecordSession\b/.test(stripComments(f.contents)))
      .map((f) => f.rel)
      .sort();
    expect(recordCallers).toEqual([
      "extensions/eval/eval-role.ts",
      "extensions/eval/eval-runtime.ts",
    ]);
  });

  test("behavioural: the record door gets the same zero-reach policy, eval id and baseline-only env", async () => {
    const { SANDBOX_POLICY_ENV, SANDBOX_CWD_ENV } = await import(
      "../platform/sandbox/sandbox-policy.ts"
    );
    const { isExtensionBaselineEnvKey } = await import("../extensions/spawn-env.ts");
    const { loadEvalPackage } = await import("../extensions/eval/eval-source.ts");
    const { runEvalRecordSession } = await import("../extensions/eval/eval-runtime.ts");
    const { pkg, sandboxDir, runtimeReadPaths } = writePackage();
    const src = await loadEvalPackage(pkg, { baselineOnly: true });
    const order: string[] = [];
    const policies: unknown[] = [];
    const specs: { env: Record<string, string> }[] = [];
    const out = await runEvalRecordSession(
      src,
      { name: "rec", cases: [{ name: "c", tool: "echo", input: {} }] },
      {
        sandboxDir,
        runtimeReadPaths,
        canConfine: (p) => {
          order.push("canConfine");
          policies.push(p);
          return null;
        },
        createClient: (_id, servers) => {
          order.push("createClient");
          const [key] = Object.keys(servers);
          for (const spec of Object.values(servers)) specs.push(spec);
          return {
            listToolsWithErrors: async () => ({
              tools: {
                [`${key}_echo`]: {
                  execute: async () => ({ content: [{ type: "text", text: "x" }] }),
                },
              },
              errors: {},
            }),
            disconnect: async () => {},
          };
        },
      },
    );
    expect(out.first).toHaveLength(1);
    expect(out.second).toHaveLength(1);
    // One policy check, then one client per pass, each over the same spec shape.
    expect(order).toEqual(["canConfine", "createClient", "createClient"]);
    expect(policies).toEqual([
      {
        id: `eval.${src.serviceId}`,
        permissions: { network: [], filesystem: { read: runtimeReadPaths, write: [] } },
      },
    ]);
    expect(specs).toHaveLength(2);
    const plantedValues = Object.values(PLANTED);
    for (const spec of specs) {
      const env = spec.env;
      const policy = JSON.parse(env[SANDBOX_POLICY_ENV] ?? "null") as {
        id: string;
        permissions: { network: unknown[]; filesystem: { read: string[]; write: string[] } };
      };
      expect(policy.id).toBe(`eval.${src.serviceId}`);
      expect(policy.permissions.network).toEqual([]);
      expect(policy.permissions.filesystem).toEqual({ read: runtimeReadPaths, write: [] });
      const cwd = env[SANDBOX_CWD_ENV] ?? "";
      expect(isAbsolute(cwd)).toBe(true);
      expect(relative(sandboxDir, cwd).startsWith("..")).toBe(false);
      for (const [k, v] of Object.entries(env)) {
        expect(Object.hasOwn(PLANTED, k)).toBe(false);
        expect(plantedValues).not.toContain(v);
        const allowed =
          isExtensionBaselineEnvKey(k) || k === SANDBOX_POLICY_ENV || k === SANDBOX_CWD_ENV;
        expect(allowed).toBe(true);
      }
    }
    expect(readdirSync(sandboxDir).filter((n) => n !== "ext-stage")).toEqual([]);
  });

  test("behavioural: the record door refuses a sandbox that cannot confine before anything is staged", async () => {
    const { EvalRunError, loadEvalPackage } = await import("../extensions/eval/eval-source.ts");
    const { runEvalRecordSession } = await import("../extensions/eval/eval-runtime.ts");
    const { pkg, sandboxDir, runtimeReadPaths } = writePackage();
    const src = await loadEvalPackage(pkg, { baselineOnly: true });
    const order: string[] = [];
    const err = await runEvalRecordSession(
      src,
      { name: "rec", cases: [{ name: "c", tool: "echo", input: {} }] },
      {
        sandboxDir,
        runtimeReadPaths,
        canConfine: () => {
          order.push("canConfine");
          return "no sandbox here";
        },
        createClient: () => {
          order.push("createClient");
          throw new Error("must not be reached");
        },
      },
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(EvalRunError);
    expect((err as InstanceType<typeof EvalRunError>).code).toBe("ERR_EVAL_SANDBOX_UNAVAILABLE");
    expect(order).toEqual(["canConfine"]);
    expect(readdirSync(sandboxDir)).toEqual([]);
  });

  test("behavioural: the baseline door gets the same zero-reach policy, eval id and baseline-only env", async () => {
    const { SANDBOX_POLICY_ENV, SANDBOX_CWD_ENV } = await import(
      "../platform/sandbox/sandbox-policy.ts"
    );
    const { isExtensionBaselineEnvKey } = await import("../extensions/spawn-env.ts");
    const { loadEvalPackage } = await import("../extensions/eval/eval-source.ts");
    const { runEvalBaselineSession } = await import("../extensions/eval/eval-runtime.ts");
    const { pkg, sandboxDir, runtimeReadPaths } = writePackage();
    const src = await loadEvalPackage(pkg, { baselineOnly: true });
    expect(src.suites).toEqual([]);
    const order: string[] = [];
    const policies: unknown[] = [];
    const specs: { env: Record<string, string> }[] = [];
    const baseline = await runEvalBaselineSession(src, {
      sandboxDir,
      runtimeReadPaths,
      canConfine: (p) => {
        order.push("canConfine");
        policies.push(p);
        return null;
      },
      createClient: (_id, servers) => {
        order.push("createClient");
        const [key] = Object.keys(servers);
        for (const spec of Object.values(servers)) specs.push(spec);
        return {
          listToolDefinitionsWithErrors: async () => ({
            definitions: {
              [String(key)]: { echo: { name: "echo", inputSchema: { type: "object" } } },
            },
            errors: {},
          }),
          disconnect: async () => {},
        };
      },
    });
    expect(baseline).toEqual({ scorer: 1, passed: true, tools: 1 });
    expect(order).toEqual(["canConfine", "createClient"]);
    expect(policies).toEqual([
      {
        id: `eval.${src.serviceId}`,
        permissions: { network: [], filesystem: { read: runtimeReadPaths, write: [] } },
      },
    ]);
    expect(specs).toHaveLength(1);
    const env = specs[0]?.env ?? {};
    const policy = JSON.parse(env[SANDBOX_POLICY_ENV] ?? "null") as {
      id: string;
      permissions: { network: unknown[]; filesystem: { read: string[]; write: string[] } };
    };
    expect(policy.id).toBe(`eval.${src.serviceId}`);
    expect(policy.permissions.network).toEqual([]);
    expect(policy.permissions.filesystem).toEqual({ read: runtimeReadPaths, write: [] });
    const cwd = env[SANDBOX_CWD_ENV] ?? "";
    expect(isAbsolute(cwd)).toBe(true);
    expect(relative(sandboxDir, cwd).startsWith("..")).toBe(false);
    const plantedValues = Object.values(PLANTED);
    for (const [k, v] of Object.entries(env)) {
      expect(Object.hasOwn(PLANTED, k)).toBe(false);
      expect(plantedValues).not.toContain(v);
      const allowed =
        isExtensionBaselineEnvKey(k) || k === SANDBOX_POLICY_ENV || k === SANDBOX_CWD_ENV;
      expect(allowed).toBe(true);
    }
    expect(readdirSync(sandboxDir).filter((n) => n !== "ext-stage")).toEqual([]);
  });

  test("behavioural: a gateway-hosted eval the LOCAL owner denies at the real executor gate runs nothing and stages nothing", async () => {
    const { ToolExecutor, NO_POLICY_OVERLAY } = await import("../engine/executor.ts");
    const { LocalIndex } = await import("../index/local-index.ts");
    const { MockVault } = await import("../vault/mock.ts");
    const { installExtensionFromLocalDirectory } = await import(
      "../extensions/install-from-local.ts"
    );
    const { evaluateInstalledExtensions, EvalApprovalDenied } = await import(
      "../extensions/installed-eval.ts"
    );
    const { pkg, sandboxDir } = writePackage();
    const root = resolve(pkg, "..");
    const db = new Database(":memory:");
    try {
      LocalIndex.ensureSchema(db);
      const extensionsDir = join(root, "data", "extensions");
      await installExtensionFromLocalDirectory({
        db,
        extensionsDir,
        sourcePath: pkg,
        approve: async () => true,
      });
      const raised: string[] = [];
      const exec = new ToolExecutor(
        {
          requestApproval: async (prompt: string) => {
            raised.push(prompt);
            return { approved: false, answerSource: "human" as const };
          },
        },
        { recordAudit: () => {} },
        { dispatch: async () => ({}) },
        undefined,
        NULL_EGRESS_SINK,
        NO_POLICY_OVERLAY,
      );
      let clients = 0;
      const err = await evaluateInstalledExtensions(["com.example.i49"], {
        db,
        vault: new MockVault(),
        env: {
          platform: process.platform,
          protectedRoots: [join(root, "data")],
          runtimeReadPaths: [],
          realpath: (p) => realpathSync.native(p),
        },
        ownerGate: async (a) => (await exec.gate(a)) === "proceed",
        sandboxDir,
        runtimeReadPaths: [],
        canConfine: () => null,
        createClient: () => {
          clients += 1;
          throw new Error("an eval client was built after a denial");
        },
      }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(EvalApprovalDenied);
      // The owner WAS asked (the extension passed every pre-consent check), once, for this type.
      expect(raised).toHaveLength(1);
      expect(raised[0]).toContain("Type: extension.eval");
      expect(raised[0]).toContain("com.example.i49");
      expect(clients).toBe(0);
      expect(readdirSync(sandboxDir)).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("source pin: the installed-extension eval asks the owner before anything can run", async () => {
    const src = stripComments(await read("packages/gateway/src/extensions/installed-eval.ts"));
    const bodyOf = (name: string): string => {
      const start = src.search(new RegExp(String.raw`\bfunction\s+${name}\s*\(`));
      expect(start).toBeGreaterThanOrEqual(0);
      const next = src.slice(start + 1).search(/\n(?:export\s+)?(?:async\s+)?function\s/);
      return next === -1 ? src.slice(start) : src.slice(start, start + 1 + next);
    };
    // The entry point: the one approval strictly before the evaluation loop.
    const entry = bodyOf("evaluateInstalledExtensions");
    const ask = entry.search(/\bawait\s+askOwnerOnce\s*\(/);
    const evaluate = entry.search(/\bevaluateEach\s*\(/);
    expect(ask).toBeGreaterThanOrEqual(0);
    expect(evaluate).toBeGreaterThan(ask);
    // The approval is the executor gate for `extension.eval`, and anything but `true` throws.
    const askBody = bodyOf("askOwnerOnce");
    expect(askBody).toMatch(/\bdeps\.ownerGate\s*\(/);
    expect(askBody).toMatch(/\btype:\s*EXTENSION_EVAL_ACTION_TYPE\b/);
    expect(askBody).toMatch(
      /if\s*\(\s*approved\s*!==\s*true\s*\)\s*throw\s+new\s+EvalApprovalDenied/,
    );
    expect(src).toMatch(/EXTENSION_EVAL_ACTION_TYPE\s*=\s*"extension\.eval"/);
    // The ONE run call (`io.run(`, never a direct `runEvalSession(`) lives in evaluateOne, which
    // only evaluateEach calls — so no code path reaches a spawn without passing the approval.
    expect([...src.matchAll(/\brunEvalSession\s*\(/g)]).toHaveLength(0);
    expect([...src.matchAll(/\.run\s*\(/g)]).toHaveLength(1);
    expect(bodyOf("evaluateOne")).toMatch(/\bio\.run\s*\(/);
    const evaluateOneCallers = [...src.matchAll(/\bevaluateOne\s*\(/g)].length;
    expect(evaluateOneCallers).toBe(2); // its declaration and the one call
    expect(bodyOf("evaluateEach")).toMatch(/\bevaluateOne\s*\(/);
    expect([...src.matchAll(/\bevaluateEach\s*\(/g)]).toHaveLength(2);
  });

  test("the eval role's module graph reaches no Vault, DB, IPC, egress or executor, nor the gateway", () => {
    // Static value edges and re-exports (`import type` is erased) plus dynamic `import()` edges,
    // from the role: the graph the role actually evaluates, including its in-run imports.
    const EDGE_RE =
      /^\s*(?:import|export)\s+(?!type\b)(?:[^;]*?\bfrom\s*)?["'](\.[^"']+)["']|\bimport\s*\(\s*["'](\.[^"']+)["']\s*\)/gm;
    const isFile = (p: string): boolean => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    };
    const resolveSpec = (from: string, spec: string): string | undefined => {
      const base = resolve(from, "..", spec);
      return [base, `${base}.ts`, join(base, "index.ts")].find(isFile);
    };
    /** Repo-src-relative files reached from the role. */
    const graph = (): string[] => {
      const seen = new Set<string>();
      const stack = [join(SRC_ROOT, "extensions", "eval", "eval-role.ts")];
      while (stack.length > 0) {
        const file = stack.pop() as string;
        if (seen.has(file)) continue;
        seen.add(file);
        const code = stripComments(readFileSync(file, "utf8"));
        for (const m of code.matchAll(EDGE_RE)) {
          const r = resolveSpec(file, (m[1] ?? m[2]) as string);
          if (r !== undefined) stack.push(r);
        }
      }
      return [...seen].map((f) => relative(SRC_ROOT, f).replaceAll("\\", "/"));
    };
    const rel = graph();
    // Red-proof that the walk followed the dynamic edges: the runtime and the spec builder are in.
    expect(rel).toContain("extensions/eval/eval-runtime.ts");
    expect(rel).toContain("extensions/eval/eval-spawn-spec.ts");
    expect(rel).toContain("extensions/extension-launch-command.ts");
    expect(rel).toContain("platform/sandbox/index.ts");
    expect(rel.filter((f) => /(^|\/)(db|vault|ipc|egress)\//.test(f))).toEqual([]);
    expect(rel.filter((f) => f === "engine/executor.ts" || f === "gateway-main.ts")).toEqual([]);
    // The run path's module (stores, Vault-backed credentials) is not in the eval graph at all.
    expect(rel).not.toContain("extensions/extension-runtime.ts");
  });

  test("static: loadEvalPackage reads every package file once — manifest, suites and filesDigest share one map (bound 3)", async () => {
    const src = stripComments(await read("packages/gateway/src/extensions/eval/eval-source.ts"));
    const bodyOf = (name: string): string => {
      const start = src.indexOf(`function ${name}(`);
      expect(start).toBeGreaterThan(-1);
      const end = src.indexOf("\n}\n", start);
      return src.slice(start, end);
    };
    const load = bodyOf("loadEvalPackage");
    expect(load).toContain("readPackageOnce(opts.readFiles ?? readEvalPackageFiles,");
    expect(load).toContain("readManifest(dir, bytes)");
    expect(load).toContain("selectSuites(bytes,");
    expect(load).toContain("digestOfFileHashes(entries.");
    // A second read of the same files is what reopened the suite-swap window.
    expect(load).not.toContain("loadEvalSuites(");
    expect(load).not.toContain("evalFilesDigest(");
    expect(load).not.toContain("readFileSync(");
    expect(bodyOf("selectSuites")).toContain("evalSuitesFromFiles(bytes)");
  });
});
