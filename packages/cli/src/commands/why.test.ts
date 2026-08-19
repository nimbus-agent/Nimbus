import { afterAll, afterEach, beforeEach, describe, expect, it, test } from "bun:test";

import { clearFixture, FAKE_SOCKET_PATH, setFixture } from "../../test/helpers/cli-mocks.ts";
import { createStreamCapture } from "../../test/helpers/stream-capture.ts";
import type { WhyPeekLike } from "./why.ts";

const mod = await import("./why.ts");
const { parseWhyArgs, renderPeekLine, runWhyCli } = mod;

describe("parseWhyArgs", () => {
  test("parses a bare positional ref", () => {
    const a = parseWhyArgs(["src/a.ts:42"]);
    expect(a).toEqual({ ref: "src/a.ts:42", peek: false, json: false });
  });

  test("parses --line, --peek and --json together", () => {
    const a = parseWhyArgs(["src/a.ts", "--line", "7", "--peek", "--json"]);
    expect(a).toEqual({ ref: "src/a.ts", line: 7, peek: true, json: true });
  });

  test("throws the usage string when ref is missing", () => {
    expect(() => parseWhyArgs([])).toThrow(
      "Usage: nimbus why <path[:line] | symbol | pr-url> [--line <n>] [--peek] [--json]",
    );
  });

  test("rejects a non-numeric --line", () => {
    expect(() => parseWhyArgs(["--line", "x", "a.ts"])).toThrow();
  });

  test("rejects --line 0 and negative values", () => {
    expect(() => parseWhyArgs(["a.ts", "--line", "0"])).toThrow();
    expect(() => parseWhyArgs(["a.ts", "--line", "-1"])).toThrow();
  });
});

describe("renderPeekLine", () => {
  test("full peek: joins author, short sha, date, subject, PR and ticket with ' · '", () => {
    const fullPeek: WhyPeekLike = {
      subject: { repoRoot: "/repo", filePath: "src/a.ts", lineNo: 42 },
      author: "alice",
      authorEmail: "alice@example.com",
      commitSha: "a1b2c3d4e5f6789",
      committedAt: Date.parse("2023-11-14T10:00:00Z"),
      commitSubject: "Fix retry backoff",
      pr: { number: 412, title: "Retry backoff", url: "https://example.com/pr/412" },
      ticket: { key: "NIM-88", title: "Retry storms", url: "https://example.com/NIM-88" },
      hasMore: false,
    };
    expect(renderPeekLine("src/a.ts:42", fullPeek)).toBe(
      "alice · a1b2c3d4e5f6 · 2023-11-14 · Fix retry backoff · PR #412 · NIM-88",
    );
  });

  test("empty peek: no subject / no commitSha renders the not-indexed message", () => {
    const emptyPeek: WhyPeekLike = {
      subject: null,
      author: null,
      authorEmail: null,
      commitSha: null,
      committedAt: null,
      commitSubject: null,
      pr: null,
      ticket: null,
      hasMore: false,
    };
    expect(renderPeekLine("src/a.ts:42", emptyPeek)).toBe(
      "No indexed answer for src/a.ts:42 (line not blamed, or path outside the indexed roots).",
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

function makeValidWhyBrief(opts: { emptyIndex?: boolean } = {}): unknown {
  return {
    kind: "why",
    agentVersion: 1,
    generatedAt: 1_700_000_000,
    latencyMs: 12,
    gaps: opts.emptyIndex ? [{ category: "empty_index", detail: "no items" }] : [],
    findings: [],
    subject: null,
    query: { ref: "src/a.ts:42", line: null },
  };
}

describe("runWhyCli — dispatcher (full brief)", () => {
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
    await expect(runWhyCli(["src/a.ts:42"])).rejects.toThrow("process.exit(1)");
    expect(stderrChunks.join("")).toContain("Gateway is not running");
  });

  it("happy path: prints the Markdown brief on why.briefReady", async () => {
    const handlers = new Map<string, (params: unknown) => void>();
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: async (method: string) => {
          if (method === "agents.why") {
            setTimeout(() => {
              handlers.get("why.briefReady")?.({
                sessionId: "sess-1",
                brief: "# Why\n\nblame trail",
                findings: makeValidWhyBrief(),
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
    await runWhyCli(["src/a.ts:42"]);
    expect(stdoutChunks.join("")).toContain("# Why");
    expect(stdoutChunks.join("")).toContain("blame trail");
  });

  it("forwards ref and line to the agents.why IPC call", async () => {
    const handlers = new Map<string, (params: unknown) => void>();
    let agentCallParams: unknown;
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: async (method: string, params: unknown) => {
          if (method === "agents.why") {
            agentCallParams = params;
            setTimeout(() => {
              handlers.get("why.briefReady")?.({
                sessionId: "s",
                brief: "x",
                findings: makeValidWhyBrief(),
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
    await runWhyCli(["src/a.ts", "--line", "7"]);
    expect(agentCallParams).toEqual({ ref: "src/a.ts", line: 7 });
  });

  it("sends { prUrl } when the positional argument is an http(s) URL", async () => {
    const handlers = new Map<string, (params: unknown) => void>();
    let agentCallParams: unknown;
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: async (method: string, params: unknown) => {
          if (method === "agents.why") {
            agentCallParams = params;
            setTimeout(() => {
              handlers.get("why.briefReady")?.({
                sessionId: "s",
                brief: "x",
                findings: makeValidWhyBrief(),
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
    await runWhyCli(["https://github.com/acme/web/pull/482"]);
    expect(agentCallParams).toEqual({ prUrl: "https://github.com/acme/web/pull/482" });
  });

  it("exits 2 when why.briefError fires", async () => {
    const handlers = new Map<string, (params: unknown) => void>();
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: async (method: string) => {
          if (method === "agents.why") {
            setTimeout(() => {
              handlers.get("why.briefError")?.({ error: "blame lookup failed" });
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
    await expect(runWhyCli(["src/a.ts:42"])).rejects.toThrow("process.exit(2)");
    expect(stderrChunks.join("")).toContain("blame lookup failed");
  });
});

describe("runWhyCli — peek", () => {
  beforeEach(() => {
    stdoutChunks.length = 0;
    stderrChunks.length = 0;
    installStreamCapture();
  });
  afterEach(() => {
    clearFixture();
    restoreStreams();
  });

  it("prints the one-line render on --peek", async () => {
    const peek: WhyPeekLike = {
      subject: { repoRoot: "/repo", filePath: "src/a.ts", lineNo: 42 },
      author: "alice",
      authorEmail: null,
      commitSha: "a1b2c3d4e5f6789",
      committedAt: Date.parse("2023-11-14T10:00:00Z"),
      commitSubject: "Fix retry backoff",
      pr: { number: 412, title: "t", url: null },
      ticket: { key: "NIM-88", title: "t", url: null },
      hasMore: false,
    };
    let calledParams: unknown;
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: async (method: string, params: unknown) => {
          if (method === "agents.whyPeek") {
            calledParams = params;
            return peek;
          }
          return undefined;
        },
        connect: async () => {},
        disconnect: async () => {},
      },
    });
    await runWhyCli(["src/a.ts", "--line", "42", "--peek"]);
    expect(calledParams).toEqual({ ref: "src/a.ts", line: 42 });
    expect(stdoutChunks.join("")).toBe(
      "alice · a1b2c3d4e5f6 · 2023-11-14 · Fix retry backoff · PR #412 · NIM-88\n",
    );
  });

  it("--peek --json prints the raw structured payload", async () => {
    const peek: WhyPeekLike = {
      subject: null,
      author: null,
      authorEmail: null,
      commitSha: null,
      committedAt: null,
      commitSubject: null,
      pr: null,
      ticket: null,
      hasMore: false,
    };
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: async (method: string) => {
          if (method === "agents.whyPeek") return peek;
          return undefined;
        },
        connect: async () => {},
        disconnect: async () => {},
      },
    });
    await runWhyCli(["src/a.ts:42", "--peek", "--json"]);
    const out = stdoutChunks.join("");
    expect(out).toContain('"subject": null');
    expect(out).not.toContain("No indexed answer");
  });

  it("propagates 'Gateway is not running' for --peek", async () => {
    setFixture({});
    await expect(runWhyCli(["src/a.ts:42", "--peek"])).rejects.toThrow(
      "Gateway is not running. Start with: nimbus start",
    );
  });

  it("--peek with a pull request URL fails locally, without calling the gateway", async () => {
    let called = false;
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: async () => {
          called = true;
          return undefined;
        },
        connect: async () => {},
        disconnect: async () => {},
      },
    });
    await expect(runWhyCli(["https://github.com/acme/web/pull/482", "--peek"])).rejects.toThrow(
      "--peek takes a path or symbol, not a pull request URL",
    );
    expect(called).toBe(false);
  });
});
