import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createStreamCapture } from "../../test/helpers/stream-capture.ts";
import { REGISTRY_USAGE, type RegistryCmdDeps, runRegistry } from "./registry-cmd.ts";

class ExitCalled extends Error {
  constructor(readonly code: number) {
    super(`exit ${String(code)}`);
  }
}

function recorder(maintainCode = 0): {
  calls: string[][];
  err: string[];
  deps: RegistryCmdDeps;
} {
  const calls: string[][] = [];
  const err: string[] = [];
  return {
    calls,
    err,
    deps: {
      maintain: async (args) => {
        calls.push(args);
        return maintainCode;
      },
      writeErr: (s) => void err.push(s),
      exit: (code) => {
        throw new ExitCalled(code);
      },
    },
  };
}

describe("runRegistry", () => {
  test("`maintain` forwards the remaining args and returns without exiting on 0", async () => {
    const r = recorder(0);
    await expect(
      runRegistry(["maintain", "add", "dir", "pkg.tgz", "--channel", "beta"], r.deps),
    ).resolves.toBeUndefined();
    expect(r.calls).toEqual([["add", "dir", "pkg.tgz", "--channel", "beta"]]);
    expect(r.err).toEqual([]);
  });

  test("a non-zero maintain result becomes the process exit code", async () => {
    for (const code of [1, 2]) {
      const r = recorder(code);
      await expect(runRegistry(["maintain", "remove"], r.deps)).rejects.toEqual(
        new ExitCalled(code),
      );
      expect(r.calls).toEqual([["remove"]]);
    }
  });

  test("an unknown or missing subcommand prints usage, exits 2 and never runs maintain", async () => {
    for (const args of [[], ["publish"], ["Maintain"]]) {
      const r = recorder(0);
      await expect(runRegistry(args, r.deps)).rejects.toEqual(new ExitCalled(2));
      expect(r.calls).toEqual([]);
      expect(r.err).toEqual([REGISTRY_USAGE]);
    }
    // The router's usage names both halves: the gateway-backed client subcommands and maintain.
    expect(REGISTRY_USAGE).toStartWith("Usage: nimbus registry add <name> <url>");
    expect(REGISTRY_USAGE).toContain("nimbus registry maintain init|add|remove ...");
  });
});

describe("runRegistry with its production defaults", () => {
  const cap = createStreamCapture({ captureExit: true });
  beforeEach(() => cap.install());
  afterEach(() => {
    cap.restore();
    cap.stdoutChunks.length = 0;
    cap.stderrChunks.length = 0;
  });

  test("an unknown subcommand writes usage to the real stderr and calls process.exit(2)", async () => {
    await expect(runRegistry(["bogus"])).rejects.toThrow("process.exit(2)");
    expect(cap.stderrChunks).toEqual([REGISTRY_USAGE]);
  });

  test("`maintain` with no subcommand runs the real maintain usage path and exits 2", async () => {
    await expect(runRegistry(["maintain"])).rejects.toThrow("process.exit(2)");
    expect(cap.stderrChunks.join("")).toStartWith("Usage: nimbus registry maintain init <dir>");
    expect(cap.stdoutChunks).toEqual([]);
  });
});
