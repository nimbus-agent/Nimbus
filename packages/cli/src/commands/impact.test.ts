import { afterAll, afterEach, beforeEach, describe, expect, it, test } from "bun:test";

import "../../test/helpers/cli-mocks.ts"; // module-load side effects
import { clearFixture, setFixture } from "../../test/helpers/cli-mocks.ts";

const mod = await import("./impact.ts");
const { parseImpactArgs, runImpactCli } = mod;

describe("parseImpactArgs", () => {
  test("parses positional fileOrPrUrl", () => {
    const a = parseImpactArgs(["src/billing/retry.ts"]);
    expect(a.fileOrPrUrl).toBe("src/billing/retry.ts");
    expect(a.json).toBe(false);
    expect(a.depth).toBeUndefined();
    expect(a.service).toBeUndefined();
  });

  test("recognises --json flag", () => {
    const a = parseImpactArgs(["src/x.ts", "--json"]);
    expect(a.json).toBe(true);
  });

  test("parses --depth as integer in 1..5", () => {
    expect(parseImpactArgs(["x", "--depth", "3"]).depth).toBe(3);
  });

  test("rejects --depth out of range", () => {
    expect(() => parseImpactArgs(["x", "--depth", "0"])).toThrow();
    expect(() => parseImpactArgs(["x", "--depth", "6"])).toThrow();
    expect(() => parseImpactArgs(["x", "--depth", "abc"])).toThrow();
  });

  test("parses --service", () => {
    expect(parseImpactArgs(["x", "--service", "github"]).service).toBe("github");
  });

  test("rejects empty --service", () => {
    expect(() => parseImpactArgs(["x", "--service", "   "])).toThrow();
  });

  test("requires non-empty fileOrPrUrl", () => {
    expect(() => parseImpactArgs([])).toThrow();
    expect(() => parseImpactArgs(["--json"])).toThrow();
  });

  test("joins multiple positionals with spaces (PR URLs are single tokens, but topics may have spaces)", () => {
    expect(parseImpactArgs(["foo", "bar", "--json"]).fileOrPrUrl).toBe("foo bar");
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

function makeValidImpactBrief(opts: { emptyIndex?: boolean } = {}): unknown {
  return {
    kind: "impact",
    agentVersion: 1,
    generatedAt: 1_700_000_000,
    latencyMs: 12,
    gaps: opts.emptyIndex ? [{ category: "empty_index", detail: "no items" }] : [],
    affected: [],
    startEntityId: null,
    query: { fileOrPrUrl: "src/x.ts" },
  };
}

describe("runImpactCli — dispatcher", () => {
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
    await expect(runImpactCli(["src/x.ts"])).rejects.toThrow("process.exit(1)");
    expect(stderrChunks.join("")).toContain("Gateway is not running");
  });

  it("happy path: prints Markdown brief on impact.briefReady", async () => {
    const handlers = new Map<string, (params: unknown) => void>();
    setFixture({
      gatewayState: { socketPath: "/tmp/fake.sock" },
      ipcClient: {
        call: async (method: string) => {
          if (method === "agents.impact") {
            setTimeout(() => {
              handlers.get("impact.briefReady")?.({
                sessionId: "sess-1",
                brief: "# Impact\n\nblast radius",
                findings: makeValidImpactBrief(),
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
    await runImpactCli(["src/x.ts"]);
    expect(stdoutChunks.join("")).toContain("# Impact");
    expect(stdoutChunks.join("")).toContain("blast radius");
  });

  it("--json prints the structured findings", async () => {
    const handlers = new Map<string, (params: unknown) => void>();
    setFixture({
      gatewayState: { socketPath: "/tmp/fake.sock" },
      ipcClient: {
        call: async (method: string) => {
          if (method === "agents.impact") {
            setTimeout(() => {
              handlers.get("impact.briefReady")?.({
                sessionId: "s",
                brief: "# md",
                findings: makeValidImpactBrief(),
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
    await runImpactCli(["src/x.ts", "--json"]);
    const out = stdoutChunks.join("");
    expect(out).toContain('"kind": "impact"');
    expect(out).not.toContain("# md");
  });

  it("exits 1 with hint when findings include an empty_index gap", async () => {
    const handlers = new Map<string, (params: unknown) => void>();
    setFixture({
      gatewayState: { socketPath: "/tmp/fake.sock" },
      ipcClient: {
        call: async (method: string) => {
          if (method === "agents.impact") {
            setTimeout(() => {
              handlers.get("impact.briefReady")?.({
                sessionId: "s",
                brief: "x",
                findings: makeValidImpactBrief({ emptyIndex: true }),
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
    await expect(runImpactCli(["src/x.ts"])).rejects.toThrow(/process\.exit/);
    expect(stderrChunks.join("")).toContain("No data indexed yet");
  });

  it("exits 2 when impact.briefError fires", async () => {
    const handlers = new Map<string, (params: unknown) => void>();
    setFixture({
      gatewayState: { socketPath: "/tmp/fake.sock" },
      ipcClient: {
        call: async (method: string) => {
          if (method === "agents.impact") {
            setTimeout(() => {
              handlers.get("impact.briefError")?.({ error: "graph traversal failed" });
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
    await expect(runImpactCli(["src/x.ts"])).rejects.toThrow("process.exit(2)");
    expect(stderrChunks.join("")).toContain("graph traversal failed");
  });

  it("forwards --depth and --service to the agents.impact IPC call", async () => {
    const handlers = new Map<string, (params: unknown) => void>();
    let agentCallParams: unknown;
    setFixture({
      gatewayState: { socketPath: "/tmp/fake.sock" },
      ipcClient: {
        call: async (method: string, params: unknown) => {
          if (method === "agents.impact") {
            agentCallParams = params;
            setTimeout(() => {
              handlers.get("impact.briefReady")?.({
                sessionId: "s",
                brief: "x",
                findings: makeValidImpactBrief(),
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
    await runImpactCli(["src/x.ts", "--depth", "2", "--service", "github"]);
    expect(agentCallParams).toEqual({
      fileOrPrUrl: "src/x.ts",
      depth: 2,
      service: "github",
    });
  });

  it("exits 2 when briefReady payload is malformed", async () => {
    const handlers = new Map<string, (params: unknown) => void>();
    setFixture({
      gatewayState: { socketPath: "/tmp/fake.sock" },
      ipcClient: {
        call: async (method: string) => {
          if (method === "agents.impact") {
            setTimeout(() => {
              handlers.get("impact.briefReady")?.({
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
    await expect(runImpactCli(["src/x.ts"])).rejects.toThrow("process.exit(2)");
    expect(stderrChunks.join("")).toContain("Malformed");
  });
});
