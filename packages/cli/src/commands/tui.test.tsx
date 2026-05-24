// packages/cli/src/commands/tui.test.tsx
//
// Covers the `runTui` dispatcher. Two branches are deterministically testable
// without rendering Ink (which requires a real TTY + writable raw stdin):
//   1. --help / -h prints usage and returns.
//   2. Gateway state missing → "Gateway is not running" on stderr + exitCode = 1.
//   3. Fallback path (non-TTY in CI) → invokes runRepl via the mocked module.
//
// The actual Ink render path is not exercised because spawning a real TTY +
// raw-mode stdin under bun-test is inherently flaky; integration tests in the
// e2e suite cover that surface.
//
// IMPORTANT: this test mocks `./repl.ts` locally (rather than via the shared
// harness) because no other CLI test cares about that module. The mock is
// installed at top-of-file via `mock.module` so the `await import("./tui.tsx")`
// below captures the stub.

import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import "../../test/helpers/cli-mocks.ts"; // module-load side effects
import { clearFixture, setFixture } from "../../test/helpers/cli-mocks.ts";

const replCalls: Array<string[]> = [];
mock.module("./repl.ts", () => ({
  runRepl: async (args: string[]): Promise<void> => {
    replCalls.push(args);
  },
}));

const mod = await import("./tui.tsx");
const { runTui } = mod;

// ----------------------------------------------------------------------
// process.stdout / process.stderr stream capture.
// ----------------------------------------------------------------------

const stdoutChunks: string[] = [];
const stderrChunks: string[] = [];
const origStdoutWrite = process.stdout.write.bind(process.stdout);
const origStderrWrite = process.stderr.write.bind(process.stderr);

function installStreamCapture(): void {
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderrChunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  }) as typeof process.stderr.write;
}

function restoreStreams(): void {
  process.stdout.write = origStdoutWrite;
  process.stderr.write = origStderrWrite;
}

afterAll(() => {
  restoreStreams();
});

describe("runTui — usage", () => {
  beforeEach(() => {
    stdoutChunks.length = 0;
    stderrChunks.length = 0;
    replCalls.length = 0;
    installStreamCapture();
  });
  afterEach(() => {
    clearFixture();
    restoreStreams();
  });

  it("prints help and returns when --help is passed", async () => {
    await runTui(["--help"]);
    expect(stdoutChunks.join("")).toContain("nimbus tui");
    expect(stdoutChunks.join("")).toContain("Falls back to");
  });

  it("prints help when -h is passed", async () => {
    await runTui(["-h"]);
    expect(stdoutChunks.join("")).toContain("nimbus tui");
  });
});

describe("runTui — gateway missing", () => {
  let originalExitCode: number | string | undefined;
  beforeEach(() => {
    stdoutChunks.length = 0;
    stderrChunks.length = 0;
    replCalls.length = 0;
    installStreamCapture();
    originalExitCode = process.exitCode;
    process.exitCode = 0;
  });
  afterEach(() => {
    clearFixture();
    restoreStreams();
    process.exitCode = originalExitCode;
  });

  it("writes onboarding hint to stderr and sets exitCode=1 when gateway is not running", async () => {
    setFixture({});
    await runTui([]);
    expect(stderrChunks.join("")).toContain("Gateway is not running");
    expect(process.exitCode).toBe(1);
    // No REPL fallback in this branch — we exit before fallback detection.
    expect(replCalls).toHaveLength(0);
  });
});

// ----------------------------------------------------------------------
// Fallback path: gateway present but environment is non-TTY (always true
// in bun-test). The dispatcher must call runRepl with the original args.
// ----------------------------------------------------------------------

describe("runTui — fallback to REPL", () => {
  // Save / restore isTTY descriptor so the detection branch fires the way
  // we expect. In headless CI process.stdout.isTTY is already undefined,
  // but other tests in the same process may have stubbed it differently.
  let origIsTty: PropertyDescriptor | undefined;

  beforeEach(() => {
    stdoutChunks.length = 0;
    stderrChunks.length = 0;
    replCalls.length = 0;
    installStreamCapture();
    origIsTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    // Explicitly assert non-TTY to make the test deterministic regardless of
    // whether earlier tests stubbed isTTY=true.
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
  });
  afterEach(() => {
    clearFixture();
    restoreStreams();
    if (origIsTty !== undefined) {
      Object.defineProperty(process.stdout, "isTTY", origIsTty);
    } else {
      // Remove the property we installed.
      delete (process.stdout as unknown as { isTTY?: boolean }).isTTY;
    }
  });

  it("invokes runRepl with the original args when stdout is not a TTY", async () => {
    setFixture({ gatewayState: { socketPath: "/tmp/fake.sock" } });
    await runTui(["--session", "s1"]);
    expect(stderrChunks.join("")).toContain("Unsuitable terminal detected");
    expect(stderrChunks.join("")).toContain("non-TTY");
    expect(stderrChunks.join("")).toContain("falling back to REPL");
    expect(replCalls).toHaveLength(1);
    expect(replCalls[0]).toEqual(["--session", "s1"]);
  });
});
