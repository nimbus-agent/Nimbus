import { afterEach, describe, expect, test } from "bun:test";

import {
  CLACK_CANCEL,
  clearFixture,
  FAKE_SOCKET_PATH,
  fakePath,
  type RecordedClientConstruction,
  setFixture,
} from "../../test/helpers/cli-mocks.ts";
import type { CliPlatformPaths } from "../paths.ts";

// Imported only AFTER cli-mocks has replaced `@clack/prompts`, the gateway-state reader and
// `IPCClient`, so nothing in this file can open a real prompt or reach a real gateway.
const { interactiveCommandDeps, isExplicitApproval, stringArrayOrEmpty } = await import(
  "./approval-broadcast.ts"
);
const { readGatewayState } = await import("./gateway-process.ts");
const { INTERACTIVE_RPC_TIMEOUT_MS } = await import("./rpc-timeouts.ts");
const { isCancel } = await import("@clack/prompts");

describe("stringArrayOrEmpty", () => {
  test("returns a COPY of an all-string array, never the caller's own array", () => {
    const input = ["a.example.com", "b.example.com"];
    const out = stringArrayOrEmpty(input);
    expect(out).toEqual(["a.example.com", "b.example.com"]);
    expect(out).not.toBe(input);
    out.push("c.example.com");
    expect(input).toEqual(["a.example.com", "b.example.com"]);

    const empty: string[] = [];
    expect(stringArrayOrEmpty(empty)).not.toBe(empty);
  });

  test("one non-string element rejects the WHOLE list -- all-or-nothing, never a filter", () => {
    expect(stringArrayOrEmpty(["a.example.com", 7])).toEqual([]);
    expect(stringArrayOrEmpty(["a.example.com", null])).toEqual([]);
    expect(stringArrayOrEmpty([["a.example.com"]])).toEqual([]);
  });

  test.each([
    ["undefined", undefined],
    ["null", null],
    ["a bare string, which is not a list of one", "a.example.com"],
    ["a number", 7],
    ["an array-like object", { 0: "a.example.com", length: 1 }],
    ["a Set of strings", new Set(["a.example.com"])],
    ["a plain object", {}],
  ])("%s is not a list, so it yields []", (_label, value) => {
    expect(stringArrayOrEmpty(value)).toEqual([]);
  });
});

describe("isExplicitApproval", () => {
  test("the boolean true approves", () => {
    expect(isExplicitApproval(true)).toBe(true);
  });

  test("a cancelled prompt is a denial, even though the prompt library recognises the cancel", () => {
    // Premise: this file's prompt library is cli-mocks', whose `isCancel` DOES recognise this
    // symbol -- so the cancel arm is the one actually exercised, not merely the `=== true` arm.
    expect(isCancel(CLACK_CANCEL)).toBe(true);
    expect(isExplicitApproval(CLACK_CANCEL)).toBe(false);
  });

  test.each([
    ["false", false],
    ["a bare symbol", Symbol("anything")],
    ["undefined, as an abandoned prompt yields", undefined],
    ["null", null],
    ["the STRING 'true', not the boolean", "true"],
    ["1, which is truthy but not true", 1],
    ["an object", {}],
    ["an array holding true", [true]],
  ])("%s is a denial, never an approval", (_label, answer) => {
    expect(isExplicitApproval(answer)).toBe(false);
  });
});

/** Paths under cli-mocks' unwritten fake root: a REAL state reader would find no gateway here. */
function fakeCliPaths(): CliPlatformPaths {
  return {
    configDir: fakePath("config"),
    dataDir: fakePath("data"),
    logDir: fakePath("logs"),
    socketPath: FAKE_SOCKET_PATH,
    extensionsDir: fakePath("extensions"),
    tempDir: fakePath("tmp"),
  };
}

describe("interactiveCommandDeps", () => {
  afterEach(() => {
    clearFixture();
  });

  test("runWithClient connects with the INTERACTIVE budget and hands fn the live client", async () => {
    const constructions: RecordedClientConstruction[] = [];
    const calls: string[] = [];
    const state = { socketPath: FAKE_SOCKET_PATH, pid: 4242 };
    setFixture({
      gatewayState: state,
      ipcClient: {
        call: async (method: string) => {
          calls.push(method);
          return { pong: true };
        },
        connect: async () => {},
        disconnect: async () => {},
      },
      clientConstructions: constructions,
    });
    // Premise: the state reader is the fixture's, so the connection below cannot reach a real
    // gateway -- a real reader would find nothing under these paths and this would fail first.
    expect(await readGatewayState(fakeCliPaths())).toEqual(state);

    const result = await interactiveCommandDeps().runWithClient((c) => c.call("gateway.ping", {}));

    expect(result).toEqual({ pong: true });
    expect(calls).toEqual(["gateway.ping"]);
    // An approval prompt runs INSIDE the pending call's window, so a client on the transport's
    // 30s default would time out an owner who reads the prompt for longer than that.
    expect(constructions).toEqual([
      { socketPath: FAKE_SOCKET_PATH, opts: { requestTimeoutMs: INTERACTIVE_RPC_TIMEOUT_MS } },
    ]);
  });

  test("runWithClient answers a generic consent.request by PROMPTING the owner, never auto-approving", async () => {
    // These commands' own approvals arrive as their own broadcasts, but a HITL `consent.request`
    // raised during the call is answered by whichever handler the connection was built with. The
    // base passes no consent choice, so that is the interactive prompt. A `consent: { kind: "auto" }`
    // here would approve every such request, for all three commands at once, without the owner
    // seeing it -- and the timeout assertion above would still pass.
    const handlers = new Map<string, (params: unknown) => unknown>();
    const calls: Array<{ method: string; params: unknown }> = [];
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH, pid: 4242 },
      // The owner DECLINES. The prompt handler relays that; an auto-approver answers `true` anyway.
      clackAnswer: false,
      ipcClient: {
        call: async (method: string, params: unknown) => {
          calls.push({ method, params });
          return undefined;
        },
        connect: async () => {},
        disconnect: async () => {},
        onNotification: (method: string, handler: (params: unknown) => unknown) => {
          handlers.set(method, handler);
        },
      },
    });
    // Premise: the prompt the consent handler opens is cli-mocks' fixture-backed fake, so it
    // returns the answer above instead of waiting on a real terminal.
    expect(isCancel(CLACK_CANCEL)).toBe(true);
    // A set NIMBUS_SCRIPT_CONSENT_SOURCE would make the prompt choice read decisions from a file.
    const scripted = process.env["NIMBUS_SCRIPT_CONSENT_SOURCE"];
    delete process.env["NIMBUS_SCRIPT_CONSENT_SOURCE"];
    try {
      await interactiveCommandDeps().runWithClient(async () => {
        await handlers.get("consent.request")?.({ requestId: "c1", prompt: "Delete it?" });
      });
    } finally {
      if (scripted !== undefined) process.env["NIMBUS_SCRIPT_CONSENT_SOURCE"] = scripted;
    }

    expect(calls).toEqual([
      { method: "consent.respond", params: { requestId: "c1", approved: false } },
    ]);
  });

  test("ask resolves with the prompt's answer UNINTERPRETED, a cancel included", async () => {
    // Premise: `confirm` is cli-mocks' fixture-backed fake, not a real terminal prompt.
    expect(isCancel(CLACK_CANCEL)).toBe(true);

    setFixture({ clackAnswer: CLACK_CANCEL });
    expect(await interactiveCommandDeps().ask("Approve?")).toBe(CLACK_CANCEL);

    setFixture({ clackAnswer: false });
    expect(await interactiveCommandDeps().ask("Approve?")).toBe(false);
  });

  test("ask shows the owner the rendered prompt VERBATIM, and sets no other option", async () => {
    // The text IS what the owner approves: a code body, a tool body, a session envelope. An `ask`
    // that showed a generic "Approve?" instead would still relay a real yes or no, so every other
    // test here would pass while each approval became a rubber stamp.
    const shown: unknown[] = [];
    const deps = interactiveCommandDeps(async (opts) => {
      shown.push(opts);
      return true;
    });
    const prompt = 'Run this code in the bun sandbox?\n\nawait fetch("https://a.example.com")';

    expect(await deps.ask(prompt)).toBe(true);
    // Exactly `{ message }`: any other option (an `initialValue`, say) changes the prompt the owner
    // answers, and that is a deliberate change, not one a refactor of this file should make.
    expect(shown).toEqual([{ message: prompt }]);
  });

  test("the sink writes `out` to stdout and `err` to stderr, verbatim", () => {
    const written: Array<[string, string]> = [];
    const realOut = process.stdout.write;
    const realErr = process.stderr.write;
    process.stdout.write = ((chunk: string) => {
      written.push(["stdout", chunk]);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => {
      written.push(["stderr", chunk]);
      return true;
    }) as typeof process.stderr.write;
    try {
      const { sink } = interactiveCommandDeps();
      sink.out("to stdout\n");
      sink.err("to stderr\n");
    } finally {
      process.stdout.write = realOut;
      process.stderr.write = realErr;
    }
    expect(written).toEqual([
      ["stdout", "to stdout\n"],
      ["stderr", "to stderr\n"],
    ]);
  });

  test("setExitCode sets this process's exit code", () => {
    const before = process.exitCode;
    try {
      interactiveCommandDeps().setExitCode(126);
      expect(process.exitCode).toBe(126);
    } finally {
      // Reset to 0 FIRST: restoring an `undefined` original alone would leave 126 behind as the
      // test process's own exit code.
      process.exitCode = 0;
      if (before !== undefined) process.exitCode = before;
    }
  });
});
