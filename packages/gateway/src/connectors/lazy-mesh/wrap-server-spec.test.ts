import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionManifest } from "../../extensions/manifest.ts";
import { sandboxCwdFor } from "../../platform/sandbox/sandbox-cwd.ts";
import type { SandboxPolicy } from "../../platform/sandbox/sandbox-policy.ts";
import {
  SANDBOX_OBSERVATION_FILE_ENV,
  SANDBOX_OBSERVATION_LABEL_ENV,
  sandboxWrapperOnlyEnv,
} from "../../platform/sandbox/sandbox-policy.ts";
import type { ServerSpec } from "./slot.ts";
import { wrapServerSpec, wrapServerSpecInCwd } from "./wrap-server-spec.ts";

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

// The shape `connectorSpawn` (keys.ts) gives a first-party connector in a compiled binary: the
// binary re-executing itself in its `__nimbus-connector` role. Deliberately NOT the dev-tree form,
// whose `<gateway>/src/index.ts` argument would also satisfy the entry assertion below.
function makeSpec(env: Record<string, string> = {}): ServerSpec {
  return {
    command: "nimbus-gateway",
    args: ["__nimbus-connector", "github"],
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
    expect(wrapped.args.slice(2)).toEqual(["nimbus-gateway", "__nimbus-connector", "github"]);
  });

  test("on Linux hands the wrapper what the env allowlist drops, and nothing on other systems", () => {
    const env = {
      NIMBUS_SANDBOX_HELPER_PATH: "/opt/helper",
      XDG_RUNTIME_DIR: "/run/user/1000",
      GITHUB_PAT: "not-this",
    };
    expect(sandboxWrapperOnlyEnv(env, "linux")).toEqual({
      NIMBUS_SANDBOX_HELPER_PATH: "/opt/helper",
      XDG_RUNTIME_DIR: "/run/user/1000",
    });
    expect(sandboxWrapperOnlyEnv(env, "win32")).toEqual({});
    expect(sandboxWrapperOnlyEnv(env, "darwin")).toEqual({});
    expect(sandboxWrapperOnlyEnv({ XDG_RUNTIME_DIR: "" }, "linux")).toEqual({});
  });

  describe.skipIf(process.platform !== "linux")("the wrapper-only variables", () => {
    const saved = process.env["NIMBUS_SANDBOX_HELPER_PATH"];
    afterEach(() => {
      if (saved === undefined) delete process.env["NIMBUS_SANDBOX_HELPER_PATH"];
      else process.env["NIMBUS_SANDBOX_HELPER_PATH"] = saved;
    });

    test("a network-declaring spawn carries the helper override", () => {
      process.env["NIMBUS_SANDBOX_HELPER_PATH"] = "/opt/helper";
      const manifest = makeManifest({ network: ["a.example.com"] });
      expect(wrapServerSpec(makeSpec(), manifest, CWD).env["NIMBUS_SANDBOX_HELPER_PATH"]).toBe(
        "/opt/helper",
      );
    });

    test("wildcards alone count as declaring", () => {
      process.env["NIMBUS_SANDBOX_HELPER_PATH"] = "/opt/helper";
      const manifest = { ...makeManifest(), firstPartyWildcardHosts: ["*.sharepoint.com"] };
      expect(wrapServerSpec(makeSpec(), manifest, CWD).env["NIMBUS_SANDBOX_HELPER_PATH"]).toBe(
        "/opt/helper",
      );
    });

    test("a no-network spawn does not", () => {
      process.env["NIMBUS_SANDBOX_HELPER_PATH"] = "/opt/helper";
      expect(
        "NIMBUS_SANDBOX_HELPER_PATH" in wrapServerSpec(makeSpec(), makeManifest(), CWD).env,
      ).toBe(false);
    });
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

  test("adds NIMBUS_SANDBOX_POLICY_JSON env carrying the JSON-stringified policy", () => {
    const manifest = makeManifest({ network: ["api.github.com"] });
    const wrapped = wrapServerSpec(makeSpec(), manifest, CWD);
    const raw = wrapped.env["NIMBUS_SANDBOX_POLICY_JSON"];
    expect(raw).toBeDefined();
    const parsed = JSON.parse(raw as string) as SandboxPolicy;
    expect(parsed.id).toBe("com.nimbus.test");
    expect(parsed.permissions.network).toEqual(["api.github.com"]);
  });

  test("adds NIMBUS_SANDBOX_CWD env as the per-policy leaf under the root", () => {
    const wrapped = wrapServerSpec(makeSpec(), makeManifest(), "/home/user/sbx");
    expect(wrapped.env["NIMBUS_SANDBOX_CWD"]).toBe(
      sandboxCwdFor("/home/user/sbx", "com.nimbus.test"),
    );
  });

  test("wrapServerSpecInCwd sets the cwd exactly as given", () => {
    const wrapped = wrapServerSpecInCwd(makeSpec(), makeManifest(), "/home/user/exact");
    expect(wrapped.env["NIMBUS_SANDBOX_CWD"]).toBe("/home/user/exact");
  });

  test("wrapServerSpecInCwd's wrapperEnv reaches the wrapper's env, beside the policy wire", () => {
    const wrapped = wrapServerSpecInCwd(makeSpec(), makeManifest(), "/home/user/exact", {
      [SANDBOX_OBSERVATION_FILE_ENV]: "/obs/ext_a.1.deadbeef",
      [SANDBOX_OBSERVATION_LABEL_ENV]: '{"extensionId":"a","version":"1"}',
    });
    expect(wrapped.env[SANDBOX_OBSERVATION_FILE_ENV]).toBe("/obs/ext_a.1.deadbeef");
    expect(wrapped.env[SANDBOX_OBSERVATION_LABEL_ENV]).toBe('{"extensionId":"a","version":"1"}');
    expect(wrapped.env["NIMBUS_SANDBOX_CWD"]).toBe("/home/user/exact");
    // The child's own env is unchanged.
    expect(wrapped.env["GITHUB_PAT"]).toBe("ghp_test");
  });

  test("wrapperEnv overrides a same-named key the child spec tried to set", () => {
    const wrapped = wrapServerSpecInCwd(
      makeSpec({ [SANDBOX_OBSERVATION_FILE_ENV]: "/etc/planted" }),
      makeManifest(),
      "/home/user/exact",
      { [SANDBOX_OBSERVATION_FILE_ENV]: "/obs/real" },
    );
    expect(wrapped.env[SANDBOX_OBSERVATION_FILE_ENV]).toBe("/obs/real");
  });

  test("wrapperEnv refuses any key that is not wrapper-only, so it can never carry a child variable", () => {
    // The forwarder's own wrapper-only keys are refused too: they come only from
    // `sandboxWrapperOnlyEnv()`, so no caller can redirect the helper through this argument.
    for (const key of [
      "PATH",
      "GITHUB_PAT",
      "NIMBUS_SANDBOX_POLICY_JSON",
      "NIMBUS_SANDBOX_CWD",
      "NIMBUS_SANDBOX_HELPER_PATH",
      "XDG_RUNTIME_DIR",
    ]) {
      expect(() =>
        wrapServerSpecInCwd(makeSpec(), makeManifest(), "/home/user/exact", { [key]: "x" }),
      ).toThrow(/wrapper-only/);
    }
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
        NIMBUS_SANDBOX_POLICY_JSON:
          '{"id":"attacker","permissions":{"network":["evil.com"],"filesystem":{"read":[],"write":[]}}}',
        NIMBUS_SANDBOX_CWD: "/etc",
      }),
      makeManifest({ network: ["api.github.com"] }),
      LEGIT_CWD,
    );
    const parsed = JSON.parse(wrapped.env["NIMBUS_SANDBOX_POLICY_JSON"] as string) as SandboxPolicy;
    expect(parsed.id).toBe("com.nimbus.test");
    expect(parsed.permissions.network).toEqual(["api.github.com"]);
    expect(wrapped.env["NIMBUS_SANDBOX_CWD"]).toBe(sandboxCwdFor(LEGIT_CWD, "com.nimbus.test"));
  });
});
