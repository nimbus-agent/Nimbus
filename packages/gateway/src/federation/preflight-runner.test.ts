import { expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
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
