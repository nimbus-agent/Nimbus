/**
 * Two bounds of the terminal lane driver that `terminal.test.ts` does not pin exactly: idle output
 * arriving once the carry buffer is ALREADY full (dropped, not appended), and a command that never
 * goes quiet (cut at the settle cap rather than collected forever). A fake child stands in for the
 * shell; nothing here spawns a process.
 */
import { describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { CuTerminalLaunchPolicy } from "../cu-types.ts";
import {
  CARRIED_OUTPUT_NOTICE,
  openTerminalLane,
  TERMINAL_OUTPUT_MAX_BYTES,
  TERMINAL_SETTLE_MS,
} from "./terminal.ts";

interface FakeShell extends EventEmitter {
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly stdin: EventEmitter & { write(s: string): boolean; end(): void };
  kill(signal?: string): boolean;
}

function fakeShell(): FakeShell {
  const child = new EventEmitter() as FakeShell;
  const stdin = Object.assign(new EventEmitter(), {
    write: (_s: string) => true,
    end: () => {},
  });
  Object.assign(child, {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin,
    kill: () => {
      child.emit("close", 0);
      return true;
    },
  });
  return child;
}

const LAUNCH: CuTerminalLaunchPolicy = {
  shellId: "sh",
  shellPath: "/bin/sh",
  argv: ["-s"],
  // Never created or entered: the fake shell below is all that is ever "spawned".
  cwd: join(tmpdir(), "nimbus-cu-cov"),
  envOverlay: {},
  policy: {
    id: "cu-terminal-cov",
    permissions: { network: [], filesystem: { read: [], write: [] } },
  },
};

function open(child: FakeShell) {
  return openTerminalLane(
    { launch: LAUNCH, sessionId: "cov" },
    { spawnShell: () => child as unknown as ChildProcess },
  );
}

describe("openTerminalLane — carried output past the cap", () => {
  test("idle output arriving once the carry buffer is full is DROPPED; the next result is the notice plus exactly the cap", async () => {
    const child = fakeShell();
    const lane = await open(child);
    // A first command that floods past the cap ends its collection AT ONCE (no silence window to
    // wait out on the real clock), and leaves the lane idle: nothing collects what arrives next.
    const first = lane.write("start");
    child.stdout.write("x".repeat(TERMINAL_OUTPUT_MAX_BYTES + 1));
    expect((await first).settled).toBe("output_cap");

    // Idle (no write collecting): the first chunk fills the carry buffer to its cap, the second
    // finds no room at all.
    child.stdout.write("a".repeat(TERMINAL_OUTPUT_MAX_BYTES));
    child.stdout.write("b".repeat(64));
    await Bun.sleep(10);

    const second = lane.write("next");
    setTimeout(() => child.stdout.write("after\n"), 5);
    const r = await second;

    const notice = `${CARRIED_OUTPUT_NOTICE}\n`;
    const carriedRoom = TERMINAL_OUTPUT_MAX_BYTES - Buffer.byteLength(notice, "utf8");
    expect(r.output).toBe(notice + "a".repeat(carriedRoom));
    // Nothing of the second idle chunk, nor of this command's own late output, got in.
    const payload = r.output.slice(notice.length);
    expect(payload).not.toContain("b");
    expect(payload).not.toContain("after");
    expect(Buffer.byteLength(r.output, "utf8")).toBe(TERMINAL_OUTPUT_MAX_BYTES);
    expect(r.truncated).toBe(true);
    expect(r.settled).toBe("output_cap");
  });
});

describe("openTerminalLane — a command that never goes quiet", () => {
  test("is cut at the settle cap, keeping what it printed, rather than collected forever", async () => {
    const child = fakeShell();
    const lane = await open(child);

    // A `yes`-like stream: a chunk every 10 ms, so neither silence window can ever expire.
    const ticker = setInterval(() => child.stdout.write("y\n"), 10);
    // Safety net on the real timer: if the cap never fired, stop the stream after 2 s so the
    // write settles as `quiet` and the assertion below fails fast instead of hanging.
    const safetyNet = setTimeout(() => clearInterval(ticker), 2_000);

    // The cap timer is armed synchronously inside `write`, so the 15 s value is swapped for 60 ms
    // only around that call, and restored before anything is awaited.
    const realSetTimeout = globalThis.setTimeout;
    const delays: (number | undefined)[] = [];
    globalThis.setTimeout = ((handler: () => void, timeout?: number) => {
      delays.push(timeout);
      return realSetTimeout(handler, timeout === TERMINAL_SETTLE_MS ? 60 : timeout);
    }) as typeof setTimeout;
    let pending: ReturnType<typeof lane.write>;
    try {
      pending = lane.write("yes");
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    let r: Awaited<typeof pending>;
    try {
      r = await pending;
    } finally {
      clearInterval(ticker);
      clearTimeout(safetyNet);
    }

    expect(delays).toContain(TERMINAL_SETTLE_MS);
    expect(r.settled).toBe("settle_cap");
    expect(r.truncated).toBe(false);
    expect(r.output.startsWith("y\n")).toBe(true);
    expect(r.output.replaceAll("y\n", "")).toBe("");
    // The lane is still usable afterwards: the cap ended the COLLECTION, not the shell.
    expect(lane.isAlive()).toBe(true);
  });
});
