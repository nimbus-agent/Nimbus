import { describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxPolicy } from "../../platform/sandbox/sandbox-policy.ts";
import type { SandboxRunner } from "../../platform/sandbox/sandbox-runner.ts";
import {
  assertTerminalLaunchable,
  buildTerminalLaunchPolicy,
  CuLaunchPolicyError,
} from "./terminal-launch.ts";
import { DEFAULT_SHELL_ID, resolveShellById } from "./terminal-shells.ts";

const shell = resolveShellById(DEFAULT_SHELL_ID);
const cwd = join(tmpdir(), "cu-launch-fixture");
const base = { sessionId: "s1", shell, shellPath: join(tmpdir(), "fake-shell"), cwd };

function runnerWith(
  canConfine: (p: SandboxPolicy) => string | null,
  platform: SandboxRunner["platform"] = "linux",
): SandboxRunner {
  return {
    platform,
    spawn: () => {
      throw new Error("this runner is assertion-only");
    },
    isFullyActive: () => true,
    degradedReason: () => null,
    canConfine,
  } as unknown as SandboxRunner & { spawn: () => ChildProcess };
}

describe("buildTerminalLaunchPolicy", () => {
  test("permissions.network is empty BY CONSTRUCTION", () => {
    expect(buildTerminalLaunchPolicy(base).policy.permissions.network).toEqual([]);
  });

  // The property that makes § 6.2's zero-egress claim true rather than customary: a caller asking
  // for network is REFUSED, not silently dropped. Dropping would let a future caller believe it had
  // been granted something.
  test("REJECTS a requested network grant rather than dropping it", () => {
    expect(() => buildTerminalLaunchPolicy({ ...base, network: ["example.com"] })).toThrow(
      CuLaunchPolicyError,
    );
  });

  test("an empty requested network array is fine (it asks for nothing)", () => {
    expect(() => buildTerminalLaunchPolicy({ ...base, network: [] })).not.toThrow();
  });

  test("cwd is the only filesystem grant, for read and for write", () => {
    const p = buildTerminalLaunchPolicy(base).policy;
    expect(p.permissions.filesystem.write).toEqual([cwd]);
    expect(p.permissions.filesystem.read).toEqual([cwd]);
  });

  test("refuses a relative cwd rather than resolving it", () => {
    expect(() => buildTerminalLaunchPolicy({ ...base, cwd: "relative/dir" })).toThrow(
      CuLaunchPolicyError,
    );
  });

  test("refuses a relative shell path — PATH must not choose the interpreter", () => {
    expect(() => buildTerminalLaunchPolicy({ ...base, shellPath: "sh" })).toThrow(
      CuLaunchPolicyError,
    );
  });

  test("argv comes from the registry, and the shell path is carried verbatim", () => {
    const p = buildTerminalLaunchPolicy(base);
    expect(p.argv).toEqual([...shell.argv()]);
    expect(p.shellPath).toBe(base.shellPath);
    expect(p.shellId).toBe(shell.id);
  });

  test("argv is a COPY — mutating the caller's array cannot change what spawns", () => {
    const p = buildTerminalLaunchPolicy(base);
    const argv = p.argv as string[];
    expect(() => argv.push("--evil")).not.toThrow();
    // The registry's own array is untouched, so a second build is unaffected.
    expect(buildTerminalLaunchPolicy(base).argv).toEqual([...shell.argv()]);
  });

  test("the policy id is namespaced per session", () => {
    expect(buildTerminalLaunchPolicy(base).policy.id).toBe("cu-terminal-s1");
  });
});

describe("assertTerminalLaunchable", () => {
  test("passes through canConfine's verdict, over the policy that will actually spawn", () => {
    const seen: SandboxPolicy[] = [];
    const policy = buildTerminalLaunchPolicy(base);
    const runner = runnerWith((p) => {
      seen.push(p);
      return null;
    });
    expect(assertTerminalLaunchable(runner)(policy)).toBeNull();
    // The object asserted must BE the policy the driver spawns with, not a rebuild of it. This is
    // the exact defect the browser lane's former `browserLanePolicy()` had: it asserted a
    // placeholder nothing ever launched with.
    expect(seen[0]).toBe(policy.policy);
  });

  test("surfaces the reason when the runner cannot confine", () => {
    const runner = runnerWith(() => "nimbus-sandbox-helper.exe not found", "win32");
    expect(assertTerminalLaunchable(runner)(buildTerminalLaunchPolicy(base))).toBe(
      "nimbus-sandbox-helper.exe not found",
    );
  });
});

describe("buildTerminalLaunchPolicy — path traversal", () => {
  test("REFUSES an absolute cwd containing a .. segment", () => {
    // Absolute is not enough. `/home/me/project/../../etc` is absolute, and the grant would cover
    // the RESOLVED directory while the consent prompt displayed the unresolved string — the owner
    // approving one directory and the sandbox binding another.
    expect(() => buildTerminalLaunchPolicy({ ...base, cwd: "/home/me/project/../../etc" })).toThrow(
      CuLaunchPolicyError,
    );
  });

  test("REFUSES a Windows-style traversal too", () => {
    expect(() => buildTerminalLaunchPolicy({ ...base, cwd: "C:Usersme....Windows" })).toThrow(
      CuLaunchPolicyError,
    );
  });

  test("a directory whose NAME merely contains dots is fine", () => {
    // The check is on path SEGMENTS, not on the substring: refusing `my..dir` would be a bug.
    expect(() =>
      buildTerminalLaunchPolicy({ ...base, cwd: join(tmpdir(), "my..dir") }),
    ).not.toThrow();
    expect(() =>
      buildTerminalLaunchPolicy({ ...base, cwd: join(tmpdir(), "..hidden") }),
    ).not.toThrow();
  });
});
