import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";

import { spawnCapture, spawnCaptureInternals } from "./spawn-capture.ts";

/**
 * The load-bearing assertion in this file is the FIRST one: `windowsHide: true` reaches the
 * spawn call. Everything else here is ordinary capture behaviour.
 *
 * It is asserted at the option boundary rather than by observing a window, and that limit is
 * worth stating plainly: proving no window appears needs a detached parent (the Gateway's own
 * shape — a parent WITH a console shares it with the child, so no new window is created either
 * way) plus a visible-window enumeration. A unit test cannot reproduce that, and a probe that
 * tries produces results that look decisive and are not. What this test does prove is that the
 * flag is passed on every call, which is the part the code owns.
 */
function withStub<T>(
  impl: (cmd: string, args: readonly string[], opts: Record<string, unknown>) => unknown,
  fn: () => Promise<T>,
): Promise<T> {
  const real = spawnCaptureInternals.spawn;
  spawnCaptureInternals.spawn = impl as never;
  return fn().finally(() => {
    spawnCaptureInternals.spawn = real;
  });
}

function fakeChild(exitCode: number, stdout = "", stderr = ""): unknown {
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
    if (stderr !== "") proc.stderr.emit("data", Buffer.from(stderr));
    proc.emit("close", exitCode);
  });
  return proc;
}

describe("spawnCapture", () => {
  test("ALWAYS passes windowsHide — the reason this module exists", async () => {
    // The Gateway runs detached, so an unhidden console-subsystem child gets a brand-new console
    // and a visible window. `cloudwatch`/`sagemaker` spawn one CLI per indexed item, so a missing
    // flag here is dozens of windows per sync tick.
    let seen: Record<string, unknown> | undefined;
    await withStub(
      (_c, _a, opts) => {
        seen = opts;
        return fakeChild(0);
      },
      () => spawnCapture(["aws", "lambda", "list-functions"]),
    );
    expect(seen?.["windowsHide"]).toBe(true);
  });

  test("captures stdout and reports ok on exit 0", async () => {
    const r = await withStub(
      () => fakeChild(0, '{"Functions":[]}'),
      () => spawnCapture(["aws", "lambda", "list-functions"]),
    );
    expect(r.ok).toBe(true);
    expect(r.stdout).toBe('{"Functions":[]}');
    expect(r.code).toBe(0);
  });

  test("a non-zero exit is ok:false with stdout still captured", async () => {
    const r = await withStub(
      () => fakeChild(1, "partial"),
      () => spawnCapture(["aws", "x"]),
    );
    expect(r.ok).toBe(false);
    expect(r.stdout).toBe("partial");
  });

  test("a synchronous spawn throw resolves rather than rejecting", async () => {
    // Every call site degrades on `!ok` instead of catching, so a rejection here would turn a
    // handled no-op into an unhandled sync failure.
    const r = await withStub(
      () => {
        throw new Error("ENOENT");
      },
      () => spawnCapture(["definitely-not-a-real-binary"]),
    );
    expect(r.ok).toBe(false);
    expect(r.code).toBeNull();
  });

  test("an empty argv is refused without spawning", async () => {
    let called = false;
    const r = await withStub(
      () => {
        called = true;
        return fakeChild(0);
      },
      () => spawnCapture([]),
    );
    expect(called).toBe(false);
    expect(r.ok).toBe(false);
  });

  test("passes cwd and env through when supplied, and omits them when not", async () => {
    let seen: Record<string, unknown> | undefined;
    await withStub(
      (_c, _a, opts) => {
        seen = opts;
        return fakeChild(0);
      },
      () => spawnCapture(["aws"], { env: { A: "1" }, cwd: "/tmp" }),
    );
    expect(seen?.["env"]).toEqual({ A: "1" });
    expect(seen?.["cwd"]).toBe("/tmp");

    let bare: Record<string, unknown> | undefined;
    await withStub(
      (_c, _a, opts) => {
        bare = opts;
        return fakeChild(0);
      },
      () => spawnCapture(["aws"]),
    );
    expect("env" in (bare ?? {})).toBe(false);
    expect("cwd" in (bare ?? {})).toBe(false);
  });

  test("captures stderr alongside stdout", async () => {
    const r = await withStub(
      () => fakeChild(1, "out", "boom"),
      () => spawnCapture(["aws", "x"]),
    );
    expect(r.stdout).toBe("out");
    expect(r.stderr).toBe("boom");
  });

  test("an async 'error' event (ENOENT: CLI not installed) resolves ok:false", async () => {
    // Distinct from the synchronous throw above: a missing executable is reported by node as an
    // `error` EVENT after spawn returns, not as a throw. Without the listener the promise would
    // never settle and the sync would hang forever rather than degrade.
    const r = await withStub(
      () => {
        const proc = new EventEmitter() as EventEmitter & {
          stdout: EventEmitter;
          stderr: EventEmitter;
          kill: () => void;
        };
        proc.stdout = new EventEmitter();
        proc.stderr = new EventEmitter();
        proc.kill = (): void => {};
        queueMicrotask(() => proc.emit("error", new Error("spawn aws ENOENT")));
        return proc;
      },
      () => spawnCapture(["aws"]),
    );
    expect(r.ok).toBe(false);
    expect(r.code).toBeNull();
  });

  test("timeoutMs kills a child that never closes, resolving ok:false", async () => {
    // A vendor CLI hanging on a network read would otherwise pin the sync forever.
    let killed = false;
    const r = await withStub(
      () => {
        const proc = new EventEmitter() as EventEmitter & {
          stdout: EventEmitter;
          stderr: EventEmitter;
          kill: () => void;
        };
        proc.stdout = new EventEmitter();
        proc.stderr = new EventEmitter();
        proc.kill = (): void => {
          killed = true;
        };
        // Never emits `close` — the hang this option exists for.
        return proc;
      },
      () => spawnCapture(["aws"], { timeoutMs: 20 }),
    );
    expect(killed).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.code).toBeNull();
  });

  test("a close that arrives AFTER the timeout does not overwrite the result", async () => {
    // `done()` is idempotent by design: the timeout already resolved, and a late close must not
    // flip a timed-out call to ok:true.
    let emitClose: (() => void) | undefined;
    const r = await withStub(
      () => {
        const proc = new EventEmitter() as EventEmitter & {
          stdout: EventEmitter;
          stderr: EventEmitter;
          kill: () => void;
        };
        proc.stdout = new EventEmitter();
        proc.stderr = new EventEmitter();
        proc.kill = (): void => {};
        emitClose = () => proc.emit("close", 0);
        return proc;
      },
      () => spawnCapture(["aws"], { timeoutMs: 15 }),
    );
    expect(r.ok).toBe(false);
    emitClose?.();
    expect(r.ok).toBe(false);
  });
});
