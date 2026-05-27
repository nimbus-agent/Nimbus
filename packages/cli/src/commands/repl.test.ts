// packages/cli/src/commands/repl.test.ts
//
// `repl.ts` exposes two test entry points:
//   - `parseReplArgs(args)` — pure parser
//   - `runReplTurn(client, q, sessionId, write)` — single-turn execute
// The full `runRepl()` is the readline event loop and is NOT tested here
// (per the Phase 6 plan: "only test the parse-and-execute helper, NOT
// the readline event loop").

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";

import "../../test/helpers/cli-mocks.ts"; // module-load side effects only
import { clearFixture, setFixture } from "../../test/helpers/cli-mocks.ts";
import { captureOutput } from "../../test/helpers/cli-output.ts";
import { createMockIpcClient } from "../../test/helpers/mock-ipc-client.ts";

const replMod = await import("./repl.ts");
const { loadReplPreconditions, parseReplArgs, runRepl, runReplTurn } = replMod;

const out = captureOutput();

afterAll(() => {
  out.restore();
});

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
  afterEach(() => {
    clearFixture();
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
    expect((mock.calls[1]?.params as Record<string, unknown>)["role"]).toBe("user");
  });

  it("truncates assistant chunkText to 8000 chars", async () => {
    const big = "a".repeat(9000);
    const mock = createMockIpcClient([{ reply: big }, null, null]);
    await runReplTurn(mock.client, "hi", "sess-1", write);
    const assistantCall = mock.calls[2];
    const params = assistantCall?.params as Record<string, unknown>;
    expect(String(params["chunkText"]).length).toBe(8000);
  });
});

// `runRepl(args)` is the full dispatcher — it gates on `readGatewayState`
// and then drives the readline event loop. Testing the full dispatcher's
// "Gateway is not running" branch via `expect(runRepl([])).rejects` is
// flaky on CI Linux + macOS for reasons that we suspect involve readline
// EOF handling interacting with the harness's mock-timing. We instead
// test the smaller, pure-async `loadReplPreconditions(args)` helper that
// performs only the parse + gate check.
describe("loadReplPreconditions (REPL gate)", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("throws when gateway is not running", async () => {
    setFixture({});
    await expect(loadReplPreconditions([])).rejects.toThrow(
      /Gateway is not running\. Start with: nimbus start/,
    );
  });

  it("returns the socketPath + parsed sessionId when gateway state is present", async () => {
    setFixture({ gatewayState: { socketPath: "/tmp/fake.sock" } });
    const out = await loadReplPreconditions(["--session", "sess-9"]);
    expect(out.socketPath).toBe("/tmp/fake.sock");
    expect(out.sessionId).toBe("sess-9");
  });
});

describe("runRepl (readline loop, injected interface)", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  // Inject a stub readline interface so the loop runs deterministically — no
  // process-global mock.module of node:readline/promises, which is unreliable
  // in the combined CLI test process (a sibling mock.restore() clears it).
  function fakeInterface(answers: string[]): Parameters<typeof runRepl>[1] {
    let idx = 0;
    return (() => ({
      question: async (): Promise<string> => {
        const answer = answers[idx] ?? "exit";
        idx += 1;
        return answer;
      },
      close: (): void => {},
    })) as unknown as Parameters<typeof runRepl>[1];
  }

  it("exits the loop on `exit` without running a turn", async () => {
    const mockIpc = createMockIpcClient([]);
    setFixture({ gatewayState: { socketPath: "/tmp/fake.sock" }, ipcClient: mockIpc.client });
    await runRepl([], fakeInterface(["exit"]));
    // "exit" breaks the loop before any turn, so no agent.invoke is issued.
    expect(mockIpc.calls).toHaveLength(0);
  });

  it("runs one turn then quits", async () => {
    const mockIpc = createMockIpcClient([{ reply: "all good" }]);
    setFixture({ gatewayState: { socketPath: "/tmp/fake.sock" }, ipcClient: mockIpc.client });
    await runRepl([], fakeInterface(["what is up", "quit"]));
    expect(mockIpc.calls[0]?.method).toBe("agent.invoke");
  });
});
