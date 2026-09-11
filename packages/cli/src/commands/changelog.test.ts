import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { clearFixture, FAKE_SOCKET_PATH, setFixture } from "../../test/helpers/cli-mocks.ts";
import { createStreamCapture } from "../../test/helpers/stream-capture.ts";
import {
  type ChangelogBriefLike,
  type ChangelogCommandDeps,
  fetchChangelogBrief,
  isChangelogBriefLike,
  parseChangelogArgs,
  runChangelogCommand,
} from "./changelog.ts";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

const SAMPLE_FINDINGS: ChangelogBriefLike = {
  kind: "changelog",
  mergedPrs: [],
  deployments: [],
  incidentsOpened: [],
  incidentsResolved: [],
  gaps: [],
};

describe("isChangelogBriefLike", () => {
  test("accepts a well-formed changelog brief", () => {
    expect(isChangelogBriefLike(SAMPLE_FINDINGS)).toBe(true);
  });
  test("rejects a differently-kinded brief", () => {
    expect(isChangelogBriefLike({ ...SAMPLE_FINDINGS, kind: "decisions" })).toBe(false);
  });
  test("rejects null and non-objects", () => {
    expect(isChangelogBriefLike(null)).toBe(false);
    expect(isChangelogBriefLike("changelog")).toBe(false);
  });
  test("rejects a brief missing one of the required array fields", () => {
    const { gaps: _gaps, ...rest } = SAMPLE_FINDINGS;
    expect(isChangelogBriefLike(rest)).toBe(false);
  });
});

describe("parseChangelogArgs", () => {
  test("defaults to a 7-day lookback, no service, markdown, non-json", () => {
    expect(parseChangelogArgs([])).toStrictEqual({
      sinceMs: SEVEN_DAYS_MS,
      service: undefined,
      format: "markdown",
      json: false,
    });
  });

  test("--since overrides the lookback duration", () => {
    expect(parseChangelogArgs(["--since", "24h"]).sinceMs).toBe(24 * 60 * 60 * 1000);
  });

  test("--service sets the service param", () => {
    expect(parseChangelogArgs(["--service", "checkout"]).service).toBe("checkout");
  });

  test("--format accepts slack and plain", () => {
    expect(parseChangelogArgs(["--format", "slack"]).format).toBe("slack");
    expect(parseChangelogArgs(["--format", "plain"]).format).toBe("plain");
  });

  test("an invalid --format value is rejected, not ignored", () => {
    expect(() => parseChangelogArgs(["--format", "html"])).toThrow(/--format must be one of/);
  });

  test("--json sets the json flag", () => {
    expect(parseChangelogArgs(["--json"]).json).toBe(true);
  });

  test("an unrecognised flag is rejected", () => {
    expect(() => parseChangelogArgs(["--nope"])).toThrow(/Unknown flag/);
  });

  test("a positional argument is rejected", () => {
    expect(() => parseChangelogArgs(["oops"])).toThrow(/Unexpected argument/);
  });

  test("--help throws the usage text", () => {
    expect(() => parseChangelogArgs(["--help"])).toThrow(/Usage: nimbus changelog/);
  });
});

describe("runChangelogCommand", () => {
  const out = createStreamCapture();

  beforeEach(() => {
    out.stdoutChunks.length = 0;
    out.install();
  });
  afterEach(() => {
    out.restore();
  });

  function recordingDeps(
    sink: { params?: { sinceMs: number; service?: string } },
    findings: ChangelogBriefLike = SAMPLE_FINDINGS,
    brief = "## Deployments\n\n- [Fix auth](https://x/1) **shipped**",
  ): ChangelogCommandDeps {
    return {
      fetchBrief: async (params) => {
        sink.params = params;
        return { brief, findings };
      },
    };
  }

  test("sends sinceMs and omits an unset service key", async () => {
    const sink: { params?: { sinceMs: number; service?: string } } = {};
    await runChangelogCommand([], recordingDeps(sink));
    expect(sink.params).toStrictEqual({ sinceMs: SEVEN_DAYS_MS });
  });

  test("sends the service param when --service is given", async () => {
    const sink: { params?: { sinceMs: number; service?: string } } = {};
    await runChangelogCommand(["--service", "checkout"], recordingDeps(sink));
    expect(sink.params).toStrictEqual({ sinceMs: SEVEN_DAYS_MS, service: "checkout" });
  });

  test("--json prints the findings object, not the brief", async () => {
    await runChangelogCommand(["--json"], recordingDeps({}));
    expect(out.stdoutChunks.join("")).toBe(`${JSON.stringify(SAMPLE_FINDINGS, null, 2)}\n`);
  });

  test("default format prints the brief's Markdown verbatim", async () => {
    await runChangelogCommand([], recordingDeps({}));
    expect(out.stdoutChunks.join("")).toBe(
      "## Deployments\n\n- [Fix auth](https://x/1) **shipped**\n",
    );
  });

  test("--format slack transforms the brief, never re-rendering findings", async () => {
    await runChangelogCommand(["--format", "slack"], recordingDeps({}));
    expect(out.stdoutChunks.join("")).toBe("*Deployments*\n\n- <https://x/1|Fix auth> *shipped*\n");
  });

  test("--format plain transforms the brief, never re-rendering findings", async () => {
    await runChangelogCommand(["--format", "plain"], recordingDeps({}));
    expect(out.stdoutChunks.join("")).toBe("Deployments\n\n- Fix auth shipped\n");
  });
});

describe("fetchChangelogBrief", () => {
  const out = createStreamCapture({ captureExit: true });

  beforeEach(() => {
    out.stdoutChunks.length = 0;
    out.stderrChunks.length = 0;
    out.install();
  });
  afterEach(() => {
    clearFixture();
    out.restore();
  });

  test("exits 1 when the gateway is not running", async () => {
    setFixture({});
    await expect(fetchChangelogBrief({ sinceMs: SEVEN_DAYS_MS })).rejects.toThrow(
      "process.exit(1)",
    );
    expect(out.stderrChunks.join("")).toContain("Gateway is not running");
  });

  test("exits 2 when the IPC call rejects", async () => {
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        connect: async () => {},
        disconnect: async () => {},
        call: async () => {
          throw new Error("boom");
        },
        onNotification: () => {},
      },
    });
    await expect(fetchChangelogBrief({ sinceMs: SEVEN_DAYS_MS })).rejects.toThrow(
      "process.exit(2)",
    );
    expect(out.stderrChunks.join("")).toContain("boom");
  });

  test("resolves with the brief and findings once briefReady fires", async () => {
    const handlers: Record<string, (params: unknown) => void> = {};
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        connect: async () => {},
        disconnect: async () => {},
        onNotification: (event: string, handler: (params: unknown) => void) => {
          handlers[event] = handler;
        },
        call: async () => {
          queueMicrotask(() => {
            handlers["changelog.briefReady"]?.({
              sessionId: "s1",
              brief: "hello",
              findings: SAMPLE_FINDINGS,
            });
          });
          return { sessionId: "s1" };
        },
      },
    });

    const result = await fetchChangelogBrief({ sinceMs: SEVEN_DAYS_MS });
    expect(result.brief).toBe("hello");
    expect(result.findings).toStrictEqual(SAMPLE_FINDINGS);
  });
});
