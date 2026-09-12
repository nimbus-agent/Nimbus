import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { clearFixture, FAKE_SOCKET_PATH, setFixture } from "../../test/helpers/cli-mocks.ts";
import { createStreamCapture } from "../../test/helpers/stream-capture.ts";
import {
  fetchStandupBrief,
  isStandupBriefLike,
  parseStandupArgs,
  runStandupCommand,
  type StandupBriefLike,
  type StandupCommandDeps,
} from "./standup.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

const SAMPLE_FINDINGS: StandupBriefLike = {
  kind: "standup",
  prsActive: [],
  prsMerged: [],
  reviews: [],
  ticketsOpened: [],
  incidents: [],
  messages: [],
  gaps: [],
};

describe("isStandupBriefLike", () => {
  test("accepts a well-formed standup brief", () => {
    expect(isStandupBriefLike(SAMPLE_FINDINGS)).toBe(true);
  });
  test("rejects a differently-kinded brief", () => {
    // The guard must key on `kind`, not on structural overlap: `changelog` carries `gaps` and
    // several arrays too, so a shape check alone would accept it and the CLI would print a
    // changelog under a standup heading.
    expect(isStandupBriefLike({ ...SAMPLE_FINDINGS, kind: "changelog" })).toBe(false);
  });
  test("rejects null and non-objects", () => {
    expect(isStandupBriefLike(null)).toBe(false);
    expect(isStandupBriefLike("standup")).toBe(false);
  });
  test("rejects a brief missing any one of the required array fields", () => {
    // Each field is checked individually rather than by count, so dropping ANY lane is caught.
    for (const key of [
      "prsActive",
      "prsMerged",
      "reviews",
      "ticketsOpened",
      "incidents",
      "messages",
      "gaps",
    ] as const) {
      const { [key]: _dropped, ...rest } = SAMPLE_FINDINGS;
      expect(isStandupBriefLike(rest)).toBe(false);
    }
  });
});

describe("parseStandupArgs", () => {
  test("defaults to a 24-hour lookback, markdown, non-json", () => {
    // 24h rather than `changelog`'s 7d: this answers "what did I do since yesterday's standup".
    expect(parseStandupArgs([])).toStrictEqual({
      sinceMs: DAY_MS,
      format: "markdown",
      json: false,
    });
  });

  test("--since accepts a duration and converts it", () => {
    expect(parseStandupArgs(["--since", "3d"]).sinceMs).toBe(3 * DAY_MS);
    expect(parseStandupArgs(["--since", "6h"]).sinceMs).toBe(6 * 60 * 60 * 1000);
  });

  test("every --format value is accepted and an unknown one is rejected by name", () => {
    for (const f of ["markdown", "slack", "plain"] as const) {
      expect(parseStandupArgs(["--format", f]).format).toBe(f);
    }
    expect(() => parseStandupArgs(["--format", "html"])).toThrow("--format must be one of");
    // The rejection names the offending value, so the user does not have to guess which of
    // several flags was wrong.
    expect(() => parseStandupArgs(["--format", "html"])).toThrow("html");
  });

  test("--json sets the flag", () => {
    expect(parseStandupArgs(["--json"]).json).toBe(true);
  });

  test("an unknown flag is HARD-REJECTED rather than ignored", () => {
    // `nimbus glossary`/`owners`/`changelog` all hard-reject. Silently ignoring `--sicne 7d`
    // would print a 24-hour standup while the user believed they asked for a week.
    expect(() => parseStandupArgs(["--sicne", "7d"])).toThrow("Unknown flag: --sicne");
  });

  test("a positional argument is rejected", () => {
    // Notably including one that looks like a person. There is no way to aim this command at
    // someone else, and accepting a bare name would imply otherwise.
    expect(() => parseStandupArgs(["alice"])).toThrow("Unexpected argument: alice");
  });

  test("--help throws the usage text, which documents the identity rules", () => {
    // The usage block is where a user learns WHY their standup is empty, so the resolution order
    // and the config escape hatch must both be in it.
    expect(() => parseStandupArgs(["--help"])).toThrow("git config user.email");
    expect(() => parseStandupArgs(["-h"])).toThrow("[user] mePersonId");
    expect(() => parseStandupArgs(["--help"])).toThrow("no flag to report on someone else");
  });

  test("--format and --since consume their value, not the next flag", () => {
    expect(parseStandupArgs(["--format", "slack", "--since", "2d", "--json"])).toStrictEqual({
      sinceMs: 2 * DAY_MS,
      format: "slack",
      json: true,
    });
  });
});

describe("runStandupCommand", () => {
  const out = createStreamCapture();

  beforeEach(() => {
    out.stdoutChunks.length = 0;
    out.install();
  });
  afterEach(() => {
    out.restore();
  });

  function recordingDeps(
    sink: { params?: { sinceMs: number } },
    findings: StandupBriefLike = SAMPLE_FINDINGS,
    brief = "## Reviews given\n\n- [Review on org/web#12](https://x/1) **approved**",
  ): StandupCommandDeps {
    return {
      fetchBrief: async (params) => {
        sink.params = params;
        return { brief, findings };
      },
    };
  }

  test("sends only sinceMs — never a person parameter", async () => {
    const sink: { params?: { sinceMs: number } } = {};
    await runStandupCommand([], recordingDeps(sink));
    // `toStrictEqual` on the whole object, not a property check: this asserts what is ABSENT.
    // A `personId` riding along would turn an owner-scoped brief into a dossier request, which
    // is the premise `agents.standup`'s external exclusion rests on.
    expect(sink.params).toStrictEqual({ sinceMs: DAY_MS });
  });

  test("--since reaches the gateway as a duration", async () => {
    const sink: { params?: { sinceMs: number } } = {};
    await runStandupCommand(["--since", "3d"], recordingDeps(sink));
    expect(sink.params).toStrictEqual({ sinceMs: 3 * DAY_MS });
  });

  test("--json prints the findings object, not the brief", async () => {
    await runStandupCommand(["--json"], recordingDeps({}));
    expect(out.stdoutChunks.join("")).toBe(`${JSON.stringify(SAMPLE_FINDINGS, null, 2)}\n`);
  });

  test("default format prints the brief's Markdown verbatim", async () => {
    await runStandupCommand([], recordingDeps({}));
    expect(out.stdoutChunks.join("")).toBe(
      "## Reviews given\n\n- [Review on org/web#12](https://x/1) **approved**\n",
    );
  });

  test("--format slack transforms the brief, never re-rendering findings", async () => {
    // A re-render from `findings` would silently discard a synthesized prose rewrite. The
    // fixture's `findings` are empty while its `brief` has content, so any output derived from
    // findings would be blank and this assertion would fail.
    await runStandupCommand(["--format", "slack"], recordingDeps({}));
    expect(out.stdoutChunks.join("")).toBe(
      "*Reviews given*\n\n- <https://x/1|Review on org/web#12> *approved*\n",
    );
  });

  test("--format plain transforms the brief, never re-rendering findings", async () => {
    await runStandupCommand(["--format", "plain"], recordingDeps({}));
    expect(out.stdoutChunks.join("")).toBe("Reviews given\n\n- Review on org/web#12 approved\n");
  });

  test("slack/plain convert a link whose text carries an ESCAPED bracket", async () => {
    // The cross-task seam that shipped broken on `changelog`: the gateway escapes `[` to `\[` in
    // entry titles and the CLI's link regex could not cross it, so both non-default formats
    // dumped raw URLs in the one output path whose doc comment promises not to. `[WIP]` and
    // `[PROJ-123]` prefixes trigger it, and standup's entry titles come from the same renderer.
    const brief = "- [\\[WIP\\] Fix auth](https://x/9) — 2026-09-11 14:32Z";
    await runStandupCommand(["--format", "slack"], recordingDeps({}, SAMPLE_FINDINGS, brief));
    const slack = out.stdoutChunks.join("");
    expect(slack).toContain("<https://x/9|");
    expect(slack).not.toContain("](https://x/9)");
  });
});

describe("fetchStandupBrief", () => {
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
    const err = await fetchStandupBrief({ sinceMs: DAY_MS }).catch((e: unknown) => e);
    expect(err instanceof Error ? err.message : String(err)).toContain("process.exit(1)");
    expect(out.stderrChunks.join("")).toContain("Gateway is not running");
  });

  test("an identity refusal reaches stderr with its remediation intact", async () => {
    // The whole value of `ERR_STANDUP_IDENTITY_UNRESOLVED` is the instruction it carries. If the
    // CLI swallowed or reworded it, the user would see "exit 2" and have nothing to act on.
    const message =
      "ERR_STANDUP_IDENTITY_UNRESOLVED: could not resolve which indexed person you are. " +
      "Set `[user] mePersonId` in nimbus.toml (find yours with `nimbus people list`).";
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        connect: async () => {},
        disconnect: async () => {},
        onNotification: () => {},
        call: async () => {
          throw new Error(message);
        },
      },
    });
    const err = await fetchStandupBrief({ sinceMs: DAY_MS }).catch((e: unknown) => e);
    expect(err instanceof Error ? err.message : String(err)).toContain("process.exit(2)");
    const stderr = out.stderrChunks.join("");
    expect(stderr).toContain("ERR_STANDUP_IDENTITY_UNRESOLVED");
    expect(stderr).toContain("[user] mePersonId");
    expect(stderr).toContain("nimbus people list");
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
            handlers["standup.briefReady"]?.({
              sessionId: "s1",
              brief: "hello",
              findings: SAMPLE_FINDINGS,
            });
          });
          return { sessionId: "s1" };
        },
      },
    });

    const result = await fetchStandupBrief({ sinceMs: DAY_MS });
    expect(result.brief).toBe("hello");
    expect(result.findings).toStrictEqual(SAMPLE_FINDINGS);
  });

  test("subscribes to the standup notification, not another agent's", async () => {
    // `awaitAgentBrief(client, "standup", ...)` derives both event names from that string. A
    // copy-paste leaving `"changelog"` there would hang until the TTL rather than fail loudly.
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
            handlers["standup.briefReady"]?.({
              sessionId: "s1",
              brief: "x",
              findings: SAMPLE_FINDINGS,
            });
          });
          return { sessionId: "s1" };
        },
      },
    });
    await fetchStandupBrief({ sinceMs: DAY_MS });
    expect(Object.keys(handlers)).toContain("standup.briefReady");
    expect(Object.keys(handlers)).toContain("standup.briefError");
    expect(Object.keys(handlers).some((k) => k.startsWith("changelog."))).toBe(false);
  });
});
