import { expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { isAbsolute } from "node:path";
import type { SandboxRunner } from "../platform/sandbox/index.ts";
import { runPreflightCommand } from "./preflight-runner.ts";

function fakeChild(exitCode: number, delayMs = 0): ChildProcess {
  const ee = new EventEmitter() as EventEmitter & { kill: () => void };
  let killed = false;
  ee.kill = () => {
    killed = true;
  };
  if (delayMs === 0) {
    queueMicrotask(() => ee.emit("exit", exitCode));
  } else {
    setTimeout(() => {
      if (!killed) ee.emit("exit", exitCode);
    }, delayMs).unref?.();
  }
  return ee as unknown as ChildProcess;
}

function fakeRunner(spawn: SandboxRunner["spawn"]): () => Promise<SandboxRunner> {
  return async () => ({
    platform: "linux",
    isFullyActive: () => true,
    degradedReason: () => null,
    canConfine: () => null,
    spawn,
  });
}

const cfg = { command: "bun", args: ["test"], cwd: "/srv/x", timeoutSeconds: 1 };

test("exit 0 → passed, env carries ref + surface", async () => {
  let seenEnv: Record<string, string> = {};
  const r = await runPreflightCommand(
    cfg,
    { ref: "HEAD", changedSurface: ["a.ts", "b.ts"] },
    {
      createRunner: fakeRunner((_cmd, _args, opts) => {
        seenEnv = opts.env;
        return fakeChild(0);
      }),
      now: () => 0,
    },
  );
  expect(r.passed).toBe(true);
  expect(seenEnv["NIMBUS_PREFLIGHT_REF"]).toBe("HEAD");
  expect(seenEnv["NIMBUS_PREFLIGHT_SURFACE"]).toBe("a.ts,b.ts");
});

test("non-zero exit → not passed", async () => {
  const r = await runPreflightCommand(
    cfg,
    { ref: "HEAD", changedSurface: [] },
    { createRunner: fakeRunner(() => fakeChild(1)), now: () => 0 },
  );
  expect(r.passed).toBe(false);
  expect(r.summary).toContain("failed");
});

test("timeout kills the process and reports timed out", async () => {
  let killed = false;
  const r = await runPreflightCommand(
    { ...cfg, timeoutSeconds: 0.05 },
    { ref: "HEAD", changedSurface: [] },
    {
      createRunner: fakeRunner(() => {
        const c = fakeChild(0, 10_000) as ChildProcess & { kill: () => void };
        const origKill = c.kill.bind(c);
        c.kill = () => {
          killed = true;
          origKill();
          return true;
        };
        return c;
      }),
      now: () => 0,
    },
  );
  expect(r.passed).toBe(false);
  expect(r.summary).toContain("timed out");
  expect(killed).toBe(true);
});

test("spawn throwing → could not run", async () => {
  const r = await runPreflightCommand(
    cfg,
    { ref: "HEAD", changedSurface: [] },
    {
      createRunner: fakeRunner(() => {
        throw new Error("boom");
      }),
      now: () => 0,
    },
  );
  expect(r.passed).toBe(false);
  expect(r.summary).toContain("could not run");
});

test("a null exit code is coerced to 0 → passed", async () => {
  const r = await runPreflightCommand(
    cfg,
    { ref: "HEAD", changedSurface: [] },
    {
      // emit the exit INSIDE the spawn thunk (after createRunner resolved) so the listener
      // attached by awaitExit is already in place — mirrors fakeChild's scheduling.
      createRunner: fakeRunner(() => {
        const ee = new EventEmitter() as EventEmitter & { kill: () => void };
        ee.kill = () => {};
        queueMicrotask(() => ee.emit("exit", null));
        return ee as unknown as ChildProcess;
      }),
      now: () => 0,
    },
  );
  expect(r.passed).toBe(true);
  expect(r.summary).toBe("passed");
});

test("a relative cwd is resolved to an absolute sandbox root", async () => {
  let seenCwd = "";
  const r = await runPreflightCommand(
    { command: "bun", args: ["test"], cwd: "rel/dir", timeoutSeconds: 1 },
    { ref: "HEAD", changedSurface: [] },
    {
      createRunner: fakeRunner((_cmd, _args, opts) => {
        seenCwd = opts.cwd;
        return fakeChild(0);
      }),
      now: () => 0,
    },
  );
  expect(r.passed).toBe(true);
  expect(isAbsolute(seenCwd)).toBe(true);
  expect(seenCwd.replaceAll("\\", "/")).toContain("rel/dir");
});

test("omitting deps.now falls back to the real clock and reports a non-negative duration", async () => {
  // tiny timeoutSeconds → the awaitExit safety timer is ~10ms (and cleared on the immediate
  // microtask exit), avoiding a long-lived unref'd timer that spins `bun test` on Windows.
  const r = await runPreflightCommand(
    { command: "bun", args: ["test"], cwd: "/srv/x", timeoutSeconds: 0.01 },
    { ref: "HEAD", changedSurface: [] },
    { createRunner: fakeRunner(() => fakeChild(0)) },
  );
  expect(r.passed).toBe(true);
  expect(r.durationMs).toBeGreaterThanOrEqual(0);
});
