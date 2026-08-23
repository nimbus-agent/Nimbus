import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { SandboxPolicy } from "../platform/sandbox/sandbox-policy.ts";
import type { SandboxRunner } from "../platform/sandbox/sandbox-runner.ts";
import { runConfined } from "./exec-run.ts";

const POLICY: SandboxPolicy = {
  id: "exec-t",
  permissions: { network: [], filesystem: { read: [], write: [] } },
};

interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  kill: (sig?: string) => boolean;
  killed: string[];
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = [];
  child.kill = (sig = "SIGTERM") => {
    child.killed.push(sig);
    // A real killed child still emits "close"; the fake must too, or the promise never settles.
    if (sig === "SIGTERM") queueMicrotask(() => child.emit("close", null));
    return true;
  };
  return child;
}

function fakeRunner(child: FakeChild): SandboxRunner {
  return {
    platform: process.platform as "linux" | "darwin" | "win32",
    spawn: () => child as never,
    isFullyActive: () => true,
    degradedReason: () => null,
    canConfine: () => null,
  };
}

const BASE = { policy: POLICY, cwd: "/tmp", maxOutputBytes: 1024, maxWallClockMs: 5000 };

describe("runConfined", () => {
  test("captures output and reports a clean exit", async () => {
    const child = fakeChild();
    const p = runConfined(fakeRunner(child), "bun", ["run", "s.ts"], BASE);
    child.stdout.write("hello");
    child.stderr.write("warn");
    child.emit("close", 0);
    const r = await p;
    expect(r.stdout).toBe("hello");
    expect(r.stderr).toBe("warn");
    expect(r.exitCode).toBe(0);
    expect(r.truncated).toBe(false);
    expect(r.terminationReason).toBe("exited");
  });

  test("KILLS the process when output exceeds the cap", async () => {
    const child = fakeChild();
    const p = runConfined(fakeRunner(child), "bun", [], { ...BASE, maxOutputBytes: 4 });
    child.stdout.write("aaaaaaaaaa");
    const r = await p;
    expect(r.terminationReason).toBe("output_cap");
    expect(r.truncated).toBe(true);
    expect(r.stdout.length).toBeLessThanOrEqual(4);
    expect(child.killed.length).toBeGreaterThan(0);
  });

  test("the cap counts BYTES, not UTF-16 code units", async () => {
    const child = fakeChild();
    // 4 emoji = 16 UTF-8 bytes but only 8 UTF-16 code units. A code-unit cap of 10 would let all
    // four through; a byte cap of 10 must not.
    const p = runConfined(fakeRunner(child), "bun", [], { ...BASE, maxOutputBytes: 10 });
    child.stdout.write(Buffer.from("😀😀😀😀", "utf8"));
    const r = await p;
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.stdout, "utf8")).toBeLessThanOrEqual(10);
  });

  test("a multi-byte character split across two chunks decodes intact", async () => {
    const child = fakeChild();
    const p = runConfined(fakeRunner(child), "bun", [], BASE);
    const emoji = Buffer.from("😀", "utf8"); // 4 bytes
    child.stdout.write(emoji.subarray(0, 2));
    child.stdout.write(emoji.subarray(2));
    child.emit("close", 0);
    const r = await p;
    // Decoding each chunk on arrival would yield two U+FFFD here instead.
    expect(r.stdout).toBe("😀");
  });

  test("KILLS the process when the wall clock expires", async () => {
    const child = fakeChild();
    const r = await runConfined(fakeRunner(child), "bun", [], { ...BASE, maxWallClockMs: 5 });
    expect(r.terminationReason).toBe("wall_clock");
    expect(child.killed[0]).toBe("SIGTERM");
  });

  test("a spawn error settles rather than hanging", async () => {
    const child = fakeChild();
    const p = runConfined(fakeRunner(child), "bun", [], BASE);
    child.emit("error", new Error("ENOENT"));
    const r = await p;
    expect(r.exitCode).toBeNull();
  });

  test("a truncated cut never manufactures a replacement character", async () => {
    const child = fakeChild();
    // Cap of 6 lands mid-way through the second emoji (4 bytes each). The output must be the one
    // complete emoji, NOT one emoji plus a U+FFFD we created by slicing.
    const p = runConfined(fakeRunner(child), "bun", [], { ...BASE, maxOutputBytes: 6 });
    child.stdout.write(Buffer.from("😀😀", "utf8"));
    const r = await p;
    expect(r.stdout).toBe("😀");
    expect(r.stdout).not.toContain("�");
  });

  test("a chunk that fills the budget EXACTLY still truncates when more arrives", async () => {
    // The boundary the obvious implementation gets wrong: the first chunk leaves room === 0, so a
    // later chunk hits `room <= 0` and returns. Without marking it, the child ran on to the wall
    // clock while the result claimed truncated:false — output dropped, and the caller told none was.
    const child = fakeChild();
    const p = runConfined(fakeRunner(child), "bun", [], { ...BASE, maxOutputBytes: 4 });
    child.stdout.write("aaaa"); // exactly fills
    child.stdout.write("bbbb"); // arrives with room === 0
    const r = await p;
    expect(r.truncated).toBe(true);
    expect(r.terminationReason).toBe("output_cap");
    expect(r.stdout).toBe("aaaa");
    expect(child.killed.length).toBeGreaterThan(0);
  });

  test("a chunk that fills the budget exactly and is never followed is NOT truncated", async () => {
    // The other side of that boundary: exactly-full is not itself an overflow, and reporting it as
    // one would be a false disclosure.
    const child = fakeChild();
    const p = runConfined(fakeRunner(child), "bun", [], { ...BASE, maxOutputBytes: 4 });
    child.stdout.write("aaaa");
    child.emit("close", 0);
    const r = await p;
    expect(r.truncated).toBe(false);
    expect(r.terminationReason).toBe("exited");
    expect(r.stdout).toBe("aaaa");
  });

  test("an EMPTY chunk after the budget is full does not fabricate a truncation", async () => {
    const child = fakeChild();
    const p = runConfined(fakeRunner(child), "bun", [], { ...BASE, maxOutputBytes: 4 });
    child.stdout.write("aaaa");
    child.stdout.write(Buffer.alloc(0));
    child.emit("close", 0);
    const r = await p;
    expect(r.truncated).toBe(false);
  });

  test("many chunks past a full budget schedule only ONE termination", async () => {
    // Each overflow used to arm another SIGKILL timer while settle() cleared only the last, leaving
    // earlier ones to fire after the promise resolved — at a pid the OS may have reused by then.
    const child = fakeChild();
    const p = runConfined(fakeRunner(child), "bun", [], { ...BASE, maxOutputBytes: 4 });
    child.stdout.write("aaaa");
    for (let i = 0; i < 5; i++) child.stdout.write("bbbb");
    const r = await p;
    expect(r.terminationReason).toBe("output_cap");
    // One SIGTERM, not six.
    expect(child.killed.filter((s) => s === "SIGTERM").length).toBe(1);
  });

  test("an output-cap kill keeps its cause even if the wall clock fires afterwards", async () => {
    // The wall timer used to overwrite `reason` unconditionally, so a child that outlived its
    // output-cap kill by a moment reported `wall_clock` — naming the wrong cause.
    const child = fakeChild();
    child.kill = () => true; // ignore SIGTERM, so the wall clock lands while stopping
    const p = runConfined(fakeRunner(child), "bun", [], {
      ...BASE,
      maxOutputBytes: 4,
      maxWallClockMs: 20,
    });
    child.stdout.write("aaaaaaaa");
    await Bun.sleep(60);
    child.emit("close", null);
    const r = await p;
    expect(r.terminationReason).toBe("output_cap");
  });

  test("stdout and stderr share ONE budget", async () => {
    const child = fakeChild();
    const p = runConfined(fakeRunner(child), "bun", [], { ...BASE, maxOutputBytes: 6 });
    child.stdout.write("aaaa");
    child.stderr.write("bbbb");
    const r = await p;
    expect(Buffer.byteLength(r.stdout + r.stderr, "utf8")).toBeLessThanOrEqual(6);
    expect(r.truncated).toBe(true);
  });
});
