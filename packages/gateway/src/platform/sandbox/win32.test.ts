import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionManifest } from "../../extensions/manifest.ts";
import { capabilitiesForManifest, createWin32SandboxRunner, profileNameFor } from "./win32.ts";

// NO `describe.skipIf(process.platform !== "win32")` here — deliberately.
// `win32.ts` contains no OS-dependent code and no FFI import: the AppContainer
// profile name + capability list are pure string/array derivation, and the
// runner returned by `createWin32SandboxRunner()` throws / returns constants
// without touching Windows. Gating this file on the host platform made it read
// 0% on the CI-Linux-authoritative coverage run, which is what put it on the
// coverage-floor exclusion list. Re-add a skip ONLY for a case that genuinely
// calls into Windows (i.e. when the CreateProcessAsUserW FFI binding lands).

// Real, unique temp root for the fake spawn cwd (S5443). `spawn` throws before
// touching the filesystem — this path is never written to. It is still removed in
// afterAll: mkdtempSync creates the directory for real, and a suite that never
// reclaims it leaves one behind per run (see the temp-dir leak audit, #972/#973).
const TMP_ROOT = mkdtempSync(join(tmpdir(), "nimbus-sandbox-win32-test-"));
afterAll(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

function manifest(perms: Partial<ExtensionManifest["permissions"]> = {}): ExtensionManifest {
  return {
    id: "com.nimbus.test",
    version: "1.0.0",
    entrypoint: "x.js",
    runtime: "bun",
    permissions: { network: [], filesystem: { read: [], write: [] }, ...perms },
    updateChannel: "stable",
  } as ExtensionManifest;
}

describe("win32 sandbox", () => {
  it("derives the profile name from the extension id", () => {
    expect(profileNameFor({ id: "com.nimbus.github" })).toBe("nimbus-ext-com.nimbus.github");
  });

  it("returns internetClient capability when permissions.network is non-empty", () => {
    const caps = capabilitiesForManifest(manifest({ network: ["api.github.com"] }));
    expect(caps).toContain("internetClient");
  });

  it("returns empty capability list when permissions.network is empty", () => {
    const caps = capabilitiesForManifest(manifest());
    expect(caps).toEqual([]);
  });

  it("grants internetClient exactly once regardless of how many hosts are declared", () => {
    const caps = capabilitiesForManifest(
      manifest({ network: ["api.github.com", "gitlab.com", "slack.com"] }),
    );
    expect(caps).toEqual(["internetClient"]);
  });
});

describe("createWin32SandboxRunner", () => {
  it("reports the win32 platform tag", () => {
    expect(createWin32SandboxRunner().platform).toBe("win32");
  });

  it("fails closed: spawn throws instead of running the extension unsandboxed", () => {
    const runner = createWin32SandboxRunner();
    expect(() =>
      runner.spawn("bun", ["x.js"], {
        manifest: manifest(),
        env: {},
        cwd: join(TMP_ROOT, "ext-cwd"),
      }),
    ).toThrow(/CreateProcessAsUserW FFI binding lands/);
  });

  it("reports itself as not fully active (I15 degradation must stay visible)", () => {
    expect(createWin32SandboxRunner().isFullyActive()).toBe(false);
  });

  it("explains the degradation instead of returning null", () => {
    const reason = createWin32SandboxRunner().degradedReason();
    expect(reason).not.toBeNull();
    expect(reason).toContain("per-host network filtering is degraded");
  });
});
