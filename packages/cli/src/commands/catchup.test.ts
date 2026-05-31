import { afterAll, afterEach, beforeEach, describe, expect, it, test } from "bun:test";

import "../../test/helpers/cli-mocks.ts";
import { clearFixture, setFixture } from "../../test/helpers/cli-mocks.ts";

const mod = await import("./catchup.ts");
const { parseCatchupArgs, runCatchupCli } = mod;

describe("parseCatchupArgs", () => {
  test("defaults to sinceMs = 3 days when no flag given", () => {
    const a = parseCatchupArgs([]);
    expect(a.sinceMs).toBe(3 * 24 * 60 * 60 * 1000);
    expect(a.json).toBe(false);
    expect(a.service).toBeUndefined();
  });

  test("parses --since with weeks suffix", () => {
    const a = parseCatchupArgs(["--since", "2w"]);
    expect(a.sinceMs).toBe(2 * 7 * 24 * 60 * 60 * 1000);
  });

  test("parses --since with days suffix", () => {
    const a = parseCatchupArgs(["--since", "7d"]);
    expect(a.sinceMs).toBe(7 * 24 * 60 * 60 * 1000);
  });

  test("rejects --since with invalid syntax", () => {
    expect(() => parseCatchupArgs(["--since", "blah"])).toThrow();
    expect(() => parseCatchupArgs(["--since"])).toThrow();
  });

  test("recognises --json flag", () => {
    const a = parseCatchupArgs(["--json"]);
    expect(a.json).toBe(true);
  });

  test("parses --service", () => {
    const a = parseCatchupArgs(["--service", "github"]);
    expect(a.service).toBe("github");
  });

  test("rejects empty --service", () => {
    expect(() => parseCatchupArgs(["--service", "  "])).toThrow();
  });

  test("rejects unknown positional arguments to avoid silent typos", () => {
    expect(() => parseCatchupArgs(["something"])).toThrow();
  });

  test("clamps sinceMs at 90 days", () => {
    expect(() => parseCatchupArgs(["--since", "365d"])).toThrow(/90 days/);
  });
});

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

function makeValidCatchupBrief(opts: { emptyIndex?: boolean } = {}): unknown {
  return {
    kind: "catchup",
    agentVersion: 1,
    generatedAt: 1_700_000_000,
    latencyMs: 12,
    gaps: opts.emptyIndex ? [{ category: "empty_index", detail: "no items" }] : [],
    sections: [],
    selfPersonId: null,
    involvement: {
      ownedServices: [],
      activeRepos: [],
      incidentServices: [],
      collaboratorPersonIds: [],
    },
    query: { sinceMs: 3 * 24 * 60 * 60 * 1000 },
  };
}

describe("runCatchupCli — dispatcher", () => {
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
    await expect(runCatchupCli([])).rejects.toThrow("process.exit(1)");
    expect(stderrChunks.join("")).toContain("Gateway is not running");
  });

  it("happy path: prints Markdown brief on catchup.briefReady", async () => {
    const handlers = new Map<string, (params: unknown) => void>();
    setFixture({
      gatewayState: { socketPath: "/tmp/fake.sock" },
      ipcClient: {
        call: async (method: string) => {
          if (method === "agents.catchup") {
            setTimeout(() => {
              handlers.get("catchup.briefReady")?.({
                sessionId: "sess-1",
                brief: "# Catchup\n\nrecent activity",
                findings: makeValidCatchupBrief(),
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
    await runCatchupCli([]);
    expect(stdoutChunks.join("")).toContain("# Catchup");
  });

  it("--json prints the structured findings", async () => {
    const handlers = new Map<string, (params: unknown) => void>();
    setFixture({
      gatewayState: { socketPath: "/tmp/fake.sock" },
      ipcClient: {
        call: async (method: string) => {
          if (method === "agents.catchup") {
            setTimeout(() => {
              handlers.get("catchup.briefReady")?.({
                sessionId: "s",
                brief: "# md",
                findings: makeValidCatchupBrief(),
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
    await runCatchupCli(["--json"]);
    const out = stdoutChunks.join("");
    expect(out).toContain('"kind": "catchup"');
    expect(out).not.toContain("# md");
  });

  it("exits 1 with hint when findings include an empty_index gap", async () => {
    const handlers = new Map<string, (params: unknown) => void>();
    setFixture({
      gatewayState: { socketPath: "/tmp/fake.sock" },
      ipcClient: {
        call: async (method: string) => {
          if (method === "agents.catchup") {
            setTimeout(() => {
              handlers.get("catchup.briefReady")?.({
                sessionId: "s",
                brief: "x",
                findings: makeValidCatchupBrief({ emptyIndex: true }),
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
    await expect(runCatchupCli([])).rejects.toThrow(/process\.exit/);
    expect(stderrChunks.join("")).toContain("No data indexed yet");
  });

  it("forwards --service to the agents.catchup IPC call", async () => {
    const handlers = new Map<string, (params: unknown) => void>();
    let agentCallParams: unknown;
    setFixture({
      gatewayState: { socketPath: "/tmp/fake.sock" },
      ipcClient: {
        call: async (method: string, params: unknown) => {
          if (method === "agents.catchup") {
            agentCallParams = params;
            setTimeout(() => {
              handlers.get("catchup.briefReady")?.({
                sessionId: "s",
                brief: "x",
                findings: makeValidCatchupBrief(),
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
    await runCatchupCli(["--service", "github"]);
    expect(agentCallParams).toMatchObject({ service: "github" });
  });

  it("exits 2 when catchup.briefError fires", async () => {
    const handlers = new Map<string, (params: unknown) => void>();
    setFixture({
      gatewayState: { socketPath: "/tmp/fake.sock" },
      ipcClient: {
        call: async (method: string) => {
          if (method === "agents.catchup") {
            setTimeout(() => {
              handlers.get("catchup.briefError")?.({ error: "llm down" });
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
    await expect(runCatchupCli([])).rejects.toThrow("process.exit(2)");
    expect(stderrChunks.join("")).toContain("llm down");
  });

  it("exits 2 when briefReady payload is malformed", async () => {
    const handlers = new Map<string, (params: unknown) => void>();
    setFixture({
      gatewayState: { socketPath: "/tmp/fake.sock" },
      ipcClient: {
        call: async (method: string) => {
          if (method === "agents.catchup") {
            setTimeout(() => {
              handlers.get("catchup.briefReady")?.({
                brief: 42, // wrong type
                findings: {},
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
    await expect(runCatchupCli([])).rejects.toThrow("process.exit(2)");
    expect(stderrChunks.join("")).toContain("Malformed");
  });
});
