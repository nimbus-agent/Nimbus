import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";

import { clearFixture, FAKE_SOCKET_PATH, setFixture } from "../../test/helpers/cli-mocks.ts";
import { createStreamCapture } from "../../test/helpers/stream-capture.ts";

const mod = await import("./ask.ts");
const { runAsk } = mod;

// stdout carries command output; stderr carries the no-LLM setup guidance.
const {
  stderrChunks,
  stdoutChunks,
  install: installStreamCapture,
  restore: restoreStreams,
} = createStreamCapture();

afterAll(() => {
  restoreStreams();
});

describe("runAsk — usage / preconditions", () => {
  beforeEach(() => {
    stdoutChunks.length = 0;
    installStreamCapture();
  });
  afterEach(() => {
    clearFixture();
    restoreStreams();
  });

  it("throws when query is empty", async () => {
    await expect(runAsk([])).rejects.toThrow(/Usage: nimbus ask/);
  });

  it("throws when query is only whitespace", async () => {
    await expect(runAsk(["   "])).rejects.toThrow(/Usage: nimbus ask/);
  });

  it("throws when --session is given but query is empty", async () => {
    await expect(runAsk(["--session", "s1"])).rejects.toThrow(/Usage: nimbus ask/);
  });

  it("throws when gateway is not running", async () => {
    setFixture({});
    await expect(runAsk(["hello"])).rejects.toThrow(/Gateway is not running/);
  });
});

describe("runAsk — happy paths", () => {
  beforeEach(() => {
    stdoutChunks.length = 0;
    installStreamCapture();
  });
  afterEach(() => {
    clearFixture();
    restoreStreams();
  });

  it("prints onboarding hint and returns when connector list is empty", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: async (method: string, params: unknown) => {
          calls.push({ method, params });
          if (method === "connector.listStatus") return [];
          return undefined;
        },
        connect: async () => {},
        disconnect: async () => {},
        onNotification: () => {},
      },
    });
    await runAsk(["hello", "world"]);
    expect(stdoutChunks.join("")).toContain("No connectors are registered");
    expect(stdoutChunks.join("")).toContain("nimbus connector auth github");
    expect(calls.map((c) => c.method)).toEqual(["connector.listStatus"]);
  });

  it("prints onboarding hint when listStatus returns a non-array", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: async (method: string, params: unknown) => {
          calls.push({ method, params });
          if (method === "connector.listStatus") return null;
          return undefined;
        },
        connect: async () => {},
        disconnect: async () => {},
        onNotification: () => {},
      },
    });
    await runAsk(["hello"]);
    expect(stdoutChunks.join("")).toContain("No connectors are registered");
    expect(calls.map((c) => c.method)).toEqual(["connector.listStatus"]);
  });

  it("happy path: invokes agent.invoke with input + stream=true and no session.append", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: async (method: string, params: unknown) => {
          calls.push({ method, params });
          if (method === "connector.listStatus") return [{ serviceId: "github" }];
          if (method === "agent.invoke") return { reply: "" };
          return undefined;
        },
        connect: async () => {},
        disconnect: async () => {},
        onNotification: () => {},
      },
    });
    await runAsk(["summarize", "my", "week"]);
    expect(calls.map((c) => c.method)).toEqual(["connector.listStatus", "agent.invoke"]);
    expect(calls[1]?.params).toMatchObject({
      input: "summarize my week",
      stream: true,
    });
    expect(calls.find((c) => c.method === "session.append")).toBeUndefined();
  });

  it("forwards --session + --agent + writes user/assistant session.append entries", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: async (method: string, params: unknown) => {
          calls.push({ method, params });
          if (method === "connector.listStatus") return [{ serviceId: "github" }];
          if (method === "agent.invoke") return { reply: "answer text" };
          return undefined;
        },
        connect: async () => {},
        disconnect: async () => {},
        onNotification: () => {},
      },
    });
    await runAsk(["--session", "sess-1", "--agent", "expert", "ping"]);
    const invokeCall = calls.find((c) => c.method === "agent.invoke");
    expect(invokeCall?.params).toMatchObject({
      input: "ping",
      stream: true,
      sessionId: "sess-1",
      agent: "expert",
    });
    const sessionAppends = calls.filter((c) => c.method === "session.append");
    expect(sessionAppends).toHaveLength(2);
    expect(sessionAppends[0]?.params).toEqual({
      sessionId: "sess-1",
      chunkText: "ping",
      role: "user",
    });
    expect(sessionAppends[1]?.params).toEqual({
      sessionId: "sess-1",
      chunkText: "answer text",
      role: "assistant",
    });
  });

  it("forwards --devil and keeps it out of the query text", async () => {
    // The flag is consumed by the parser, not joined into the question — otherwise the model
    // is asked to reason about the literal string "--devil".
    const calls: Array<{ method: string; params: unknown }> = [];
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: async (method: string, params: unknown) => {
          calls.push({ method, params });
          if (method === "connector.listStatus") return [{ serviceId: "github" }];
          if (method === "agent.invoke") return { reply: "here is the counter-case" };
          return undefined;
        },
        connect: async () => {},
        disconnect: async () => {},
        onNotification: () => {},
      },
    });
    await runAsk(["--devil", "ship", "the", "migration", "tonight"]);
    const invokeCall = calls.find((c) => c.method === "agent.invoke");
    expect(invokeCall?.params).toMatchObject({
      input: "ship the migration tonight",
      devil: true,
    });
  });

  it("omits devil entirely when the flag is absent", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: async (method: string, params: unknown) => {
          calls.push({ method, params });
          if (method === "connector.listStatus") return [{ serviceId: "github" }];
          if (method === "agent.invoke") return { reply: "ok" };
          return undefined;
        },
        connect: async () => {},
        disconnect: async () => {},
        onNotification: () => {},
      },
    });
    await runAsk(["what", "changed"]);
    const invokeCall = calls.find((c) => c.method === "agent.invoke");
    // Asserted on a definitely-present call rather than through an optional chain, so a
    // missing `agent.invoke` fails loudly here instead of passing as an absent `devil`.
    expect(invokeCall).toBeDefined();
    const params = invokeCall?.params as Record<string, unknown> | undefined;
    expect(params?.["devil"]).toBeUndefined();
  });

  it("skips assistant session.append when reply is empty / whitespace", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: async (method: string, params: unknown) => {
          calls.push({ method, params });
          if (method === "connector.listStatus") return [{ serviceId: "github" }];
          if (method === "agent.invoke") return { reply: "   " };
          return undefined;
        },
        connect: async () => {},
        disconnect: async () => {},
        onNotification: () => {},
      },
    });
    await runAsk(["--session", "sess-2", "hello"]);
    const sessionAppends = calls.filter((c) => c.method === "session.append");
    expect(sessionAppends).toHaveLength(1);
    expect(sessionAppends[0]?.params).toMatchObject({ role: "user" });
  });

  it("truncates assistant reply to 8000 chars when persisted to session", async () => {
    const longReply = "x".repeat(9000);
    const calls: Array<{ method: string; params: unknown }> = [];
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: async (method: string, params: unknown) => {
          calls.push({ method, params });
          if (method === "connector.listStatus") return [{ serviceId: "github" }];
          if (method === "agent.invoke") return { reply: longReply };
          return undefined;
        },
        connect: async () => {},
        disconnect: async () => {},
        onNotification: () => {},
      },
    });
    await runAsk(["--session", "sess-3", "x"]);
    const assistantAppend = calls
      .filter((c) => c.method === "session.append")
      .find((c) => (c.params as { role: string }).role === "assistant");
    const chunkText = (assistantAppend?.params as { chunkText: string } | undefined)?.chunkText;
    expect(chunkText).toHaveLength(8000);
  });
});

describe("runAsk — no LLM configured", () => {
  // Mirrors NO_LLM_SENTINEL in gateway/src/engine/gateway-agent-error.ts, which
  // has its own test pinning the constant. The CLI cannot import gateway source
  // and the JSON-RPC transport drops the numeric error code, so a substring
  // match on the message is the only seam available.
  const SENTINEL = "Nimbus needs an LLM for this command.";

  beforeEach(() => {
    stdoutChunks.length = 0;
    stderrChunks.length = 0;
    installStreamCapture();
  });
  afterEach(() => {
    clearFixture();
    restoreStreams();
    process.exitCode = 0;
  });

  function fixtureThatRejectsInvoke(message: string): void {
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: async (method: string) => {
          if (method === "connector.listStatus") return [{ serviceId: "filesystem" }];
          if (method === "agent.invoke") throw new Error(message);
          return undefined;
        },
        connect: async () => {},
        disconnect: async () => {},
        onNotification: () => {},
      },
    });
  }

  it("prints the setup guidance and exits non-zero instead of a raw error", async () => {
    fixtureThatRejectsInvoke(
      [SENTINEL, "", "  Local  — install Ollama, then in nimbus.toml:"].join("\n"),
    );
    await runAsk(["summarize", "my", "week"]);
    const err = stderrChunks.join("");
    expect(err).toContain(SENTINEL);
    expect(err).toContain("install Ollama");
    expect(process.exitCode).toBe(1);
  });

  it("does not swallow unrelated agent failures", async () => {
    // Only the no-LLM case is guidance; everything else must keep propagating
    // so the top-level handler still reports it.
    fixtureThatRejectsInvoke("Anthropic rate limit hit.");
    await expect(runAsk(["hello"])).rejects.toThrow(/rate limit/);
  });
});
