import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";

import "../../test/helpers/cli-mocks.ts";
import { clearFixture, setFixture } from "../../test/helpers/cli-mocks.ts";

const mod = await import("./ask.ts");
const { runAsk } = mod;

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

describe("runAsk — usage / preconditions", () => {
  beforeEach(() => {
    stdoutChunks.length = 0;
    stderrChunks.length = 0;
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
    stderrChunks.length = 0;
    installStreamCapture();
  });
  afterEach(() => {
    clearFixture();
    restoreStreams();
  });

  it("prints onboarding hint and returns when connector list is empty", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    setFixture({
      gatewayState: { socketPath: "/tmp/fake.sock" },
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
      gatewayState: { socketPath: "/tmp/fake.sock" },
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
      gatewayState: { socketPath: "/tmp/fake.sock" },
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
      gatewayState: { socketPath: "/tmp/fake.sock" },
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

  it("skips assistant session.append when reply is empty / whitespace", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    setFixture({
      gatewayState: { socketPath: "/tmp/fake.sock" },
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
      gatewayState: { socketPath: "/tmp/fake.sock" },
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
    const chunkText = (assistantAppend?.params as { chunkText: string }).chunkText;
    expect(chunkText.length).toBe(8000);
  });
});
