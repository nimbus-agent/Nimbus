import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  CLACK_CANCEL,
  clearFixture,
  FAKE_SOCKET_PATH,
  fakePath,
  type RecordedClientConstruction,
  setFixture,
} from "../../test/helpers/cli-mocks.ts";
import { createStreamCapture } from "../../test/helpers/stream-capture.ts";
import type { CliPlatformPaths } from "../paths.ts";

// Imported only AFTER cli-mocks has replaced `@clack/prompts`, the gateway-state reader and
// `IPCClient`, so nothing in this file can open a real prompt or reach a real gateway.
const { interactiveCommandDeps, isExplicitApproval, stringArrayOrEmpty } = await import(
  "./approval-broadcast.ts"
);
const { readGatewayState } = await import("./gateway-process.ts");
const { INTERACTIVE_RPC_TIMEOUT_MS } = await import("./rpc-timeouts.ts");
const { isCancel } = await import("@clack/prompts");
const { GatewayNotRunningError } = await import("./with-gateway-ipc.ts");
const { gatewayNotRunningMessage } = await import("./gateway-not-running.ts");
const { runExec } = await import("../commands/exec.ts");
const { runComputer } = await import("../commands/computer.ts");
const { runTool } = await import("../commands/tool.ts");

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

  test("runWithClient resolves the gateway paths per CALL, so deps built before --demo applies stay demo-rooted (I41)", async () => {
    // Every command builds its deps from this function while its module is being IMPORTED, and
    // `index.ts` imports every command before `applyDemoFlag` sets NIMBUS_DEMO. Paths resolved when
    // the deps are BUILT would therefore be the real install's, and `nimbus --demo exec` would dial
    // the real gateway. Every other test here passes that, because the fixture's state reader
    // ignores the paths it is handed; the demo-aware "not running" hint is what tells the roots apart.
    const ENV = ["NIMBUS_DEMO", "NIMBUS_CONFIG_DIR", "NIMBUS_GATEWAY_SOCKET"] as const;
    const saved = ENV.map((k) => [k, process.env[k]] as const);
    // Demo refuses alongside either real-root override, so neither may leak in from the shell.
    for (const k of ENV) delete process.env[k];
    try {
      const deps = interactiveCommandDeps(); // built as at import: NIMBUS_DEMO not yet set

      // Premise: the state reader is the fixture's, so neither root's real state file is read and
      // no real gateway can be dialled -- then make it find no gateway at all.
      const state = { socketPath: FAKE_SOCKET_PATH, pid: 4242 };
      setFixture({ gatewayState: state });
      expect(await readGatewayState(fakeCliPaths())).toEqual(state);
      setFixture({});
      // Premise: the two hints differ, so the assertions below can tell the roots apart.
      expect(gatewayNotRunningMessage(true)).not.toBe(gatewayNotRunningMessage(false));

      process.env["NIMBUS_DEMO"] = "1"; // what `applyDemoFlag` does, after every command loaded
      const demo = await deps.runWithClient(async () => "connected").catch((e: unknown) => e);
      expect(demo).toBeInstanceOf(GatewayNotRunningError);
      expect((demo as Error).message).toBe(gatewayNotRunningMessage(true));

      // Per call in the other direction too: the same deps object, demo unset again.
      delete process.env["NIMBUS_DEMO"];
      const real = await deps.runWithClient(async () => "connected").catch((e: unknown) => e);
      expect(real).toBeInstanceOf(GatewayNotRunningError);
      expect((real as Error).message).toBe(gatewayNotRunningMessage(false));
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
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

/**
 * The commands built on the base, each run with its PRODUCTION deps -- no deps argument -- against
 * a fake gateway that raises the command's own approval broadcast inside the blocking call, as the
 * real gate does. Every other test of these commands injects its own `ask` and `runWithClient`, and
 * the tests above prove only the BASE: a command that spread it and then overrode `ask` with an
 * auto-approver, or `runWithClient` with the transport's 30s default, passed all of them.
 */
describe("the commands built on the base answer with its prompt, over its budget", () => {
  const streams = createStreamCapture();
  let savedExitCode: typeof process.exitCode;
  let savedIsTty: PropertyDescriptor | undefined;

  beforeEach(() => {
    savedExitCode = process.exitCode;
    savedIsTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    // `nimbus tool` refuses a non-TTY stdin before it connects, so the approval path needs one.
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
      writable: true,
    });
    streams.stdoutChunks.length = 0;
    streams.stderrChunks.length = 0;
    streams.install();
  });

  afterEach(() => {
    streams.restore();
    if (savedIsTty === undefined) Reflect.deleteProperty(process.stdin, "isTTY");
    else Object.defineProperty(process.stdin, "isTTY", savedIsTty);
    // `?? 0`: Bun ignores `process.exitCode = undefined`, so restoring an unset code that way
    // would leave the code these commands set behind as the test runner's own.
    process.exitCode = savedExitCode ?? 0;
    clearFixture();
  });

  const TOOL_BROADCAST = {
    toolName: "generated_tg_a",
    description: "d",
    body: "return 1;",
    approvedHosts: ["a.example.com"],
    credentialHosts: [],
  };
  // Each command's blocking call, the broadcast its gate raises during it, and the respond method
  // that must carry the owner's answer -- the SAVE broker's own pair for `tool save` (I40).
  const CONSUMERS = [
    {
      name: "nimbus exec",
      file: "commands/exec.ts",
      run: () => runExec(["--code", "1"]),
      call: "exec.run",
      broadcast: "exec.approvalRequest",
      respond: "exec.approvalRespond",
      params: {
        runtime: "bun",
        codeBody: "1",
        grants: { fsRead: [], fsWrite: [], network: [] },
        wallClockMs: 30_000,
        cwd: fakePath("work"),
      },
    },
    {
      name: "nimbus computer browser",
      file: "commands/computer.ts",
      run: () => runComputer(["browser", "--origin", "https://a.example.com"]),
      call: "computer.sessionOpen",
      broadcast: "computer.envelopeRequest",
      respond: "computer.approvalRespond",
      params: {
        sessionId: "s1",
        lane: "browser",
        navigateOrigins: ["https://a.example.com"],
        scriptOrigins: [],
        maxActions: 5,
        maxWallClockMs: 60_000,
      },
    },
    {
      name: "nimbus tool create",
      file: "commands/tool.ts",
      run: () => runTool(["create", "--description", "d", "--host", "a.example.com"]),
      call: "toolgen.create",
      broadcast: "toolgen.approvalRequest",
      respond: "toolgen.approvalRespond",
      params: TOOL_BROADCAST,
    },
    {
      name: "nimbus tool save",
      file: "commands/tool.ts",
      run: () => runTool(["save", "tg_a"]),
      call: "toolgen.save",
      broadcast: "toolgen.saveApprovalRequest",
      respond: "toolgen.saveApprovalRespond",
      params: { ...TOOL_BROADCAST, persistence: true },
    },
  ] as const;

  const ANSWERS: ReadonlyArray<readonly [string, boolean | symbol, boolean]> = [
    ["declines", false, false],
    ["approves", true, true],
    ["cancels the prompt", CLACK_CANCEL, false],
  ];

  for (const c of CONSUMERS) {
    test.each(ANSWERS)(
      `${c.name}: when the owner %s, ${c.respond} carries exactly that`,
      async (_label, answer, approved) => {
        const constructions: RecordedClientConstruction[] = [];
        const handlers = new Map<string, (params: unknown) => unknown>();
        const calls: Array<{ method: string; params: unknown }> = [];
        const state = { socketPath: FAKE_SOCKET_PATH, pid: 4242 };
        setFixture({
          gatewayState: state,
          clackAnswer: answer,
          clientConstructions: constructions,
          ipcClient: {
            connect: async () => {},
            disconnect: async () => {},
            onNotification: (method: string, handler: (params: unknown) => unknown) => {
              handlers.set(method, handler);
            },
            call: async (method: string, params: unknown) => {
              calls.push({ method, params });
              if (method !== c.call) return undefined;
              // The gate raises its broadcast while this call is still pending, and replies after.
              await handlers.get(c.broadcast)?.({ requestId: "req-1", ...c.params });
              return { status: "denied" };
            },
          },
        });
        // Premise: production deps dial whatever the state reader returns -- prove it is this
        // fixture, not the developer's own state file, before letting them connect.
        expect(await readGatewayState(fakeCliPaths())).toEqual(state);

        await c.run();

        expect(calls).toEqual([
          { method: c.call, params: expect.anything() },
          { method: c.respond, params: { requestId: "req-1", approved } },
        ]);
        // One connection, on the INTERACTIVE budget: the call above stays pending while the owner reads.
        expect(constructions).toEqual([
          { socketPath: FAKE_SOCKET_PATH, opts: { requestTimeoutMs: INTERACTIVE_RPC_TIMEOUT_MS } },
        ]);
      },
    );
  }

  test("the table above is TOTAL: every file that builds its deps on the base has a row", async () => {
    // A hand-listed table silently omits the next command to adopt the base -- the one most likely
    // to override a seam after the spread. The adopters are derived from the source instead.
    const SRC = join(import.meta.dir, "..");
    const adopters: string[] = [];
    for (const entry of await readdir(SRC, { recursive: true })) {
      const rel = entry.replaceAll("\\", "/");
      if (
        !/\.tsx?$/.test(rel) ||
        /\.test\.tsx?$/.test(rel) ||
        rel === "lib/approval-broadcast.ts"
      ) {
        continue;
      }
      if (/\binteractiveCommandDeps\(/.test(await readFile(join(SRC, entry), "utf8"))) {
        adopters.push(rel);
      }
    }
    const byName = (a: string, b: string): number => a.localeCompare(b);
    // Premise: the scan finds the adopters that exist today, so an empty result cannot pass.
    expect(adopters.length).toBeGreaterThan(0);
    expect([...adopters].sort(byName)).toEqual(
      [...new Set(CONSUMERS.map((c) => c.file))].sort(byName),
    );
  });
});
