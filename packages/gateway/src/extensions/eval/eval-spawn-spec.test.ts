import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RuntimeLayout } from "../../platform/runtime-layout.ts";
import { SANDBOX_CWD_ENV, SANDBOX_POLICY_ENV } from "../../platform/sandbox/sandbox-policy.ts";
import { buildExtensionSpawnSpec } from "../extension-runtime.ts";
import { isExtensionBaselineEnvKey } from "../spawn-env.ts";
import { buildExtensionEvalSpawnSpec, evalSandboxPolicy } from "./eval-spawn-spec.ts";

const runtimeReadPaths = [join(process.cwd(), "bun-runtime")];
const DEV_LAYOUT: RuntimeLayout = {
  execPath: join(process.cwd(), "bun.exe"),
  moduleDir: join(process.cwd(), "packages", "gateway", "src", "platform"),
  gatewayEntry: join(process.cwd(), "packages", "gateway", "src", "index.ts"),
};
const COMPILED_LAYOUT: RuntimeLayout = {
  execPath: join(process.cwd(), "nimbus-gateway.exe"),
  moduleDir: "/$bunfs/root",
  gatewayEntry: "/$bunfs/root/index.ts",
};

/** The inline role exactly as the run builder carries it (it is not exported). */
function devInlineRole(): string {
  const stagePath = join(tmpdir(), "eval-stage-role");
  const spec = buildExtensionSpawnSpec(
    {
      extensionId: "a.b",
      serviceId: "ext_a_b",
      version: "1.0.0",
      stagePath,
      entryPath: join(stagePath, "index.js"),
      grants: { network: [], read: [], write: [] },
      credentials: {},
    } as unknown as Parameters<typeof buildExtensionSpawnSpec>[0],
    { runtimeReadPaths, layout: DEV_LAYOUT, credentialEnv: {} },
  );
  return spec.args.at(-2) ?? "";
}

describe("buildExtensionEvalSpawnSpec", () => {
  const evalStaged = {
    serviceId: "ext_acme_x",
    version: "1.2.3",
    stagePath: join(tmpdir(), "eval-stage-x"),
    entryPath: join(tmpdir(), "eval-stage-x", "index.js"),
  };

  function decoded(spec: { env: Record<string, string> }): {
    id: string;
    permissions: { network: unknown[]; filesystem: { read: string[]; write: string[] } };
  } {
    return JSON.parse(spec.env[SANDBOX_POLICY_ENV] ?? "null");
  }

  test("policy: eval.<serviceId>, no network, read = runtime paths, no write", () => {
    const spec = buildExtensionEvalSpawnSpec(evalStaged, {
      runtimeReadPaths,
      layout: COMPILED_LAYOUT,
    });
    const policy = decoded(spec);
    expect(policy.id).toBe("eval.ext_acme_x");
    expect(policy.permissions.network).toEqual([]);
    expect(policy.permissions.filesystem.write).toEqual([]);
    expect(policy.permissions.filesystem.read).toEqual([...runtimeReadPaths]);
    expect(spec.env[SANDBOX_CWD_ENV]).toBe(evalStaged.stagePath);
  });

  test("env carries only baseline keys plus the sandbox pair: no GITHUB_/NIMBUS_ leaks", () => {
    const prior = { GITHUB_TOKEN: process.env["GITHUB_TOKEN"], NIMBUS_X: process.env["NIMBUS_X"] };
    process.env["GITHUB_TOKEN"] = "ghp_fake";
    process.env["NIMBUS_X"] = "leak";
    try {
      const spec = buildExtensionEvalSpawnSpec(evalStaged, {
        runtimeReadPaths,
        layout: DEV_LAYOUT,
      });
      expect(spec.env["GITHUB_TOKEN"]).toBeUndefined();
      expect(spec.env["NIMBUS_X"]).toBeUndefined();
      for (const k of Object.keys(spec.env)) {
        expect(
          isExtensionBaselineEnvKey(k) || k === SANDBOX_POLICY_ENV || k === SANDBOX_CWD_ENV,
        ).toBe(true);
      }
    } finally {
      // Restore, not delete: the Linux leg runs files in one worker (`--no-isolate`).
      for (const [k, v] of Object.entries(prior)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  test("compiled layout runs the self-role on the entry", () => {
    const spec = buildExtensionEvalSpawnSpec(evalStaged, {
      runtimeReadPaths,
      layout: COMPILED_LAYOUT,
    });
    expect(spec.args.slice(-3)).toEqual([
      COMPILED_LAYOUT.execPath,
      "__nimbus-extension",
      evalStaged.entryPath,
    ]);
  });

  test("dev layout uses the existing inline role and flags", () => {
    const spec = buildExtensionEvalSpawnSpec(evalStaged, {
      runtimeReadPaths,
      layout: DEV_LAYOUT,
    });
    const tail = spec.args.slice(-6);
    expect(tail[0]).toBe(DEV_LAYOUT.execPath);
    expect(tail.slice(1, 4)).toEqual(["--no-env-file", "--no-install", "-e"]);
    expect(tail[4]).toBe(devInlineRole());
    expect(tail[5]).toBe(evalStaged.entryPath);
  });

  test("evalSandboxPolicy matches the spawn's policy", () => {
    const spec = buildExtensionEvalSpawnSpec(evalStaged, {
      runtimeReadPaths,
      layout: COMPILED_LAYOUT,
    });
    const p = evalSandboxPolicy("ext_acme_x", runtimeReadPaths);
    expect(p.id).toBe("eval.ext_acme_x");
    expect(JSON.parse(JSON.stringify(p))).toEqual(decoded(spec));
  });
});
