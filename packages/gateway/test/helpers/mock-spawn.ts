import { type Mock, spyOn } from "bun:test";
import { EventEmitter } from "node:events";

import { spawnCaptureInternals } from "../../src/platform/spawn-capture.ts";

export type SpawnCall = {
  readonly binary: string;
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
};

type Stub = {
  readonly binary: string;
  readonly argvMatch?: (argv: readonly string[]) => boolean;
  readonly response: () => { exitCode: number; stdout: string; stderr: string };
};

type FakeSubprocess = {
  readonly exited: Promise<number>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
};

const ENCODER = new TextEncoder();

export class MockSpawn {
  readonly calls: SpawnCall[] = [];
  private readonly stubs: Stub[] = [];
  private spy: Mock<typeof Bun.spawn> | null = null;
  // Connector CLI runners moved off `Bun.spawn` to `platform/spawn-capture.ts` so the child is
  // spawned with `windowsHide` (the Gateway runs detached, so an unhidden child pops a console
  // window). Both paths are stubbed from ONE stub table, so a test written against either API
  // asserts the same argv and env.
  private captureSpy: Mock<typeof spawnCaptureInternals.spawn> | null = null;

  respond(
    binary: string,
    response: { exitCode?: number; stdout?: string; stderr?: string },
    opts?: { argvMatch?: (argv: readonly string[]) => boolean },
  ): void {
    this.stubs.push({
      binary,
      argvMatch: opts?.argvMatch,
      response: () => ({
        exitCode: response.exitCode ?? 0,
        stdout: response.stdout ?? "",
        stderr: response.stderr ?? "",
      }),
    });
  }

  install(): void {
    if (this.spy !== null) {
      throw new Error("MockSpawn.install() called twice without restore()");
    }
    this.spy = spyOn(Bun, "spawn").mockImplementation(((
      cmd: readonly string[],
      options?: { env?: Record<string, string> },
    ): FakeSubprocess => {
      const binary = cmd[0] ?? "";
      const argv = cmd.slice(1);
      const env = options?.env ?? {};
      this.calls.push({
        binary,
        argv,
        env: Object.freeze({ ...env }),
      });

      for (const stub of this.stubs) {
        if (stub.binary !== binary) continue;
        if (stub.argvMatch !== undefined && !stub.argvMatch(argv)) continue;
        const r = stub.response();
        return fakeSubprocess(r);
      }
      throw new Error(`MockSpawn: no stub matched ${binary} ${argv.join(" ")}`);
    }) as unknown as typeof Bun.spawn);

    this.captureSpy = spyOn(spawnCaptureInternals, "spawn").mockImplementation(((
      cmd: string,
      args: readonly string[],
      options?: { env?: Record<string, string> },
    ) => {
      this.calls.push({
        binary: cmd,
        argv: [...args],
        env: Object.freeze({ ...(options?.env ?? {}) }),
      });
      const r = this.match(cmd, args);
      return fakeChildProcess(r);
    }) as unknown as typeof spawnCaptureInternals.spawn);
  }

  private match(
    binary: string,
    argv: readonly string[],
  ): { exitCode: number; stdout: string; stderr: string } {
    for (const stub of this.stubs) {
      if (stub.binary !== binary) continue;
      if (stub.argvMatch !== undefined && !stub.argvMatch(argv)) continue;
      return stub.response();
    }
    throw new Error(`MockSpawn: no stub matched ${binary} ${argv.join(" ")}`);
  }

  restore(): void {
    if (this.spy !== null) {
      this.spy.mockRestore();
      this.spy = null;
    }
    if (this.captureSpy !== null) {
      this.captureSpy.mockRestore();
      this.captureSpy = null;
    }
  }
}

function fakeSubprocess(r: { exitCode: number; stdout: string; stderr: string }): FakeSubprocess {
  return {
    exited: Promise.resolve(r.exitCode),
    stdout: streamFromString(ENCODER.encode(r.stdout)),
    stderr: streamFromString(ENCODER.encode(r.stderr)),
  };
}

function streamFromString(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller): void {
      if (bytes.byteLength > 0) {
        controller.enqueue(bytes);
      }
      controller.close();
    },
  });
}

/**
 * A `node:child_process` stand-in for the `spawnCapture` path: emits stdout/stderr then `close`
 * on the next tick, so the promise in `spawnCapture` settles exactly as it does for a real child.
 */
function fakeChildProcess(r: { exitCode: number; stdout: string; stderr: string }): EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: () => void;
} {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => void;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = (): void => {};
  queueMicrotask(() => {
    if (r.stdout !== "") proc.stdout.emit("data", Buffer.from(r.stdout));
    if (r.stderr !== "") proc.stderr.emit("data", Buffer.from(r.stderr));
    proc.emit("close", r.exitCode);
  });
  return proc;
}
