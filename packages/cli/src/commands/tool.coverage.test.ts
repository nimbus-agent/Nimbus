import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  clearFixture,
  FAKE_SOCKET_PATH,
  type RecordedClientConstruction,
  setFixture,
} from "../../test/helpers/cli-mocks.ts";
import { createStreamCapture } from "../../test/helpers/stream-capture.ts";

// Imported AFTER cli-mocks, so the gateway these tests could reach is the in-process fake.
const { readGatewayState } = await import("../lib/gateway-process.ts");
const { INTERACTIVE_RPC_TIMEOUT_MS } = await import("../lib/rpc-timeouts.ts");
const { getCliPlatformPaths } = await import("../paths.ts");
const { runTool, TOOL_EXIT_CODES } = await import("./tool.ts");

/**
 * `tool.test.ts` drives `runTool` through injected deps only, so the PRODUCTION wiring of the
 * load-bearing non-TTY refusal -- `isInteractiveTty` reading the real `process.stdin` -- was never
 * exercised: a default hardwired to `() => true` would have passed every one of those tests while
 * letting a piped "y" approve model-authored code. These run `runTool` with no deps at all.
 */
describe("runTool with its PRODUCTION deps -- the TTY guard reads the real stdin", () => {
  const streams = createStreamCapture();
  const calls: string[] = [];
  // Every client the production deps build: a refusal must open no connection at all.
  const constructions: RecordedClientConstruction[] = [];
  let savedExitCode: typeof process.exitCode;
  let savedIsTty: PropertyDescriptor | undefined;

  function setStdinTty(value: boolean): void {
    Object.defineProperty(process.stdin, "isTTY", { value, configurable: true, writable: true });
  }

  beforeEach(async () => {
    savedExitCode = process.exitCode;
    savedIsTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    // These tests run with the production deps, so first prove the gateway they could reach is the
    // fake: were the real `readGatewayState` in play this would read the developer's own state file
    // and fail the equality -- before any test got as far as dialing that gateway.
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH } });
    const seen: unknown = await readGatewayState(getCliPlatformPaths());
    expect(seen).toEqual({ socketPath: FAKE_SOCKET_PATH });

    calls.length = 0;
    constructions.length = 0;
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      clientConstructions: constructions,
      ipcClient: {
        connect: async (): Promise<void> => {},
        disconnect: async (): Promise<void> => {},
        onNotification: (): void => {},
        call: async (method: string): Promise<unknown> => {
          calls.push(method);
          return { status: "denied" };
        },
      },
    });
    streams.stdoutChunks.length = 0;
    streams.stderrChunks.length = 0;
    streams.install();
  });

  afterEach(() => {
    streams.restore();
    if (savedIsTty === undefined) Reflect.deleteProperty(process.stdin, "isTTY");
    else Object.defineProperty(process.stdin, "isTTY", savedIsTty);
    // `?? 0`, not the saved value alone: Bun ignores `process.exitCode = undefined`, so restoring
    // an unset code that way would leak this file's 127 into the runner's own exit status.
    process.exitCode = savedExitCode ?? 0;
    clearFixture();
  });

  test.each([
    ["create", ["create", "--description", "d", "--host", "a.example.com"]],
    ["save", ["save", "tg_a"]],
  ])("%s on a non-TTY stdin is refused before any gateway call", async (sub, argv) => {
    setStdinTty(false);
    await runTool(argv);
    expect(calls).toEqual([]);
    expect(constructions).toEqual([]);
    expect(process.exitCode).toBe(TOOL_EXIT_CODES.refused);
    expect(streams.stderrChunks.join("")).toBe(
      `error: nimbus tool ${sub} needs an interactive TTY for owner approval.\n` +
        `There is no headless path: toolgen.${sub} is LAN-forbidden and local-only.\n`,
    );
    expect(streams.stdoutChunks).toEqual([]);
  });

  test("create on a TTY stdin goes on to the gateway, and its outcome sets the real exit code", async () => {
    setStdinTty(true);
    await runTool(["create", "--description", "d", "--host", "a.example.com"]);
    expect(calls).toEqual(["toolgen.create"]);
    // One client, on the INTERACTIVE budget: `toolgen.create` blocks on the owner answering the
    // approval prompt, which the transport's 30 s default would cut off mid-read.
    expect(constructions).toEqual([
      { socketPath: FAKE_SOCKET_PATH, opts: { requestTimeoutMs: INTERACTIVE_RPC_TIMEOUT_MS } },
    ]);
    expect(process.exitCode).toBe(TOOL_EXIT_CODES.denied);
    expect(streams.stderrChunks.join("")).toBe("nimbus: tool registration denied\n");
  });

  test("a usage error is written to the real stderr and sets the real exit code", async () => {
    await runTool(["bogus"]);
    expect(calls).toEqual([]);
    expect(process.exitCode).toBe(TOOL_EXIT_CODES.refused);
    expect(streams.stderrChunks.join("")).toStartWith(
      'Unknown "nimbus tool" subcommand: "bogus"\n',
    );
  });
});
