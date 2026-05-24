import { afterAll, afterEach, beforeEach, describe, expect, it, test } from "bun:test";

import "../../test/helpers/cli-mocks.ts"; // module-load side effects
import { clearFixture, setFixture } from "../../test/helpers/cli-mocks.ts";

const mod = await import("./expert.ts");
const { parseExpertArgs, runExpertCli } = mod;

describe("parseExpertArgs", () => {
  test("captures topicOrFile from positional arg", () => {
    const out = parseExpertArgs(["src/billing/retry.ts"]);
    expect(out.topicOrFile).toBe("src/billing/retry.ts");
    expect(out.json).toBe(false);
    expect(out.limit).toBeUndefined();
  });

  test("--json flag", () => {
    const out = parseExpertArgs(["src/x.ts", "--json"]);
    expect(out.json).toBe(true);
  });

  test("--limit N", () => {
    const out = parseExpertArgs(["src/x.ts", "--limit", "10"]);
    expect(out.limit).toBe(10);
  });

  test("rejects missing topic", () => {
    expect(() => parseExpertArgs([])).toThrow(/Usage/);
  });

  test("rejects --limit > 25", () => {
    expect(() => parseExpertArgs(["x", "--limit", "30"])).toThrow(/1\.\.25/);
  });

  test("rejects --limit followed by another flag", () => {
    expect(() => parseExpertArgs(["x", "--limit", "--json"])).toThrow(/1\.\.25/);
  });

  test("multi-word topic", () => {
    const out = parseExpertArgs(["payment", "retry", "logic"]);
    expect(out.topicOrFile).toBe("payment retry logic");
  });
});

// ----------------------------------------------------------------------
// process.stdout / process.stderr / process.exit capture for dispatcher.
// ----------------------------------------------------------------------

const stdoutChunks: string[] = [];
const stderrChunks: string[] = [];
const origStdoutWrite = process.stdout.write.bind(process.stdout);
const origStderrWrite = process.stderr.write.bind(process.stderr);
const origExit = process.exit.bind(process);

function installStreamCapture(): void {
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderrChunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  }) as typeof process.stderr.write;
  process.exit = ((code?: number): never => {
    throw new Error(`process.exit(${code ?? ""})`);
  }) as typeof process.exit;
}

function restoreStreams(): void {
  process.stdout.write = origStdoutWrite;
  process.stderr.write = origStderrWrite;
  process.exit = origExit;
}

afterAll(() => {
  restoreStreams();
});

function makeValidExpertBrief(opts: { emptyIndex?: boolean } = {}): unknown {
  return {
    kind: "expert",
    agentVersion: 1,
    generatedAt: 1_700_000_000,
    latencyMs: 12,
    gaps: opts.emptyIndex ? [{ category: "empty_index", detail: "no items" }] : [],
    ranked: [],
    query: { topicOrFile: "topic" },
  };
}

describe("runExpertCli — dispatcher", () => {
  beforeEach(() => {
    stdoutChunks.length = 0;
    stderrChunks.length = 0;
    installStreamCapture();
  });
  afterEach(() => {
    clearFixture();
    restoreStreams();
  });

  it("exits 1 when gateway is not running", async () => {
    setFixture({});
    await expect(runExpertCli(["topic"])).rejects.toThrow("process.exit(1)");
    expect(stderrChunks.join("")).toContain("Gateway is not running");
  });

  it("happy path: prints Markdown brief on expert.briefReady", async () => {
    const handlers = new Map<string, (params: unknown) => void>();
    setFixture({
      gatewayState: { socketPath: "/tmp/fake.sock" },
      ipcClient: {
        call: async (method: string) => {
          if (method === "agents.expert") {
            // Emit the briefReady asynchronously so the await on the
            // initial call resolves and the briefPromise is awaited.
            setTimeout(() => {
              handlers.get("expert.briefReady")?.({
                sessionId: "sess-1",
                brief: "# Expert Brief\n\nlocated owners",
                findings: makeValidExpertBrief(),
              });
            }, 0);
            return { sessionId: "sess-1" };
          }
          return undefined;
        },
        connect: async () => {},
        disconnect: async () => {},
        onNotification: (event: string, handler: (params: unknown) => void) => {
          handlers.set(event, handler);
        },
      },
    });
    await runExpertCli(["topic"]);
    expect(stdoutChunks.join("")).toContain("# Expert Brief");
    expect(stdoutChunks.join("")).toContain("located owners");
  });

  it("--json prints the structured findings instead of the Markdown brief", async () => {
    const handlers = new Map<string, (params: unknown) => void>();
    setFixture({
      gatewayState: { socketPath: "/tmp/fake.sock" },
      ipcClient: {
        call: async (method: string) => {
          if (method === "agents.expert") {
            setTimeout(() => {
              handlers.get("expert.briefReady")?.({
                sessionId: "sess-1",
                brief: "# md",
                findings: makeValidExpertBrief(),
              });
            }, 0);
            return { sessionId: "sess-1" };
          }
          return undefined;
        },
        connect: async () => {},
        disconnect: async () => {},
        onNotification: (event: string, handler: (params: unknown) => void) => {
          handlers.set(event, handler);
        },
      },
    });
    await runExpertCli(["topic", "--json"]);
    const out = stdoutChunks.join("");
    expect(out).toContain('"kind": "expert"');
    expect(out).toContain('"agentVersion": 1');
    expect(out).not.toContain("# md");
  });

  it("exits 1 with hint when findings include an empty_index gap", async () => {
    const handlers = new Map<string, (params: unknown) => void>();
    setFixture({
      gatewayState: { socketPath: "/tmp/fake.sock" },
      ipcClient: {
        call: async (method: string) => {
          if (method === "agents.expert") {
            setTimeout(() => {
              handlers.get("expert.briefReady")?.({
                sessionId: "sess-1",
                brief: "brief",
                findings: makeValidExpertBrief({ emptyIndex: true }),
              });
            }, 0);
            return { sessionId: "sess-1" };
          }
          return undefined;
        },
        connect: async () => {},
        disconnect: async () => {},
        onNotification: (event: string, handler: (params: unknown) => void) => {
          handlers.set(event, handler);
        },
      },
    });
    // Note: the first process.exit(1) call throws our stubbed error, which the
    // try/catch then handles and triggers a second process.exit(2). In real
    // execution the process exits at the first call, but the stderr message
    // is what matters — it must contain the empty-index hint.
    await expect(runExpertCli(["topic"])).rejects.toThrow(/process\.exit/);
    expect(stderrChunks.join("")).toContain("No data indexed yet");
  });

  it("exits 2 when briefReady payload is malformed", async () => {
    const handlers = new Map<string, (params: unknown) => void>();
    setFixture({
      gatewayState: { socketPath: "/tmp/fake.sock" },
      ipcClient: {
        call: async (method: string) => {
          if (method === "agents.expert") {
            setTimeout(() => {
              handlers.get("expert.briefReady")?.({
                sessionId: "sess-1",
                brief: 42, // wrong type
                findings: {},
              });
            }, 0);
            return { sessionId: "sess-1" };
          }
          return undefined;
        },
        connect: async () => {},
        disconnect: async () => {},
        onNotification: (event: string, handler: (params: unknown) => void) => {
          handlers.set(event, handler);
        },
      },
    });
    await expect(runExpertCli(["topic"])).rejects.toThrow("process.exit(2)");
    expect(stderrChunks.join("")).toContain("Malformed");
  });

  it("exits 2 when expert.briefError fires", async () => {
    const handlers = new Map<string, (params: unknown) => void>();
    setFixture({
      gatewayState: { socketPath: "/tmp/fake.sock" },
      ipcClient: {
        call: async (method: string) => {
          if (method === "agents.expert") {
            setTimeout(() => {
              handlers.get("expert.briefError")?.({ error: "synth failure" });
            }, 0);
            return { sessionId: "sess-1" };
          }
          return undefined;
        },
        connect: async () => {},
        disconnect: async () => {},
        onNotification: (event: string, handler: (params: unknown) => void) => {
          handlers.set(event, handler);
        },
      },
    });
    await expect(runExpertCli(["topic"])).rejects.toThrow("process.exit(2)");
    expect(stderrChunks.join("")).toContain("synth failure");
  });

  it("forwards --limit to the agents.expert IPC call", async () => {
    const handlers = new Map<string, (params: unknown) => void>();
    let agentCallParams: unknown;
    setFixture({
      gatewayState: { socketPath: "/tmp/fake.sock" },
      ipcClient: {
        call: async (method: string, params: unknown) => {
          if (method === "agents.expert") {
            agentCallParams = params;
            setTimeout(() => {
              handlers.get("expert.briefReady")?.({
                sessionId: "s",
                brief: "x",
                findings: makeValidExpertBrief(),
              });
            }, 0);
            return { sessionId: "s" };
          }
          return undefined;
        },
        connect: async () => {},
        disconnect: async () => {},
        onNotification: (event: string, handler: (params: unknown) => void) => {
          handlers.set(event, handler);
        },
      },
    });
    await runExpertCli(["my-topic", "--limit", "5"]);
    expect(agentCallParams).toEqual({ topicOrFile: "my-topic", limit: 5 });
  });
});
