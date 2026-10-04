import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isolatePlatformEnv } from "../../test/helpers/isolate-platform-env.ts";
import { createStreamCapture } from "../../test/helpers/stream-capture.ts";
import {
  EXEC_EXIT_CODES,
  type ExecClient,
  exitCodeFor,
  parseExecArgs,
  type RunExecDeps,
  runExec,
} from "./exec.ts";

/**
 * Branches `exec.test.ts` leaves unexercised: a valid `--timeout` and both ways an invalid one is
 * refused, a script that ended without an exit code, a non-Error transport failure, and the
 * production deps' refusal of a bad argument.
 */

describe("--timeout", () => {
  test("a positive value is carried as timeoutMs", () => {
    expect(parseExecArgs(["--code", "x", "--timeout", "2500"]).timeoutMs).toBe(2500);
  });

  test("zero, negative and non-numeric values are all refused", () => {
    for (const bad of ["0", "-1", "soon"]) {
      expect(() => parseExecArgs(["--code", "x", "--timeout", bad])).toThrow(
        new Error("--timeout must be a positive integer"),
      );
    }
  });

  test("an absent --timeout leaves timeoutMs out entirely, rather than sending undefined", () => {
    expect(Object.keys(parseExecArgs(["--code", "x"]))).not.toContain("timeoutMs");
  });
});

describe("exitCodeFor", () => {
  test("a script that ran but reported no exit code is a failure (1), never a success", () => {
    expect(
      exitCodeFor({ status: "ran", result: { exitCode: null, terminationReason: "exited" } }),
    ).toBe(1);
  });
});

describe("runExec orchestration", () => {
  function harness(over: Partial<RunExecDeps> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const codes: number[] = [];
    const calls: Array<{ method: string; params: unknown }> = [];
    const client: ExecClient = {
      onNotification: () => {},
      call: async (method, params) => {
        calls.push({ method, params });
        return { status: "ran", result: { exitCode: 3, terminationReason: "exited" } };
      },
    };
    const deps: RunExecDeps = {
      runWithClient: async <T>(fn: (c: ExecClient) => Promise<T>) => fn(client),
      ask: async () => true,
      sink: { out: (s) => out.push(s), err: (s) => err.push(s) },
      setExitCode: (c) => codes.push(c),
      cwd: () => join(tmpdir(), "nimbus-exec-cov-cwd"),
      ...over,
    };
    return { out, err, codes, calls, deps };
  }

  test("--timeout reaches exec.run as timeoutMs, beside the caller's cwd", async () => {
    const h = harness();
    await runExec(["--code", "print(1)", "--timeout", "2500"], h.deps);
    expect(h.calls).toEqual([
      {
        method: "exec.run",
        params: {
          code: "print(1)",
          timeoutMs: 2500,
          fsRead: [],
          fsWrite: [],
          cwd: join(tmpdir(), "nimbus-exec-cov-cwd"),
        },
      },
    ]);
    expect(h.codes).toEqual([3]);
  });

  test("a non-Error transport failure is printed as-is and exits refused", async () => {
    const h = harness({
      runWithClient: async () => {
        throw "pipe closed";
      },
    });
    await runExec(["--code", "print(1)"], h.deps);
    expect(h.err).toEqual(["pipe closed\n"]);
    expect(h.codes).toEqual([EXEC_EXIT_CODES.refused]);
  });

  test("with no deps, a bad argument is refused on stderr with exit 127 — nothing is run", async () => {
    const restoreEnv = isolatePlatformEnv(join(tmpdir(), "nimbus-exec-cov-env-never-created"));
    const cap = createStreamCapture();
    const priorExitCode = process.exitCode;
    cap.install();
    try {
      await runExec(["--allow-net"]);
      expect(process.exitCode).toBe(EXEC_EXIT_CODES.refused);
    } finally {
      cap.restore();
      restoreEnv();
      // `?? 0`: Bun ignores `process.exitCode = undefined`, which would leave 127 behind.
      process.exitCode = priorExitCode ?? 0;
    }
    expect(cap.stderrChunks.join("")).toStartWith("Unknown flag: --allow-net\nUsage: nimbus exec");
    expect(cap.stdoutChunks).toEqual([]);
  });
});
