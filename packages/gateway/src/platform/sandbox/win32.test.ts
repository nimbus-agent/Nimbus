import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalPath } from "./canonical-path.ts";
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

// The probe's "a helper IS present" arms. Same reasoning as the file-header comment: nothing here
// needs Windows, only a file at NIMBUS_SANDBOX_HELPER_PATH that answers `--check-caps`. The cases
// that need a real executable stand-in are `skipIf(win32)` — skipped on WINDOWS, not on Linux —
// so they still run, and still count, on the CI-Linux-authoritative coverage run.
describe("createWin32SandboxRunner — helper probe outcomes", () => {
  let tmp: string;
  let origHelperPath: string | undefined;

  /** Executable POSIX stand-in for nimbus-sandbox-helper.exe. */
  function installFakeHelper(body: string): string {
    const helper = join(tmp, "fake-sandbox-helper");
    writeFileSync(helper, `#!/bin/sh\n${body}`);
    chmodSync(helper, 0o755);
    process.env["NIMBUS_SANDBOX_HELPER_PATH"] = helper;
    return helper;
  }

  beforeEach(() => {
    // Fresh mkdtemp per test, removed by its own full path — never the Nimbus config/data dirs.
    tmp = mkdtempSync(join(tmpdir(), "nimbus-sandbox-win32-probe-"));
    origHelperPath = process.env["NIMBUS_SANDBOX_HELPER_PATH"];
  });

  afterEach(() => {
    if (origHelperPath === undefined) delete process.env["NIMBUS_SANDBOX_HELPER_PATH"];
    else process.env["NIMBUS_SANDBOX_HELPER_PATH"] = origHelperPath;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("refuses a helper that exits 0 but does not answer exactly OK", () => {
    // process.execPath is the bun binary running this test: it exists, and it answers an
    // unrecognised flag with its own help text on stdout and a 0 exit. Present-but-wrong is
    // precisely the shape this arm has to reject — a truthy exit is not a capability check.
    process.env["NIMBUS_SANDBOX_HELPER_PATH"] = process.execPath;
    const runner = createWin32SandboxRunner();
    expect(runner.isFullyActive()).toBe(false);
    expect(runner.degradedReason()).toContain("cannot create an AppContainer profile");
    expect(runner.degradedReason()).toContain("<no stderr>");
  });

  it.skipIf(process.platform === "win32")(
    "surfaces the helper's own stderr when the capability check fails",
    () => {
      installFakeHelper('echo "AppContainer creation denied by policy" >&2\nexit 1\n');
      const reason = createWin32SandboxRunner().degradedReason();
      expect(reason).toContain("cannot create an AppContainer profile");
      expect(reason).toContain("AppContainer creation denied by policy");
      expect(reason).not.toContain("<no stderr>");
    },
  );

  it.skipIf(process.platform === "win32")(
    "reports <no stderr> when the helper cannot be executed at all",
    () => {
      // Exists, so the not-found arm is skipped, but is not executable: spawnSync comes back with
      // an error and NULL stdio rather than a status, which the `?? \"\"` fallback has to absorb.
      const helper = join(tmp, "not-executable");
      writeFileSync(helper, "not a program");
      chmodSync(helper, 0o644);
      process.env["NIMBUS_SANDBOX_HELPER_PATH"] = helper;

      const runner = createWin32SandboxRunner();
      expect(runner.isFullyActive()).toBe(false);
      expect(runner.degradedReason()).toContain("<no stderr>");
    },
  );

  it.skipIf(process.platform === "win32")(
    "goes fully active when the helper answers OK, and still discloses the network asymmetry",
    () => {
      installFakeHelper('[ "$1" = "--check-caps" ] && echo OK\nexit 0\n');
      const runner = createWin32SandboxRunner();
      expect(runner.isFullyActive()).toBe(true);
      // Fully active is NOT undegraded: per-host network filtering stays all-or-nothing.
      expect(runner.degradedReason()).toContain("per-host network filtering is all-or-nothing");
    },
  );

  it.skipIf(process.platform === "win32")(
    "spawns THROUGH the helper, passing the derived argv ahead of the child command",
    async () => {
      const argvOut = join(tmp, "argv.txt");
      installFakeHelper(
        [
          'if [ "$1" = "--check-caps" ]; then',
          "  echo OK",
          "  exit 0",
          "fi",
          ': > "$ARGV_OUT"',
          'for a in "$@"; do printf \'%s\\n\' "$a" >> "$ARGV_OUT"; done',
          "exit 0",
        ].join("\n"),
      );
      const cwd = join(tmp, "ext-cwd");
      mkdirSync(cwd);

      const runner = createWin32SandboxRunner();
      const child = runner.spawn("child-cmd", ["--grant-read", "x"], {
        policy: policy({ network: ["api.github.com"] }),
        env: { ARGV_OUT: argvOut, PATH: process.env["PATH"] ?? "" },
        cwd,
      });
      await new Promise<void>((res) => child.on("close", () => res()));

      // The bare `--` is load-bearing: without it the child's own `--grant-read` would be
      // re-parsed by the helper as one of ITS flags.
      expect(readFileSync(argvOut, "utf8").split("\n").slice(0, -1)).toEqual([
        "--profile",
        "nimbus-ext-com.nimbus.test",
        "--cwd",
        // `canonicalPath`, not the raw `cwd`: the runner canonicalises via `realpathSync.native`
        // before handing the path to the helper, and on macOS `/var/folders/...` resolves to
        // `/private/var/folders/...` — the same symlink case `canonical-path.ts` documents. This
        // suite is a unit test of the Windows argv construction and runs on every platform, so
        // asserting the raw path made it fail on macOS only. Calling the SAME helper production
        // calls is what stops the expectation drifting from the behaviour again.
        canonicalPath(cwd),
        "--capability",
        "internetClient",
        "--",
        "child-cmd",
        "--grant-read",
        "x",
      ]);
    },
  );
});
