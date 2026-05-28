import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import "../../test/helpers/cli-mocks.ts";
import { clearFixture, setFixture } from "../../test/helpers/cli-mocks.ts";

const replCalls: Array<string[]> = [];
mock.module("./repl.ts", () => ({
  runRepl: async (args: string[]): Promise<void> => {
    replCalls.push(args);
  },
}));

const mod = await import("./tui.tsx");
const { runTui } = mod;

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
    expect(replCalls).toHaveLength(0);
  });
});

describe("runTui — fallback to REPL", () => {
  let origIsTty: PropertyDescriptor | undefined;

  beforeEach(() => {
    stdoutChunks.length = 0;
    stderrChunks.length = 0;
    replCalls.length = 0;
    installStreamCapture();
    origIsTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
  });
  afterEach(() => {
    clearFixture();
    restoreStreams();
    if (origIsTty !== undefined) {
      Object.defineProperty(process.stdout, "isTTY", origIsTty);
    } else {
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
