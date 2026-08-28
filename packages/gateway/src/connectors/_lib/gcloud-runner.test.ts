import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { spawnCaptureInternals } from "../../platform/spawn-capture.ts";

import { runGcloudCommand } from "./gcloud-runner.ts";

type CaptureSpawn = typeof spawnCaptureInternals.spawn;

const realSpawn = spawnCaptureInternals.spawn;
afterEach(() => {
  spawnCaptureInternals.spawn = realSpawn;
});

/** Replace the spawn seam with a fake; returns the captured argv + env. */
function stubSpawn(
  impl: (
    argv: string[],
    opts: { env: Record<string, string> },
  ) => {
    exitCode: number;
    stdout: string;
  },
): { calls: { argv: string[]; env: Record<string, string> }[] } {
  const calls: { argv: string[]; env: Record<string, string> }[] = [];
  spawnCaptureInternals.spawn = ((
    cmd: string,
    args: readonly string[],
    opts?: { env?: Record<string, string> },
  ) => {
    const argv = [cmd, ...args];
    const env = opts?.env ?? {};
    calls.push({ argv, env });
    const r = impl(argv, { env });
    return fakeChild(r.exitCode, r.stdout);
  }) as unknown as CaptureSpawn;
  return { calls };
}

describe("runGcloudCommand", () => {
  test("returns ok + stdout text on exit code 0", async () => {
    stubSpawn(() => ({ exitCode: 0, stdout: '[{"a":1}]' }));
    const res = await runGcloudCommand(["gcloud", "logging", "sinks", "list"], "/creds.json");
    expect(res.ok).toBe(true);
    expect(res.text).toBe('[{"a":1}]');
  });

  test("returns ok:false on a non-zero exit code (text still captured)", async () => {
    stubSpawn(() => ({ exitCode: 1, stdout: "boom" }));
    const res = await runGcloudCommand(["gcloud", "ai", "models", "list"], "/creds.json");
    expect(res.ok).toBe(false);
    expect(res.text).toBe("boom");
  });

  test("passes the argv through and scopes GOOGLE_APPLICATION_CREDENTIALS into the env (I1)", async () => {
    const { calls } = stubSpawn(() => ({ exitCode: 0, stdout: "[]" }));
    await runGcloudCommand(["gcloud", "x"], "/path/to/creds.json");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.argv).toEqual(["gcloud", "x"]);
    expect(calls[0]!.env["GOOGLE_APPLICATION_CREDENTIALS"]).toBe("/path/to/creds.json");
  });

  test("degrades to { ok:false, text:'' } when spawn throws (gcloud missing)", async () => {
    // The handling lives in `spawnCapture` now, not in a local try/catch here — that catch was
    // deleted as unreachable. This asserts the contract still holds through the seam.
    stubSpawn(() => {
      throw new Error("ENOENT: gcloud not found");
    });
    const res = await runGcloudCommand(["gcloud", "x"], "/creds.json");
    expect(res).toEqual({ ok: false, text: "" });
  });
});

/**
 * A `node:child_process` stand-in. The connector CLI runners moved off `Bun.spawn` to
 * `platform/spawn-capture.ts`, which spawns with `windowsHide` — the Gateway runs detached, so an
 * unhidden child pops a console window on every sync tick. These tests stub the seam that module
 * exports rather than `Bun.spawn`, which it no longer uses.
 */
function fakeChild(exitCode: number, stdout: string): unknown {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => void;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = (): void => {};
  queueMicrotask(() => {
    if (stdout !== "") proc.stdout.emit("data", Buffer.from(stdout));
    proc.emit("close", exitCode);
  });
  return proc;
}
