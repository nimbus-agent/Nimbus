import { describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { CuTerminalLaunchPolicy } from "../cu-types.ts";
import {
  CARRIED_OUTPUT_NOTICE,
  openTerminalLane,
  TERMINAL_OUTPUT_MAX_BYTES,
  type TerminalLaneRuntime,
} from "./terminal.ts";

/** A fake child process: two readable streams plus a recording stdin. */
interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: { written: string[]; write(s: string): boolean; end(): void };
  kill(sig?: string): boolean;
  killed: boolean;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const written: string[] = [];
  child.stdin = {
    written,
    write: (s: string) => {
      written.push(s);
      return true;
    },
    end: () => {},
  };
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    child.emit("close", 0);
    return true;
  };
  return child;
}

const LAUNCH: CuTerminalLaunchPolicy = {
  shellId: "sh",
  shellPath: "/bin/sh",
  argv: ["-s"],
  cwd: "/tmp/cu",
  envOverlay: { HISTFILE: "" },
  policy: {
    id: "cu-terminal-t",
    permissions: { network: [], filesystem: { read: [], write: [] } },
  },
};

type SpawnArgs = Parameters<TerminalLaneRuntime["spawnShell"]>[0];

function open(child: FakeChild, spawnSpy?: (a: SpawnArgs) => void) {
  return openTerminalLane(
    { launch: LAUNCH, sessionId: "s1" },
    {
      spawnShell: (args) => {
        spawnSpy?.(args);
        return child as unknown as ChildProcess;
      },
    },
  );
}

describe("openTerminalLane", () => {
  test("writes EXACTLY the bytes it is given plus one newline, and nothing else", async () => {
    const child = fakeChild();
    const lane = await open(child);
    const p = lane.write("ls -l /tmp");
    setTimeout(() => child.stdout.write("a.txt\n"), 5);
    await p;
    // The single most important assertion in this file: no sentinel, no echo, no prelude.
    expect(child.stdin.written).toEqual(["ls -l /tmp\n"]);
  });

  test("returns output collected until the stream goes quiet", async () => {
    const child = fakeChild();
    const lane = await open(child);
    const p = lane.write("echo hi");
    setTimeout(() => child.stdout.write("hi\n"), 5);
    const r = await p;
    expect(r.output).toContain("hi");
    expect(r.settled).toBe("quiet");
    expect(r.truncated).toBe(false);
  });

  test("interleaves stderr into the same result", async () => {
    const child = fakeChild();
    const lane = await open(child);
    const p = lane.write("oops");
    setTimeout(() => child.stderr.write("not found\n"), 5);
    expect((await p).output).toContain("not found");
  });

  test("stops at the output cap and says so", async () => {
    const child = fakeChild();
    const lane = await open(child);
    const p = lane.write("yes");
    setTimeout(() => child.stdout.write("x".repeat(TERMINAL_OUTPUT_MAX_BYTES + 100)), 5);
    const r = await p;
    expect(r.settled).toBe("output_cap");
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.output, "utf8")).toBeLessThanOrEqual(TERMINAL_OUTPUT_MAX_BYTES);
  });

  test("output still arriving is carried onto the NEXT write's result, LABELLED", async () => {
    const child = fakeChild();
    const lane = await open(child);
    const first = lane.write("slow");
    setTimeout(() => child.stdout.write("part-one\n"), 5);
    await first;
    // Arrives after the first write settled: it must not be lost, and must not be mistaken for
    // the next command's own output.
    child.stdout.write("late-output\n");
    const second = lane.write("next");
    setTimeout(() => child.stdout.write("part-two\n"), 5);
    const r = await second;
    expect(r.output).toContain("late-output");
    expect(r.output).toContain("part-two");
    expect(r.output).toContain(CARRIED_OUTPUT_NOTICE);
    // The notice must precede the carried bytes, or it labels the wrong half.
    expect(r.output.indexOf(CARRIED_OUTPUT_NOTICE)).toBeLessThan(r.output.indexOf("late-output"));
  });

  // The misattribution bug this driver was redesigned around: a command slower to its first byte
  // than the inter-chunk window used to resolve EMPTY while still running.
  test("waits the FIRST-BYTE window, not the inter-chunk window, for slow-starting output", async () => {
    const child = fakeChild();
    const lane = await open(child);
    const p = lane.write("python slow.py");
    // Later than TERMINAL_QUIET_MS (300), well inside TERMINAL_FIRST_BYTE_MS (1000).
    setTimeout(() => child.stdout.write("finally\n"), 500);
    const r = await p;
    expect(r.output).toContain("finally");
    expect(r.settled).toBe("quiet");
  }, 10_000);

  test("a genuinely silent command reports no_output rather than claiming it finished", async () => {
    const child = fakeChild();
    const lane = await open(child);
    const r = await lane.write("mkdir x");
    expect(r.output).toBe("");
    // NOT "quiet": nothing arrived, so "the command finished" is a claim this driver cannot make.
    expect(r.settled).toBe("no_output");
  }, 10_000);

  test("a second concurrent write is refused rather than corrupting both collections", async () => {
    const child = fakeChild();
    const lane = await open(child);
    const first = lane.write("one");
    expect(() => lane.write("two")).toThrow(/ERR_CU_CONCURRENT_WRITE/);
    setTimeout(() => child.stdout.write("done\n"), 5);
    await first;
    // And the lane is usable again once the first write settles.
    const third = lane.write("three");
    setTimeout(() => child.stdout.write("ok\n"), 5);
    expect((await third).output).toContain("ok");
  }, 10_000);

  test("isAlive flips false when the shell exits, and close is idempotent", async () => {
    const child = fakeChild();
    const lane = await open(child);
    expect(lane.isAlive()).toBe(true);
    child.emit("close", 0);
    expect(lane.isAlive()).toBe(false);
    await lane.close();
    await lane.close();
  });

  test("a write against a dead shell throws rather than resolving empty", async () => {
    const child = fakeChild();
    const lane = await open(child);
    child.emit("close", 0);
    expect(() => lane.write("ls")).toThrow(/not alive/i);
  });

  test("a shell that exits mid-collection settles as exited, not as quiet", async () => {
    const child = fakeChild();
    const lane = await open(child);
    const p = lane.write("exit");
    setTimeout(() => child.emit("close", 0), 10);
    expect((await p).settled).toBe("exited");
  });

  test("spawns the launch policy's shell, argv and cwd VERBATIM", async () => {
    const child = fakeChild();
    let seen: SpawnArgs | undefined;
    await open(child, (a) => {
      seen = a;
    });
    expect(seen?.cmd).toBe("/bin/sh");
    expect(seen?.args).toEqual(["-s"]);
    expect(seen?.cwd).toBe("/tmp/cu");
    // The policy travels through untouched — the driver spawns what was asserted, not a rebuild.
    expect(seen?.launch.policy).toBe(LAUNCH.policy);
  });
});
describe("openTerminalLane — the paths a happy-path test never reaches", () => {
  test("a spawn error marks the lane dead, like an exit does", async () => {
    // `child.once("error")` fires instead of "close" when the spawn itself fails (ENOENT on the
    // shell path, a refused sandbox spawn). Without this arm the lane would report itself alive
    // forever and the gate would keep spending budget slots on a process that never started.
    const child = fakeChild();
    const lane = await open(child);
    expect(lane.isAlive()).toBe(true);
    child.emit("error", new Error("spawn failed"));
    expect(lane.isAlive()).toBe(false);
  });

  test("a string chunk is encoded rather than dropped", async () => {
    // `stdio` gives Buffers, but a stream configured with an encoding yields strings. Handling
    // only Uint8Array would silently lose that output instead of returning it.
    const child = fakeChild();
    const lane = await open(child);
    const p = lane.write("echo hi");
    setTimeout(() => child.stdout.emit("data", "plain-string-output"), 5);
    expect((await p).output).toContain("plain-string-output");
  });

  test("carried output is capped, so an idle lane cannot grow without bound", async () => {
    // Between writes there is no collector, so output accumulates in `carried`. Uncapped, a shell
    // printing continuously while nobody is driving it would grow the buffer until the process
    // died — the cap is what bounds memory held on the gateway's behalf.
    const child = fakeChild();
    const lane = await open(child);
    // Settle one write so the lane is idle, then flood it.
    const first = lane.write("start");
    setTimeout(() => child.stdout.write("go\n"), 5);
    await first;
    child.stdout.write("y".repeat(TERMINAL_OUTPUT_MAX_BYTES * 2));
    const second = lane.write("next");
    setTimeout(() => child.stdout.write("done\n"), 5);
    const r = await second;
    expect(Buffer.byteLength(r.output, "utf8")).toBeLessThanOrEqual(TERMINAL_OUTPUT_MAX_BYTES);
  });

  test("truncation never manufactures a replacement character at the cut", async () => {
    // Cutting mid-sequence and decoding yields a U+FFFD we invented, which re-encodes to 3 bytes
    // and can push a capped buffer back OVER its own cap. Same defect `exec-run.ts` fixed.
    const child = fakeChild();
    const lane = await open(child);
    const p = lane.write("emoji");
    setTimeout(() => {
      // Multi-byte characters straddling the cap boundary.
      child.stdout.write("\u{1F600}".repeat(TERMINAL_OUTPUT_MAX_BYTES));
    }, 5);
    const r = await p;
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.output, "utf8")).toBeLessThanOrEqual(TERMINAL_OUTPUT_MAX_BYTES);
    expect(r.output).not.toContain("�");
  });

  test("close() on an already-exited lane returns immediately without killing anything", async () => {
    const child = fakeChild();
    const lane = await open(child);
    child.emit("close", 0);
    child.killed = false;
    await lane.close();
    // Nothing to kill: the early return is what keeps `close` idempotent and cheap.
    expect(child.killed).toBe(false);
  });

  test("close() kills a live lane and survives a stdin that is already broken", async () => {
    const child = fakeChild();
    child.stdin.end = () => {
      throw new Error("EPIPE");
    };
    const lane = await open(child);
    // The `end()` throw must not prevent the kill — the kill is what actually matters.
    await lane.close();
    expect(child.killed).toBe(true);
    expect(lane.isAlive()).toBe(false);
  });

  test("close() gives up waiting rather than hanging on a shell that never exits", async () => {
    // A shell ignoring SIGTERM must not wedge the gateway's shutdown path. Bounded wait, then on.
    const child = fakeChild();
    child.kill = () => {
      child.killed = true;
      return true; // deliberately emits no "close"
    };
    const lane = await open(child);
    await lane.close();
    expect(child.killed).toBe(true);
    expect(lane.isAlive()).toBe(false);
  }, 15_000);
});
