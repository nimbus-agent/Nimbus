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
// STATIC import — deliberately NOT `const replMod = await import("./repl.ts")`.
// The cli-mocks side-effect import above installs the gateway-process /
// ipc-client `mock.module` registrations during its module-load; per ESM
// depth-first evaluation order that runs before this module is evaluated, so
// repl.ts still binds to the mocks (verified: Bun applies a mock.module made
// before a dependency's first import to a static importer too).
//
// Why this matters: a top-level `await import("./repl.ts")` was order-fragile
// in the combined CI test process. Under some file-collection orderings Bun
// resolved the dynamic import to an incompletely-populated namespace, so every
// captured export (parseReplArgs, runReplTurn, loadReplPreconditions, runRepl)
// read back `undefined` — the whole file failed on macOS, and on Linux the
// dropped repl.ts line coverage tripped the 80% coverage-floor (71.6%). A
// static import links deterministically or fails the file load loudly; it can
// never silently yield an empty namespace.
import { loadReplPreconditions, parseReplArgs, runRepl, runReplTurn } from "./repl.ts";

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

  it("drives the readline loop and exits cleanly on `exit`", async () => {
    const mockIpc = createMockIpcClient([]);
    setFixture({ gatewayState: { socketPath: "/tmp/fake.sock" }, ipcClient: mockIpc.client });
    // Covers runRepl's full structure: preconditions, client connect, handler
    // registration, the readline loop, the break, and the finally cleanup.
    // The runReplTurn CALL (one query line) is intentionally NOT exercised
    // here — runReplTurn is covered deterministically by its own describe
    // block above. Driving runReplTurn through runRepl additionally depends on
    // the harness IPC mock surviving the combined CI test process, which is
    // flaky; keep this test free of that dependency.
    await runRepl([], fakeInterface(["exit"]));
    expect(mockIpc.calls).toHaveLength(0);
  });
});
