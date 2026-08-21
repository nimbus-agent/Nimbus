import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SandboxPolicy } from "./sandbox-policy.ts";
import { capabilitiesForPolicy, createWin32SandboxRunner, profileNameFor } from "./win32.ts";

// NO `describe.skipIf(process.platform !== "win32")` here — deliberately.
// `win32.ts` calls only cross-platform Node APIs (`existsSync`, `spawnSync`) to probe for the
// helper binary, never a Windows-only FFI: on a non-Windows CI runner the probe simply finds no
// `nimbus-sandbox-helper.exe` and takes the same "unavailable" branch a real Windows box takes
// when the helper is missing. The AppContainer profile name + capability list are pure
// string/array derivation. Gating this file on the host platform made it read 0% on the
// CI-Linux-authoritative coverage run, which is what put it on the coverage-floor exclusion
// list. Re-add a skip ONLY for a case that requires the helper to actually be present and
// runnable (the `helper.available === true` branch), which no CI runner can exercise.

// Real, unique temp root for the fake spawn cwd (S5443). `spawn` throws before
// touching the filesystem — this path is never written to. It is still removed in
// afterAll: mkdtempSync creates the directory for real, and a suite that never
// reclaims it leaves one behind per run (see the temp-dir leak audit, #972/#973).
const TMP_ROOT = mkdtempSync(join(tmpdir(), "nimbus-sandbox-win32-test-"));
afterAll(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

function policy(perms: Partial<SandboxPolicy["permissions"]> = {}): SandboxPolicy {
  return {
    id: "com.nimbus.test",
    permissions: { network: [], filesystem: { read: [], write: [] }, ...perms },
  };
}

describe("win32 sandbox", () => {
  it("derives the profile name from the extension id", () => {
    expect(profileNameFor({ id: "com.nimbus.github" })).toBe("nimbus-ext-com.nimbus.github");
  });

  it("returns internetClient capability when permissions.network is non-empty", () => {
    const caps = capabilitiesForPolicy(policy({ network: ["api.github.com"] }));
    expect(caps).toContain("internetClient");
  });

  it("returns empty capability list when permissions.network is empty", () => {
    const caps = capabilitiesForPolicy(policy());
    expect(caps).toEqual([]);
  });

  it("grants internetClient exactly once regardless of how many hosts are declared", () => {
    const caps = capabilitiesForPolicy(
      policy({ network: ["api.github.com", "gitlab.com", "slack.com"] }),
    );
    expect(caps).toEqual(["internetClient"]);
  });
});

describe("createWin32SandboxRunner", () => {
  it("reports the win32 platform tag", () => {
    expect(createWin32SandboxRunner().platform).toBe("win32");
  });

  it("still fails closed when the helper is absent — never spawns unconfined", () => {
    const prev = process.env["NIMBUS_SANDBOX_HELPER_PATH"];
    process.env["NIMBUS_SANDBOX_HELPER_PATH"] = join(TMP_ROOT, "definitely-not-here.exe");
    try {
      const runner = createWin32SandboxRunner();
      expect(runner.isFullyActive()).toBe(false);
      expect(runner.degradedReason()).toContain("not found");
      expect(() =>
        runner.spawn("bun", ["x.js"], {
          policy: policy(),
          env: {},
          cwd: join(TMP_ROOT, "ext-cwd"),
        }),
      ).toThrow(/refusing to spawn unsandboxed/);
    } finally {
      if (prev === undefined) delete process.env["NIMBUS_SANDBOX_HELPER_PATH"];
      else process.env["NIMBUS_SANDBOX_HELPER_PATH"] = prev;
    }
  });

  it("reports itself as not fully active when the default helper path has nothing at it", () => {
    // No NIMBUS_SANDBOX_HELPER_PATH override here: the default is derived from
    // process.execPath (the bun binary running this test), which never has
    // nimbus-sandbox-helper.exe next to it, so this exercises the same "probe found nothing"
    // path as CI without needing the override.
    expect(createWin32SandboxRunner().isFullyActive()).toBe(false);
  });

  it("explains the degradation instead of returning null", () => {
    const reason = createWin32SandboxRunner().degradedReason();
    expect(reason).not.toBeNull();
    expect(reason).toContain("not found");
  });
});
