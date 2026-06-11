import { afterAll, afterEach, beforeEach, describe, expect, it, test } from "bun:test";

import { clearFixture, FAKE_SOCKET_PATH, setFixture } from "../../test/helpers/cli-mocks.ts";
import { createStreamCapture } from "../../test/helpers/stream-capture.ts";

const mod = await import("./conflicts.ts");
const { parseConflictsArgs, runConflictsCli } = mod;

describe("parseConflictsArgs", () => {
  it("parses the file positional + --json + repeatable --namespace", () => {
    const a = parseConflictsArgs([
      "src/api.ts",
      "--json",
      "--namespace",
      "ns1",
      "--namespace",
      "ns2",
    ]);
    expect(a.file).toBe("src/api.ts");
    expect(a.json).toBe(true);
    expect(a.namespaces).toEqual(["ns1", "ns2"]);
  });

  it("defaults to empty namespaces and json=false", () => {
    const a = parseConflictsArgs(["src/billing.ts"]);
    expect(a.file).toBe("src/billing.ts");
    expect(a.json).toBe(false);
    expect(a.namespaces).toEqual([]);
  });

  test("joins multiple positionals with spaces", () => {
    expect(parseConflictsArgs(["foo", "bar"]).file).toBe("foo bar");
  });

  it("throws when no file is given", () => {
    expect(() => parseConflictsArgs(["--json"])).toThrow();
    expect(() => parseConflictsArgs([])).toThrow();
  });

  it("throws when --namespace has no value", () => {
    expect(() => parseConflictsArgs(["x.ts", "--namespace"])).toThrow();
  });

  it("throws when --namespace value is whitespace-only", () => {
    expect(() => parseConflictsArgs(["x.ts", "--namespace", "   "])).toThrow();
  });

  it("rejects a flag swallowed as the --namespace value", () => {
    expect(() => parseConflictsArgs(["x.ts", "--namespace", "--json"])).toThrow(
      "--namespace requires a value",
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

function makeValidConflictBrief(): unknown {
  return {
    kind: "conflict",
    agentVersion: 1,
    generatedAt: 1_700_000_000,
    latencyMs: 18,
    gaps: [],
    collisions: [],
    startEntityId: null,
    query: { file: "src/api.ts" },
  };
}

describe("runConflictsCli — dispatcher", () => {
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
    await expect(runConflictsCli(["src/api.ts"])).rejects.toThrow("process.exit(1)");
    expect(stderrChunks.join("")).toContain("Gateway is not running");
  });

  it("happy path: prints Markdown brief on conflicts.briefReady", async () => {
    const handlers = new Map<string, (params: unknown) => void>();
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: async (method: string) => {
          if (method === "agents.conflicts") {
            setTimeout(() => {
              handlers.get("conflicts.briefReady")?.({
                sessionId: "sess-1",
                brief: "# Conflicts\n\noverlapping work",
                findings: makeValidConflictBrief(),
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
    await runConflictsCli(["src/api.ts"]);
    expect(stdoutChunks.join("")).toContain("# Conflicts");
    expect(stdoutChunks.join("")).toContain("overlapping work");
  });

  it("--json prints the structured findings", async () => {
    const handlers = new Map<string, (params: unknown) => void>();
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: async (method: string) => {
          if (method === "agents.conflicts") {
            setTimeout(() => {
              handlers.get("conflicts.briefReady")?.({
                sessionId: "s",
                brief: "# md",
                findings: makeValidConflictBrief(),
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
    await runConflictsCli(["src/api.ts", "--json"]);
    const out = stdoutChunks.join("");
    expect(out).toContain('"kind": "conflict"');
    expect(out).not.toContain("# md");
  });

  it("exits 2 when conflicts.briefError fires", async () => {
    const handlers = new Map<string, (params: unknown) => void>();
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: async (method: string) => {
          if (method === "agents.conflicts") {
            setTimeout(() => {
              handlers.get("conflicts.briefError")?.({ error: "graph lookup failed" });
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
    await expect(runConflictsCli(["src/api.ts"])).rejects.toThrow("process.exit(2)");
    expect(stderrChunks.join("")).toContain("graph lookup failed");
  });

  it("forwards --namespace to the agents.conflicts IPC call", async () => {
    const handlers = new Map<string, (params: unknown) => void>();
    let agentCallParams: unknown;
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: async (method: string, params: unknown) => {
          if (method === "agents.conflicts") {
            agentCallParams = params;
            setTimeout(() => {
              handlers.get("conflicts.briefReady")?.({
                sessionId: "s",
                brief: "x",
                findings: makeValidConflictBrief(),
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
    await runConflictsCli(["src/api.ts", "--namespace", "teamB"]);
    expect(agentCallParams).toEqual({ file: "src/api.ts", namespaces: ["teamB"] });
  });

  it("exits 2 when briefReady payload is malformed", async () => {
    const handlers = new Map<string, (params: unknown) => void>();
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: async (method: string) => {
          if (method === "agents.conflicts") {
            setTimeout(() => {
              handlers.get("conflicts.briefReady")?.({
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
    await expect(runConflictsCli(["src/api.ts"])).rejects.toThrow("process.exit(2)");
    expect(stderrChunks.join("")).toContain("Malformed");
  });
});
