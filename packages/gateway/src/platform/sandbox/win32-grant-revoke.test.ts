import { describe, expect, test } from "bun:test";

import {
  appContainerGrantRevokerFor,
  type ExecFileExitLike,
  execHelperForExitCode,
  type HelperExitRun,
  REVOKE_HELPER_TIMEOUT_MS,
  REVOKE_PATHS_PER_RUN,
  revokeAppContainerGrants,
} from "./win32-grant-revoke.ts";

// NO platform skip: argv derivation and orchestration over an injected runner, so this executes on
// every OS. The real helper is exercised on Windows by the B5 integration test.

function recordingRun(codes: number[] = []): {
  run: HelperExitRun;
  calls: Array<{ path: string; argv: readonly string[] }>;
} {
  const calls: Array<{ path: string; argv: readonly string[] }> = [];
  return {
    calls,
    run: (path, argv) => {
      calls.push({ path, argv });
      return Promise.resolve(codes.shift() ?? 0);
    },
  };
}

describe("revokeAppContainerGrants", () => {
  test("revokes the policy's profile on every path, in order, in one helper run", async () => {
    const { run, calls } = recordingRun();
    await revokeAppContainerGrants(run, "C:\\h.exe", "com.nimbus.obsidian", ["C:\\n", "C:\\n\\v"]);
    expect(calls).toEqual([
      {
        path: "C:\\h.exe",
        argv: [
          "--revoke-grants",
          "--profile",
          "nimbus-ext-com.nimbus.obsidian",
          "--path",
          "C:\\n",
          "--path",
          "C:\\n\\v",
        ],
      },
    ]);
  });

  test("a non-zero helper exit THROWS (fail closed), naming the policy, never the paths", async () => {
    const { run } = recordingRun([1]);
    const err = await revokeAppContainerGrants(run, "h", "com.nimbus.obsidian", ["C:\\n"]).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(
      "revoking the com.nimbus.obsidian sandbox grants failed (helper exit 1)",
    );
  });

  test("a helper that cannot run rejects", async () => {
    const run: HelperExitRun = () => Promise.reject(new Error("ENOENT"));
    await expect(revokeAppContainerGrants(run, "h", "p", ["C:\\n"])).rejects.toThrow("ENOENT");
  });

  test("no paths: no helper run", async () => {
    const { run, calls } = recordingRun();
    await revokeAppContainerGrants(run, "h", "p", []);
    expect(calls).toEqual([]);
  });

  test("a long list is split below the helper's 256-path limit; a later failing chunk still throws", async () => {
    const paths = Array.from({ length: REVOKE_PATHS_PER_RUN + 3 }, (_, i) => `C:\\p${i}`);
    const { run, calls } = recordingRun([0, 66]);
    await expect(revokeAppContainerGrants(run, "h", "p", paths)).rejects.toThrow("helper exit 66");
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.argv.filter((a) => a === "--path").length)).toEqual([
      REVOKE_PATHS_PER_RUN,
      3,
    ]);
    expect(REVOKE_PATHS_PER_RUN).toBeLessThan(256);
  });
});

describe("execHelperForExitCode", () => {
  test("exit 0 resolves 0, a numeric exit code resolves to it, and the spawn is hidden", async () => {
    const seen: Array<{ windowsHide: boolean; timeout: number; killSignal: string }> = [];
    const outcomes: Array<(Error & { code?: unknown }) | null> = [
      null,
      Object.assign(new Error("exit"), { code: 1 }),
    ];
    const impl: ExecFileExitLike = (_f, _a, options, cb) => {
      seen.push(options);
      cb(outcomes.shift() ?? null);
      return undefined;
    };
    const run = execHelperForExitCode(impl);
    expect(await run("h", ["--x"])).toBe(0);
    expect(await run("h", ["--x"])).toBe(1);
    const opts = { windowsHide: true, timeout: REVOKE_HELPER_TIMEOUT_MS, killSignal: "SIGKILL" };
    expect(seen).toEqual([opts, opts]);
    expect(REVOKE_HELPER_TIMEOUT_MS).toBeGreaterThan(120_000);
  });

  // DI only: a real hung child through node:child_process inside a macOS --parallel worker can
  // lose its exit (oven-sh/bun#41024). Node's execFile sets `killed: true` when its timeout fires.
  test("a run killed by the timeout REJECTS (fail closed), even though it carries an exit code", async () => {
    const impl: ExecFileExitLike = (_f, _a, o, cb) => {
      expect(o).toEqual({ windowsHide: true, timeout: 50, killSignal: "SIGKILL" });
      cb(Object.assign(new Error("killed"), { code: 1, killed: true }));
      return undefined;
    };
    await expect(execHelperForExitCode(impl, 50)("h", [])).rejects.toThrow(
      "did not finish within 50 ms",
    );
  });

  test("an error without a numeric code (helper missing) rejects", async () => {
    const impl: ExecFileExitLike = (_f, _a, _o, cb) => {
      cb(Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
      return undefined;
    };
    await expect(execHelperForExitCode(impl)("h", [])).rejects.toThrow("spawn ENOENT");
  });
});

describe("appContainerGrantRevokerFor", () => {
  test("off win32 it is inert: the runner is never called", async () => {
    for (const platform of ["linux", "darwin"] as const) {
      const { run, calls } = recordingRun([1]);
      const r = appContainerGrantRevokerFor(platform, "com.nimbus.obsidian", { run });
      expect(r.active).toBe(false);
      await r.revoke(["/n"]);
      expect(calls).toEqual([]);
    }
  });

  test("on win32 it revokes through the injected helper path and runner, and fails closed", async () => {
    const { run, calls } = recordingRun([0, 1]);
    const r = appContainerGrantRevokerFor("win32", "com.nimbus.obsidian", {
      run,
      helperPath: () => "C:\\bin\\nimbus-sandbox-helper.exe",
    });
    expect(r.active).toBe(true);
    await r.revoke(["C:\\n"]);
    await expect(r.revoke(["C:\\n"])).rejects.toThrow("helper exit 1");
    expect(calls.map((c) => c.path)).toEqual([
      "C:\\bin\\nimbus-sandbox-helper.exe",
      "C:\\bin\\nimbus-sandbox-helper.exe",
    ]);
  });
});

describe("the defaults (no helper runs)", () => {
  test("execHelperForExitCode builds a runner from node's execFile without running anything", () => {
    expect(typeof execHelperForExitCode()).toBe("function");
  });

  test("a win32 revoker with no options uses the production helper path and runner", () => {
    // Building it resolves the defaults; nothing runs until revoke() is called.
    const revoker = appContainerGrantRevokerFor("win32", "obsidian");
    expect(revoker.active).toBe(true);
    expect(typeof revoker.revoke).toBe("function");
  });

  test("an empty slot in the path list ends the batch without a helper run", async () => {
    const { run, calls } = recordingRun();
    // A sparse array: `first` is undefined, which the guard treats as the end of the list.
    await revokeAppContainerGrants(run, "C:h.exe", "obsidian", new Array<string>(1));
    expect(calls).toHaveLength(0);
  });
});
