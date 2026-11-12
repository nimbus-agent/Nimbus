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
      stream: true,
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

  it("a result with no asOfMs warns on stderr and sets a non-zero exit code", async () => {
    fixture({ reply: "old answer" });
    await runAsk(["hello", "--at", "-2h"]);
    expect(stderrChunks.join("")).toContain("this gateway does not support --at");
    expect(stderrChunks.join("")).toContain("CURRENT data");
    expect(process.exitCode).toBe(1);
  });

  it("the usage line names --at", async () => {
    await expect(runAsk([])).rejects.toThrow(/\[--at <time>\]/);
  });
});
