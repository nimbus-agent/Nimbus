import { type Mock, spyOn } from "bun:test";

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
  }

  restore(): void {
    if (this.spy !== null) {
      this.spy.mockRestore();
      this.spy = null;
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
