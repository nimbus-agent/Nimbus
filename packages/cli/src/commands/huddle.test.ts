import { afterAll, afterEach, beforeEach, describe, expect, it, test } from "bun:test";

import { clearFixture, FAKE_SOCKET_PATH, setFixture } from "../../test/helpers/cli-mocks.ts";
import { createStreamCapture } from "../../test/helpers/stream-capture.ts";

const mod = await import("./huddle.ts");
const { parseHuddleArgs, runHuddleCli } = mod;

describe("parseHuddleArgs", () => {
  it("parses --since and --namespace; no file required", () => {
    const a = parseHuddleArgs(["--since", "5000", "--namespace", "team"]);
    expect(a.sinceMs).toBe(5000);
    expect(a.namespaces).toEqual(["team"]);
  });

  it("defaults to sinceMs=undefined and empty namespaces and json=false when no args given", () => {
    const a = parseHuddleArgs([]);
    expect(a.sinceMs).toBeUndefined();
    expect(a.json).toBe(false);
    expect(a.namespaces).toEqual([]);
  });

  it("parses --json flag", () => {
    const a = parseHuddleArgs(["--json"]);
    expect(a.json).toBe(true);
  });

  it("parses repeatable --namespace", () => {
    const a = parseHuddleArgs(["--namespace", "ns1", "--namespace", "ns2"]);
    expect(a.namespaces).toEqual(["ns1", "ns2"]);
  });

  it("throws on a non-integer --since", () => {
    expect(() => parseHuddleArgs(["--since", "abc"])).toThrow();
  });

  it("throws on a negative --since", () => {
    expect(() => parseHuddleArgs(["--since", "-1"])).toThrow();
  });

  test("accepts --since 0", () => {
    const a = parseHuddleArgs(["--since", "0"]);
    expect(a.sinceMs).toBe(0);
  });

  it("throws when --namespace has no value", () => {
    expect(() => parseHuddleArgs(["--namespace"])).toThrow();
  });

  it("throws when --namespace value is whitespace-only", () => {
    expect(() => parseHuddleArgs(["--namespace", "   "])).toThrow();
  });

  it("rejects a flag swallowed as the --namespace value", () => {
    expect(() => parseHuddleArgs(["--namespace", "--json"])).toThrow(
      "--namespace requires a value",
    );
  });

  it("rejects a flag swallowed as the --since value", () => {
    expect(() => parseHuddleArgs(["--since", "--json"])).toThrow(
      "--since must be a non-negative integer (ms)",
    );
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

function makeValidHuddleBrief(): unknown {
  return {
    kind: "huddle",
    agentVersion: 1,
    generatedAt: 1_700_000_000,
    latencyMs: 22,
    gaps: [],
    contributions: [],
    query: { sinceMs: 5000 },
  };
}

describe("runHuddleCli — dispatcher", () => {
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
    await expect(runHuddleCli([])).rejects.toThrow("process.exit(1)");
    expect(stderrChunks.join("")).toContain("Gateway is not running");
  });

  it("happy path: prints Markdown brief on huddle.briefReady", async () => {
    const handlers = new Map<string, (params: unknown) => void>();
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: async (method: string) => {
          if (method === "agents.huddle") {
            setTimeout(() => {
              handlers.get("huddle.briefReady")?.({
                sessionId: "sess-1",
                brief: "# Huddle\n\nteam activity",
                findings: makeValidHuddleBrief(),
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
    await runHuddleCli([]);
    expect(stdoutChunks.join("")).toContain("# Huddle");
    expect(stdoutChunks.join("")).toContain("team activity");
  });

  it("--json prints the structured findings", async () => {
    const handlers = new Map<string, (params: unknown) => void>();
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: async (method: string) => {
          if (method === "agents.huddle") {
            setTimeout(() => {
              handlers.get("huddle.briefReady")?.({
                sessionId: "s",
                brief: "# md",
                findings: makeValidHuddleBrief(),
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
    await runHuddleCli(["--json"]);
    const out = stdoutChunks.join("");
    expect(out).toContain('"kind": "huddle"');
    expect(out).not.toContain("# md");
  });

  it("exits 2 when huddle.briefError fires", async () => {
    const handlers = new Map<string, (params: unknown) => void>();
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: async (method: string) => {
          if (method === "agents.huddle") {
            setTimeout(() => {
              handlers.get("huddle.briefError")?.({ error: "peers not found" });
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
    await expect(runHuddleCli([])).rejects.toThrow("process.exit(2)");
    expect(stderrChunks.join("")).toContain("peers not found");
  });

  it("forwards --since and --namespace to the agents.huddle IPC call", async () => {
    const handlers = new Map<string, (params: unknown) => void>();
    let agentCallParams: unknown;
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: async (method: string, params: unknown) => {
          if (method === "agents.huddle") {
            agentCallParams = params;
            setTimeout(() => {
              handlers.get("huddle.briefReady")?.({
                sessionId: "s",
                brief: "x",
                findings: makeValidHuddleBrief(),
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
    await runHuddleCli(["--since", "5000", "--namespace", "teamA"]);
    expect(agentCallParams).toEqual({ sinceMs: 5000, namespaces: ["teamA"] });
  });

  it("omits sinceMs from IPC call when not provided", async () => {
    const handlers = new Map<string, (params: unknown) => void>();
    let agentCallParams: unknown;
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: async (method: string, params: unknown) => {
          if (method === "agents.huddle") {
            agentCallParams = params;
            setTimeout(() => {
              handlers.get("huddle.briefReady")?.({
                sessionId: "s",
                brief: "x",
                findings: makeValidHuddleBrief(),
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
    await runHuddleCli([]);
    expect(agentCallParams).toEqual({ namespaces: [] });
    expect((agentCallParams as Record<string, unknown>)["sinceMs"]).toBeUndefined();
  });

  it("exits 2 when briefReady payload is malformed", async () => {
    const handlers = new Map<string, (params: unknown) => void>();
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: async (method: string) => {
          if (method === "agents.huddle") {
            setTimeout(() => {
              handlers.get("huddle.briefReady")?.({
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
    await expect(runHuddleCli([])).rejects.toThrow("process.exit(2)");
    expect(stderrChunks.join("")).toContain("Malformed");
  });
});
