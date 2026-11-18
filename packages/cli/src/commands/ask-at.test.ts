import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";

import { clearFixture, FAKE_SOCKET_PATH, setFixture } from "../../test/helpers/cli-mocks.ts";
import { createStreamCapture } from "../../test/helpers/stream-capture.ts";

const { runAsk } = await import("./ask.ts");

const {
  stderrChunks,
  stdoutChunks,
  install: installStreamCapture,
  restore: restoreStreams,
} = createStreamCapture();

afterAll(() => {
  restoreStreams();
});

type Call = { method: string; params: unknown };

function fixture(invokeResult: unknown): Call[] {
  const calls: Call[] = [];
  setFixture({
    gatewayState: { socketPath: FAKE_SOCKET_PATH },
    ipcClient: {
      call: async (method: string, params: unknown) => {
        calls.push({ method, params });
        if (method === "connector.listStatus") return [{ serviceId: "github" }];
        if (method === "agent.invoke") return invokeResult;
        return undefined;
      },
      connect: async () => {},
      disconnect: async () => {},
      onNotification: () => {},
    },
  });
  return calls;
}

describe("runAsk --at", () => {
  beforeEach(() => {
    stdoutChunks.length = 0;
    stderrChunks.length = 0;
    process.exitCode = 0;
    installStreamCapture();
  });
  afterEach(() => {
    clearFixture();
    restoreStreams();
    process.exitCode = 0;
  });

  it("consumes --at and its value (never joined into the question) and forwards it as `at`", async () => {
    const calls = fixture({ reply: "", asOfMs: 123 });
    await runAsk(["which", "--at", "yesterday-09:00", "PRs", "were", "open"]);
    const invoke = calls.find((c) => c.method === "agent.invoke");
    expect(invoke?.params).toMatchObject({
      input: "which PRs were open",
      stream: false,
      at: "yesterday-09:00",
    });
    expect(stderrChunks.join("")).toBe("");
    expect(process.exitCode).toBe(0);
  });

  it("a relative value that starts with a single dash is a value, not a flag", async () => {
    const calls = fixture({ reply: "", asOfMs: 1 });
    await runAsk(["--at", "-2h", "what", "changed"]);
    expect(calls.find((c) => c.method === "agent.invoke")?.params).toMatchObject({
      input: "what changed",
      at: "-2h",
    });
  });

  it("without --at the params carry no `at` and no warning is printed", async () => {
    const calls = fixture({ reply: "" });
    await runAsk(["what", "changed"]);
    expect(calls.find((c) => c.method === "agent.invoke")?.params).not.toHaveProperty("at");
    expect(stderrChunks.join("")).toBe("");
    expect(process.exitCode).toBe(0);
  });

  it.each([
    ["no value", ["hello", "--at"]],
    ["a blank value", ["hello", "--at", "  "]],
    ["an option as the value", ["hello", "--at", "--devil"]],
  ])("--at with %s throws before any IPC call", async (_label, args) => {
    const calls = fixture({ reply: "" });
    await expect(runAsk(args)).rejects.toThrow(/--at needs a time/);
    expect(calls).toEqual([]);
  });

  it("a result with no asOfMs fails: stderr says why, the reply is NOT printed and no session turn is stored", async () => {
    const calls = fixture({ reply: "old answer" });
    await runAsk(["hello", "--at", "-2h", "--session", "s1"]);
    expect(stderrChunks.join("")).toContain("this gateway does not support --at");
    expect(stderrChunks.join("")).toContain("CURRENT data");
    expect(stdoutChunks.join("")).not.toContain("old answer");
    expect(calls.some((c) => c.method === "session.append")).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it("a point-in-time reply that carries the echo is printed and stored", async () => {
    const calls = fixture({ reply: "historical answer", asOfMs: 5 });
    await runAsk(["hello", "--at", "-2h", "--session", "s1"]);
    expect(stdoutChunks.join("")).toContain("historical answer");
    expect(calls.filter((c) => c.method === "session.append").length).toBeGreaterThan(0);
    expect(process.exitCode).toBe(0);
  });

  it("an ordinary ask still streams", async () => {
    const calls = fixture({ reply: "" });
    await runAsk(["hello"]);
    expect(calls.find((c) => c.method === "agent.invoke")?.params).toMatchObject({ stream: true });
  });

  it("the usage line names --at", async () => {
    await expect(runAsk([])).rejects.toThrow(/\[--at <time>\]/);
  });
});

describe("runAsk --computer (I35, OR-MCU-1)", () => {
  beforeEach(() => {
    stdoutChunks.length = 0;
    stderrChunks.length = 0;
    process.exitCode = 0;
    installStreamCapture();
  });
  afterEach(() => {
    clearFixture();
    restoreStreams();
    process.exitCode = 0;
  });

  it("consumes --computer and its value and forwards it as computerSession, saying where to approve", async () => {
    const calls = fixture({ reply: "done" });
    await runAsk(["open", "--computer", "cu-1", "the", "settings", "page"]);
    expect(calls.find((c) => c.method === "agent.invoke")?.params).toMatchObject({
      input: "open the settings page",
      computerSession: "cu-1",
    });
    expect(stderrChunks.join("")).toContain("terminal running nimbus computer");
  });

  it.each([
    ["no value", ["hello", "--computer"]],
    ["a flag as the value", ["hello", "--computer", "--devil"]],
  ])("--computer with %s is a usage error and nothing is asked", async (_label, args) => {
    const calls = fixture({ reply: "x" });
    await expect(runAsk(args)).rejects.toThrow(/--computer needs/);
    expect(calls.find((c) => c.method === "agent.invoke")).toBeUndefined();
  });

  it("--computer with --at is refused before anything is asked", async () => {
    const calls = fixture({ reply: "x" });
    await expect(runAsk(["hi", "--computer", "cu-1", "--at", "-2h"])).rejects.toThrow(
      /cannot be combined with --at/,
    );
    expect(calls).toEqual([]);
  });
});
