import { type Mock, spyOn } from "bun:test";

/** A call captured by MockSpawn for assertions. */
export type SpawnCall = {
  /** Binary name, e.g. "aws". The first element of the cmd array. */
  readonly binary: string;
  /** Arguments after the binary, in original order. */
  readonly argv: readonly string[];
  /** Spawn-time env passed via `options.env`, frozen. Empty if no env was set. */
  readonly env: Readonly<Record<string, string>>;
};

/** Staged response for a spawn. */
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

/**
 * Test-only `Bun.spawn` shim. Stages canned subprocess results keyed by
 * (binary, optional argv-matcher) and records every call.
 *
 * Lives under test/helpers/ so it is NOT subject to the per-file coverage
 * floor — this is the testing tool, not production code.
 *
 * Usage:
 *
 *   const mock = new MockSpawn();
 *   mock.install();
 *   try {
 *     mock.respond("aws", { exitCode: 0, stdout: '{"Functions":[]}' });
 *     // ...run code that calls Bun.spawn(["aws", ...])...
 *     expect(mock.calls[0].binary).toBe("aws");
 *     expect(mock.calls[0].env["AWS_ACCESS_KEY_ID"]).toBe("aws-stub-akid");
 *   } finally {
 *     mock.restore();
 *   }
 */
export class MockSpawn {
  readonly calls: SpawnCall[] = [];
  private readonly stubs: Stub[] = [];
  private spy: Mock<typeof Bun.spawn> | null = null;

  /**
   * Stage a subprocess result.
   *
   * @param binary First element of the cmd array (e.g. "aws").
   * @param response exitCode (default 0), stdout (default ""), stderr (default "").
   * @param opts.argvMatch optional predicate over the argv tail (everything after binary).
   *                       More-specific matchers should be registered BEFORE catch-alls.
   */
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
      cmd: string | readonly string[],
      options?: { env?: Record<string, string> },
    ): FakeSubprocess => {
      const argvAll: readonly string[] = typeof cmd === "string" ? [cmd] : cmd;
      const binary = argvAll[0] ?? "";
      const argv = argvAll.slice(1);
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
  const enc = new TextEncoder();
  return {
    exited: Promise.resolve(r.exitCode),
    stdout: streamFromString(enc.encode(r.stdout)),
    stderr: streamFromString(enc.encode(r.stderr)),
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
