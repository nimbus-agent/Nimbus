import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";

import type { SandboxPolicy } from "./sandbox-policy.ts";
import { type ExecFileLike, helperRunner } from "./win32.ts";
import { buildRevokeGrantsArgv, buildSweepArgv } from "./win32-argv.ts";
import { attachGrantRelease, attachGrantReleaseIf, releaseGrantsFor } from "./win32-release.ts";

// NO platform skip: every function here is argv derivation or orchestration over an injected
// `run`, so it executes on the CI-Linux coverage run. The real helper is exercised by
// test/integration/platform/sandbox/win32-ace-release.test.ts on Windows.

function policy(perms: Partial<SandboxPolicy["permissions"]> = {}, id = "exec-e1"): SandboxPolicy {
  return { id, permissions: { network: [], filesystem: { read: [], write: [] }, ...perms } };
}

describe("buildRevokeGrantsArgv", () => {
  it("names the SAME profile the spawn used, then every path the spawn granted", () => {
    const argv = buildRevokeGrantsArgv(
      policy({ filesystem: { read: ["C:\\bun\\bin"], write: ["C:\\work\\out"] } }),
      { cwd: "C:\\work" },
    );
    expect(argv).toEqual([
      "--revoke-grants",
      "--profile",
      "nimbus-ext-exec-e1",
      "--path",
      "C:\\work",
      "--path",
      "C:\\bun\\bin",
      "--path",
      "C:\\work\\out",
    ]);
  });

  it("names a path once even when the policy grants it both read and write", () => {
    // The terminal lane grants its cwd as cwd, read AND write. REVOKE_ACCESS removes every explicit
    // ACE for the SID in one call, so a second pass over the same path is only wasted DACL rewrites.
    const argv = buildRevokeGrantsArgv(
      policy({ filesystem: { read: ["C:\\proj"], write: ["C:\\proj"] } }, "cu-terminal-s1"),
      { cwd: "C:\\proj" },
    );
    expect(argv.filter((a) => a === "--path")).toHaveLength(1);
  });
});

describe("buildSweepArgv", () => {
  it("passes each path as a positional argument", () => {
    expect(buildSweepArgv(["C:\\a", "C:\\b"])).toEqual(["--sweep-orphaned-aces", "C:\\a", "C:\\b"]);
  });
});

describe("releaseGrantsFor", () => {
  it("revokes the grants BEFORE deleting the profile", async () => {
    // Order matters only for tidiness, not correctness — the SID is derived from the name, so a
    // revoke after the delete still works — but revoking first means a delete that fails never
    // leaves grants behind for a profile the reaper would later remove.
    const calls: string[][] = [];
    await releaseGrantsFor(async (argv) => void calls.push(argv), policy(), { cwd: "C:\\w" });
    expect(calls.map((c) => c[0])).toEqual(["--revoke-grants", "--delete-profile"]);
    expect(calls[1]).toEqual(["--delete-profile", "nimbus-ext-exec-e1"]);
  });

  it("still deletes the profile when the revoke fails, and never rejects", async () => {
    const calls: string[][] = [];
    const run = async (argv: string[]): Promise<void> => {
      calls.push(argv);
      if (argv[0] === "--revoke-grants") throw new Error("SetNamedSecurityInfoW: 5");
    };
    await expect(releaseGrantsFor(run, policy(), { cwd: "C:\\w" })).resolves.toBeUndefined();
    expect(calls.map((c) => c[0])).toEqual(["--revoke-grants", "--delete-profile"]);
  });

  it("swallows a failing delete too — cleanup must never surface into the caller", async () => {
    const run = async (): Promise<void> => {
      throw new Error("boom");
    };
    await expect(releaseGrantsFor(run, policy(), { cwd: "C:\\w" })).resolves.toBeUndefined();
  });
});

describe("attachGrantRelease", () => {
  it("releases once, when the child exits — not at attach time", async () => {
    const child = new EventEmitter();
    let released = 0;
    attachGrantRelease(child, async () => {
      released += 1;
    });
    expect(released).toBe(0);
    child.emit("exit", 0, null);
    child.emit("exit", 0, null);
    await Promise.resolve();
    expect(released).toBe(1);
  });

  it("releases on a spawn ERROR as well, and still only once", async () => {
    // `spawn` emits `error` and never `exit` when the executable cannot be launched at all. The
    // helper may still have been partway through granting if it died after starting, and a
    // release of grants that were never made is a harmless no-op, so the error path releases too.
    const child = new EventEmitter();
    let released = 0;
    attachGrantRelease(child, async () => {
      released += 1;
    });
    child.emit("error", new Error("ENOENT"));
    child.emit("exit", null, "SIGTERM");
    await Promise.resolve();
    expect(released).toBe(1);
  });
});

describe("attachGrantReleaseIf", () => {
  it.each([
    ["false", false],
    ["absent", undefined],
  ])(
    "attaches nothing when the option is %s — a shared SID must never be released",
    async (_l, v) => {
      const child = new EventEmitter();
      let released = 0;
      attachGrantReleaseIf(v, child, async () => {
        released += 1;
      });
      expect(child.listenerCount("exit")).toBe(0);
      expect(child.listenerCount("error")).toBe(0);
      child.emit("exit", 0, null);
      await Promise.resolve();
      expect(released).toBe(0);
    },
  );

  it("attaches the release when the option is true", async () => {
    const child = new EventEmitter();
    let released = 0;
    attachGrantReleaseIf(true, child, async () => {
      released += 1;
    });
    child.emit("exit", 0, null);
    await Promise.resolve();
    expect(released).toBe(1);
  });
});

describe("helperRunner", () => {
  // What is under test is the exit-code-to-promise mapping, not the helper, so it runs through an
  // injected `execFile`. It used to spawn the running Bun binary (`-e "process.exit(0)"`), and on
  // the macOS PR leg that spawn, made from inside a `bun test --parallel` worker, never returned:
  // four times on 2026-10-16 this file's other eleven tests passed, these two never reported, no
  // per-test timeout fired, and the whole leg sat until its 1500 s cap (~25 min, then a full
  // retry). The real helper is spawned on Windows by
  // test/integration/platform/sandbox/win32-ace-release.test.ts.
  it("resolves when the process exits 0, running the helper hidden with the argv given", async () => {
    const calls: Array<{ file: string; args: readonly string[]; hidden: boolean }> = [];
    const execFileImpl: ExecFileLike = (file, args, options, callback) => {
      calls.push({ file, args, hidden: options.windowsHide });
      callback(null);
    };
    await expect(helperRunner("helper.exe", execFileImpl)(["--revoke-grants", "p"])).resolves.toBe(
      undefined,
    );
    expect(calls).toEqual([{ file: "helper.exe", args: ["--revoke-grants", "p"], hidden: true }]);
  });

  it("rejects when the process exits non-zero, so releaseGrantsFor can tell a failure", async () => {
    const execFileImpl: ExecFileLike = (_file, _args, _options, callback) => {
      callback(Object.assign(new Error("Command failed: helper.exe"), { code: 3 }));
    };
    await expect(helperRunner("helper.exe", execFileImpl)([])).rejects.toThrow("Command failed");
  });

  it("defaults to node's execFile without spawning anything until it is called", () => {
    // Building the runner must not spawn: production builds one per sandboxed child and calls it
    // only when that child exits.
    expect(typeof helperRunner("helper.exe")).toBe("function");
  });
});
