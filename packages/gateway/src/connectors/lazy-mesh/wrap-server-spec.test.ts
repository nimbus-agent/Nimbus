import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionManifest } from "../../extensions/manifest.ts";
import type { ServerSpec } from "./slot.ts";
import { wrapServerSpec } from "./wrap-server-spec.ts";

// Real, unique temp root for the fake sandbox cwd args (S5443). wrapServerSpec
// only string-copies the cwd into env — it is never written to.
const TMP_ROOT = mkdtempSync(join(tmpdir(), "nimbus-wrap-spec-test-"));
const CWD = join(TMP_ROOT, "cwd");
const LEGIT_CWD = join(TMP_ROOT, "legitimate");

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
    const wrapped = wrapServerSpec(makeSpec(), makeManifest(), CWD);
    expect(wrapped.command).toBe(process.execPath);
  });

  test("args lead with the gateway entry and the sandbox sentinel (dev tree)", () => {
    const wrapped = wrapServerSpec(makeSpec(), makeManifest(), CWD);
    expect(wrapped.args[0]).toMatch(/[\\/]packages[\\/]gateway[\\/]src[\\/]index\.ts$/);
    expect(wrapped.args[1]).toBe("__nimbus-sandbox");
  });

  test("preserves the original command + args after the sentinel", () => {
    const wrapped = wrapServerSpec(makeSpec(), makeManifest(), CWD);
    expect(wrapped.args[2]).toBe("bun");
    expect(wrapped.args[3]).toBe("packages/mcp-connectors/github/src/server.ts");
    expect(wrapped.args[4]).toBe("--mode");
    expect(wrapped.args[5]).toBe("stdio");
  });

  test("preserves caller-supplied env keys", () => {
    const wrapped = wrapServerSpec(
      makeSpec({ EXTRA: "value", PATH: "/usr/bin" }),
      makeManifest(),
      CWD,
    );
    expect(wrapped.env["GITHUB_PAT"]).toBe("ghp_test");
    expect(wrapped.env["EXTRA"]).toBe("value");
    expect(wrapped.env["PATH"]).toBe("/usr/bin");
  });

  test("adds NIMBUS_SANDBOX_MANIFEST_JSON env carrying the JSON-stringified manifest", () => {
    const manifest = makeManifest({ network: ["api.github.com"] });
    const wrapped = wrapServerSpec(makeSpec(), manifest, CWD);
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
    wrapServerSpec(spec, makeManifest(), CWD);
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
      LEGIT_CWD,
    );
    const parsed = JSON.parse(
      wrapped.env["NIMBUS_SANDBOX_MANIFEST_JSON"] as string,
    ) as ExtensionManifest;
    expect(parsed.id).toBe("com.nimbus.test");
    expect(parsed.permissions.network).toEqual(["api.github.com"]);
    expect(wrapped.env["NIMBUS_SANDBOX_CWD"]).toBe(LEGIT_CWD);
  });
});
