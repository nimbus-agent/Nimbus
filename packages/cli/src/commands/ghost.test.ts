import { afterAll, afterEach, beforeEach, describe, expect, it, test } from "bun:test";

import { clearFixture, FAKE_SOCKET_PATH, setFixture } from "../../test/helpers/cli-mocks.ts";
import { createStreamCapture } from "../../test/helpers/stream-capture.ts";

const mod = await import("./ghost.ts");
const { parseGhostArgs, runGhostCli } = mod;

describe("parseGhostArgs", () => {
  it("parses the file positional + --json + repeatable --namespace", () => {
    const a = parseGhostArgs(["src/auth.ts", "--json", "--namespace", "ns1", "--namespace", "ns2"]);
    expect(a.file).toBe("src/auth.ts");
    expect(a.json).toBe(true);
    expect(a.namespaces).toEqual(["ns1", "ns2"]);
  });

  it("defaults to empty namespaces and json=false", () => {
    const a = parseGhostArgs(["src/billing.ts"]);
    expect(a.file).toBe("src/billing.ts");
    expect(a.json).toBe(false);
    expect(a.namespaces).toEqual([]);
  });

  test("joins multiple positionals with spaces", () => {
    expect(parseGhostArgs(["foo", "bar"]).file).toBe("foo bar");
  });

  it("throws when no file is given", () => {
    expect(() => parseGhostArgs(["--json"])).toThrow();
    expect(() => parseGhostArgs([])).toThrow();
  });

  it("throws when --namespace has no value", () => {
    expect(() => parseGhostArgs(["x.ts", "--namespace"])).toThrow();
  });

  it("throws when --namespace value is whitespace-only", () => {
    expect(() => parseGhostArgs(["x.ts", "--namespace", "   "])).toThrow();
  });
});

const {
  stdoutChunks,
  stderrChunks,
  install: installStreamCapture,
  restore: restoreStreams,
} = createStreamCapture({ captureExit: true });

afterAll(() => {
  restoreStreams();
});

function makeValidGhostBrief(): unknown {
  return {
    kind: "ghost",
    agentVersion: 1,
    generatedAt: 1_700_000_000,
    latencyMs: 15,
    gaps: [],
    findings: [],
    startEntityId: null,
    query: { file: "src/auth.ts" },
  };
}

describe("runGhostCli — dispatcher", () => {
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
    await expect(runGhostCli(["src/auth.ts"])).rejects.toThrow("process.exit(1)");
    expect(stderrChunks.join("")).toContain("Gateway is not running");
  });

  it("happy path: prints Markdown brief on ghost.briefReady", async () => {
    const handlers = new Map<string, (params: unknown) => void>();
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: async (method: string) => {
          if (method === "agents.ghost") {
            setTimeout(() => {
              handlers.get("ghost.briefReady")?.({
                sessionId: "sess-1",
                brief: "# Ghost\n\nknowledge gaps",
                findings: makeValidGhostBrief(),
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
    await runGhostCli(["src/auth.ts"]);
    expect(stdoutChunks.join("")).toContain("# Ghost");
    expect(stdoutChunks.join("")).toContain("knowledge gaps");
  });

  it("--json prints the structured findings", async () => {
    const handlers = new Map<string, (params: unknown) => void>();
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: async (method: string) => {
          if (method === "agents.ghost") {
            setTimeout(() => {
              handlers.get("ghost.briefReady")?.({
                sessionId: "s",
                brief: "# md",
                findings: makeValidGhostBrief(),
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
    await runGhostCli(["src/auth.ts", "--json"]);
    const out = stdoutChunks.join("");
    expect(out).toContain('"kind": "ghost"');
    expect(out).not.toContain("# md");
  });

  it("exits 2 when ghost.briefError fires", async () => {
    const handlers = new Map<string, (params: unknown) => void>();
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: async (method: string) => {
          if (method === "agents.ghost") {
            setTimeout(() => {
              handlers.get("ghost.briefError")?.({ error: "traversal failed" });
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
    await expect(runGhostCli(["src/auth.ts"])).rejects.toThrow("process.exit(2)");
    expect(stderrChunks.join("")).toContain("traversal failed");
  });

  it("forwards --namespace to the agents.ghost IPC call", async () => {
    const handlers = new Map<string, (params: unknown) => void>();
    let agentCallParams: unknown;
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: async (method: string, params: unknown) => {
          if (method === "agents.ghost") {
            agentCallParams = params;
            setTimeout(() => {
              handlers.get("ghost.briefReady")?.({
                sessionId: "s",
                brief: "x",
                findings: makeValidGhostBrief(),
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
    await runGhostCli(["src/auth.ts", "--namespace", "teamA"]);
    expect(agentCallParams).toEqual({ file: "src/auth.ts", namespaces: ["teamA"] });
  });

  it("exits 2 when briefReady payload is malformed", async () => {
    const handlers = new Map<string, (params: unknown) => void>();
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: async (method: string) => {
          if (method === "agents.ghost") {
            setTimeout(() => {
              handlers.get("ghost.briefReady")?.({
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
    await expect(runGhostCli(["src/auth.ts"])).rejects.toThrow("process.exit(2)");
    expect(stderrChunks.join("")).toContain("Malformed");
  });
});
