import { describe, expect, test } from "bun:test";

import type { ExtensionManifest } from "../../extensions/manifest.ts";
import type { ServerSpec } from "./slot.ts";
import { SANDBOX_WRAPPER_PATH, wrapServerSpec } from "./wrap-server-spec.ts";

function makeManifest(
  overrides: Partial<ExtensionManifest["permissions"]> = {},
): ExtensionManifest {
  return {
    id: "com.nimbus.test",
    version: "1.0.0",
    permissions: {
      network: [],
      filesystem: { read: [], write: [] },
      ...overrides,
    },
    updateChannel: "stable",
  };
}

function makeSpec(env: Record<string, string> = {}): ServerSpec {
  return {
    command: "bun",
    args: ["packages/mcp-connectors/github/src/server.ts", "--mode", "stdio"],
    env: { GITHUB_PAT: "ghp_test", ...env },
  };
}

describe("wrapServerSpec", () => {
  test("replaces command with process.execPath", () => {
    const wrapped = wrapServerSpec(makeSpec(), makeManifest(), "/tmp/cwd");
    expect(wrapped.command).toBe(process.execPath);
  });

  test("args[0] is the sandbox-wrapper path", () => {
    const wrapped = wrapServerSpec(makeSpec(), makeManifest(), "/tmp/cwd");
    expect(wrapped.args[0]).toBe(SANDBOX_WRAPPER_PATH);
    expect(wrapped.args[0]).toMatch(/[\\/]platform[\\/]sandbox[\\/]sandbox-wrapper\.ts$/);
  });

  test("preserves the original command + args after the wrapper path", () => {
    const wrapped = wrapServerSpec(makeSpec(), makeManifest(), "/tmp/cwd");
    expect(wrapped.args[1]).toBe("bun");
    expect(wrapped.args[2]).toBe("packages/mcp-connectors/github/src/server.ts");
    expect(wrapped.args[3]).toBe("--mode");
    expect(wrapped.args[4]).toBe("stdio");
  });

  test("preserves caller-supplied env keys", () => {
    const wrapped = wrapServerSpec(
      makeSpec({ EXTRA: "value", PATH: "/usr/bin" }),
      makeManifest(),
      "/tmp/cwd",
    );
    expect(wrapped.env["GITHUB_PAT"]).toBe("ghp_test");
    expect(wrapped.env["EXTRA"]).toBe("value");
    expect(wrapped.env["PATH"]).toBe("/usr/bin");
  });

  test("adds NIMBUS_SANDBOX_MANIFEST_JSON env carrying the JSON-stringified manifest", () => {
    const manifest = makeManifest({ network: ["api.github.com"] });
    const wrapped = wrapServerSpec(makeSpec(), manifest, "/tmp/cwd");
    const raw = wrapped.env["NIMBUS_SANDBOX_MANIFEST_JSON"];
    expect(raw).toBeDefined();
    const parsed = JSON.parse(raw as string) as ExtensionManifest;
    expect(parsed.id).toBe("com.nimbus.test");
    expect(parsed.permissions.network).toEqual(["api.github.com"]);
  });

  test("adds NIMBUS_SANDBOX_CWD env from the cwd argument", () => {
    const wrapped = wrapServerSpec(makeSpec(), makeManifest(), "/home/user/data");
    expect(wrapped.env["NIMBUS_SANDBOX_CWD"]).toBe("/home/user/data");
  });

  test("does not mutate the input spec", () => {
    const spec = makeSpec();
    const originalCommand = spec.command;
    const originalArgs = [...spec.args];
    const originalEnvKeys = Object.keys(spec.env).sort((a, b) => a.localeCompare(b));
    wrapServerSpec(spec, makeManifest(), "/tmp/cwd");
    expect(spec.command).toBe(originalCommand);
    expect(spec.args).toEqual(originalArgs);
    expect(Object.keys(spec.env).sort((a, b) => a.localeCompare(b))).toEqual(originalEnvKeys);
  });

  test("the env-control keys overlay (not replace) when the spec already has them", () => {
    const wrapped = wrapServerSpec(
      makeSpec({
        NIMBUS_SANDBOX_MANIFEST_JSON:
          '{"id":"attacker","version":"0","permissions":{"network":["evil.com"],"filesystem":{"read":[],"write":[]}}}',
        NIMBUS_SANDBOX_CWD: "/etc",
      }),
      makeManifest({ network: ["api.github.com"] }),
      "/tmp/legitimate",
    );
    const parsed = JSON.parse(
      wrapped.env["NIMBUS_SANDBOX_MANIFEST_JSON"] as string,
    ) as ExtensionManifest;
    expect(parsed.id).toBe("com.nimbus.test");
    expect(parsed.permissions.network).toEqual(["api.github.com"]);
    expect(wrapped.env["NIMBUS_SANDBOX_CWD"]).toBe("/tmp/legitimate");
  });
});

describe("SANDBOX_WRAPPER_PATH", () => {
  test("resolves to an absolute path under platform/sandbox/", () => {
    expect(SANDBOX_WRAPPER_PATH).toMatch(/[\\/]platform[\\/]sandbox[\\/]sandbox-wrapper\.ts$/);
    expect(SANDBOX_WRAPPER_PATH).toMatch(/^([A-Za-z]:[\\/]|[\\/])/);
  });
});
