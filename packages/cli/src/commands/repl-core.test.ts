import { afterAll, beforeEach, describe, expect, it } from "bun:test";

import { captureOutput } from "../../test/helpers/cli-output.ts";
import { type CallRecord, createMockIpcClient } from "../../test/helpers/mock-ipc-client.ts";
import { createStreamCapture } from "../../test/helpers/stream-capture.ts";
import type { IPCClient } from "../ipc-client/index.ts";
import type { CliPlatformPaths } from "../paths.ts";
import {
  loadReplPreconditions,
  parseReplArgs,
  type ReplCoreDeps,
  type ReplGatewayState,
  runRepl,
  runReplTurn,
} from "./repl-core.ts";

const out = captureOutput();

afterAll(() => {
  out.restore();
});

const FAKE_PATHS = {} as unknown as CliPlatformPaths;

function makeDeps(overrides: Partial<ReplCoreDeps> = {}): ReplCoreDeps {
  return {
    readGatewayState: async (): Promise<ReplGatewayState | undefined> => undefined,
    getCliPlatformPaths: (): CliPlatformPaths => FAKE_PATHS,
    makeClient: (): IPCClient => createMockIpcClient([]).client,
    registerHandlers: (): void => {},
    ...overrides,
  };
}

describe("parseReplArgs", () => {
  it("returns sessionId=undefined when no --session flag", () => {
    expect(parseReplArgs([])).toEqual({ sessionId: undefined });
    expect(parseReplArgs(["foo", "bar"])).toEqual({ sessionId: undefined });
  });

  it("returns the value after --session", () => {
    expect(parseReplArgs(["--session", "sess-123"])).toEqual({ sessionId: "sess-123" });
  });

  it("ignores --session at the end without a value", () => {
    expect(parseReplArgs(["--session"])).toEqual({ sessionId: undefined });
  });
});

describe("runReplTurn", () => {
  let writes: string[];
  let write: (s: string) => void;

  beforeEach(() => {
    out.reset();
    writes = [];
    write = (s: string): void => {
      writes.push(s);
    };
  });

  it("calls agent.invoke and writes the reply when non-empty", async () => {
    const mock = createMockIpcClient([{ reply: "Hello!" }]);
    const result = await runReplTurn(mock.client, "Hi there", undefined, write);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]).toEqual({
      method: "agent.invoke",
      params: { input: "Hi there", stream: true },
    });
    expect(writes.join("")).toContain("Hello!");
    expect(result).toBe("Hello!");
  });

  it("does not write when reply is the empty string", async () => {
    const mock = createMockIpcClient([{ reply: "" }]);
    await runReplTurn(mock.client, "ping", undefined, write);
    expect(writes).toHaveLength(0);
  });

  it("appends both user + assistant chunks to the session when sessionId is set", async () => {
    const mock = createMockIpcClient([{ reply: "yo" }, null, null]);
    await runReplTurn(mock.client, "hi", "sess-1", write);
    expect(mock.calls).toHaveLength(3);
    expect(mock.calls[0]).toEqual({
      method: "agent.invoke",
      params: { input: "hi", stream: true, sessionId: "sess-1" },
    });
    expect(mock.calls[1]).toEqual({
      method: "session.append",
      params: { sessionId: "sess-1", chunkText: "hi", role: "user" },
    });
    expect(mock.calls[2]).toEqual({
      method: "session.append",
      params: { sessionId: "sess-1", chunkText: "yo", role: "assistant" },
    });
  });

  it("skips assistant append when reply is blank/whitespace but still writes user append", async () => {
    const mock = createMockIpcClient([{ reply: "   " }, null]);
    await runReplTurn(mock.client, "hi", "sess-1", write);
    expect(mock.calls).toHaveLength(2);
    expect(mock.calls[1]?.method).toBe("session.append");
    expect((mock.calls[1]?.params as Record<string, unknown> | undefined)?.["role"]).toBe("user");
  });

  it("a reply that is not a string counts as empty: nothing written, '' returned, no assistant append", async () => {
    const mock = createMockIpcClient([{ reply: 42 }, null]);
    const result = await runReplTurn(mock.client, "hi", "sess-1", write);
    expect(result).toBe("");
    expect(writes).toHaveLength(0);
    expect(mock.calls).toEqual([
      { method: "agent.invoke", params: { input: "hi", stream: true, sessionId: "sess-1" } },
      { method: "session.append", params: { sessionId: "sess-1", chunkText: "hi", role: "user" } },
    ]);
  });

  it("truncates assistant chunkText to 8000 chars", async () => {
    const big = "a".repeat(9000);
    const mock = createMockIpcClient([{ reply: big }, null, null]);
    await runReplTurn(mock.client, "hi", "sess-1", write);
    const assistantCall = mock.calls[2];
    const params = assistantCall?.params as Record<string, unknown>;
    expect(String(params["chunkText"])).toHaveLength(8000);
  });
});

describe("loadReplPreconditions (REPL gate)", () => {
  beforeEach(() => {
    out.reset();
  });

  it("throws when gateway is not running", async () => {
    const deps = makeDeps({ readGatewayState: async () => undefined });
    await expect(loadReplPreconditions([], deps)).rejects.toThrow(
      /Gateway is not running\. Start with: nimbus start/,
    );
  });

  it("returns the socketPath + parsed sessionId when gateway state is present", async () => {
    const deps = makeDeps({
      readGatewayState: async () => ({ socketPath: "/tmp/fake.sock" }),
    });
    const result = await loadReplPreconditions(["--session", "sess-9"], deps);
    expect(result.socketPath).toBe("/tmp/fake.sock");
    expect(result.sessionId).toBe("sess-9");
  });
});

function fakeInterface(answers: string[]): Parameters<typeof runRepl>[2] {
  let idx = 0;
  return (() => ({
    question: async (): Promise<string> => {
      const answer = answers[idx] ?? "exit";
      idx += 1;
      return answer;
    },
    close: (): void => {},
  })) as unknown as Parameters<typeof runRepl>[2];
}

describe("runRepl (readline loop, injected interface)", () => {
  beforeEach(() => {
    out.reset();
  });

  it("drives the readline loop and exits cleanly on `exit`", async () => {
    const mockIpc = createMockIpcClient([]);
    let handlersRegistered = 0;
    const deps = makeDeps({
      readGatewayState: async () => ({ socketPath: "/tmp/fake.sock" }),
      makeClient: () => mockIpc.client,
      registerHandlers: () => {
        handlersRegistered += 1;
      },
    });
    await runRepl([], deps, fakeInterface(["exit"]));
    expect(handlersRegistered).toBe(1);
    expect(mockIpc.calls).toHaveLength(0);
  });

  /** A readline stand-in that answers `answers` in order and records whether it was closed. */
  function recordingInterface(answers: string[]): {
    make: Parameters<typeof runRepl>[2];
    prompts: () => number;
    closed: () => boolean;
  } {
    let asked = 0;
    let closed = false;
    const make = (() => ({
      question: async (): Promise<string> => {
        const answer = answers[asked] ?? "exit";
        asked += 1;
        return answer;
      },
      close: (): void => {
        closed = true;
      },
    })) as unknown as Parameters<typeof runRepl>[2];
    return { make, prompts: () => asked, closed: () => closed };
  }

  /** The mock IPC client with its `disconnect` counted. */
  function countingClient(responses: readonly unknown[]): {
    client: IPCClient;
    calls: CallRecord[];
    disconnects: () => number;
  } {
    const mock = createMockIpcClient(responses);
    let disconnects = 0;
    const client = {
      ...(mock.client as unknown as Record<string, unknown>),
      disconnect: async (): Promise<void> => {
        disconnects += 1;
      },
    } as unknown as IPCClient;
    return { client, calls: mock.calls, disconnects: () => disconnects };
  }

  it("runs one turn per trimmed question, prints the reply, and leaves on `quit`", async () => {
    const ipc = countingClient([{ reply: "pong" }]);
    const rl = recordingInterface(["  ping  ", "quit"]);
    const deps = makeDeps({
      readGatewayState: async () => ({ socketPath: "fake-repl.sock" }),
      makeClient: () => ipc.client,
    });
    const cap = createStreamCapture();
    cap.install();
    try {
      await runRepl([], deps, rl.make);
    } finally {
      cap.restore();
    }
    expect(ipc.calls).toEqual([
      { method: "agent.invoke", params: { input: "ping", stream: true } },
    ]);
    expect(cap.stdoutChunks.join("")).toContain("\npong\n");
    expect(rl.prompts()).toBe(2);
    expect(rl.closed()).toBe(true);
    expect(ipc.disconnects()).toBe(1);
  });

  it("a blank line ends the REPL without a turn, still closing readline and the connection", async () => {
    const ipc = countingClient([]);
    const rl = recordingInterface(["   ", "never asked"]);
    const deps = makeDeps({
      readGatewayState: async () => ({ socketPath: "fake-repl.sock" }),
      makeClient: () => ipc.client,
    });
    const cap = createStreamCapture();
    cap.install();
    try {
      await runRepl([], deps, rl.make);
    } finally {
      cap.restore();
    }
    expect(ipc.calls).toHaveLength(0);
    expect(rl.prompts()).toBe(1);
    expect(rl.closed()).toBe(true);
    expect(ipc.disconnects()).toBe(1);
  });

  it("with no interface injected, a gateway that is not running fails before readline exists", async () => {
    // The default `makeInterface` is the real readline over process.stdin; reaching it would block
    // on a terminal. The precondition must refuse first.
    let clientMade = false;
    const deps = makeDeps({
      readGatewayState: async () => undefined,
      makeClient: () => {
        clientMade = true;
        return createMockIpcClient([]).client;
      },
    });
    await expect(runRepl([], deps)).rejects.toThrow(
      "Gateway is not running. Start with: nimbus start",
    );
    expect(clientMade).toBe(false);
  });
});
