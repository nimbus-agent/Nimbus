import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { clearFixture, FAKE_SOCKET_PATH, setFixture } from "../../test/helpers/cli-mocks.ts";
import { createStreamCapture } from "../../test/helpers/stream-capture.ts";
import {
  fetchOncallBrief,
  isOncallBriefLike,
  type OncallBriefLike,
  type OncallCommandDeps,
  parseOncallArgs,
  runOncallCommand,
} from "./oncall.ts";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const SAMPLE_FINDINGS: OncallBriefLike = {
  kind: "oncall",
  incident: { id: "pagerduty:inc-1", title: "Checkout 500s" },
  messages: [],
  priorIncidents: [],
  gaps: [],
};

function deps(capture: { brief: string }): OncallCommandDeps {
  return {
    fetchBrief: async () => ({ brief: capture.brief, findings: SAMPLE_FINDINGS }),
  };
}

describe("isOncallBriefLike", () => {
  test("accepts a well-formed oncall brief", () => {
    expect(isOncallBriefLike(SAMPLE_FINDINGS)).toBe(true);
  });

  test("rejects a differently-kinded brief", () => {
    // The guard must key on `kind`, not on structural overlap: several briefs carry `gaps` and
    // arrays, so a shape check alone would accept one and the CLI would print it under an
    // on-call heading.
    expect(isOncallBriefLike({ ...SAMPLE_FINDINGS, kind: "standup" })).toBe(false);
  });

  test("rejects a brief with no incident — the one field that is never absent", () => {
    // The gateway REFUSES rather than emitting a brief without an incident, so its presence is
    // what distinguishes an oncall brief from anything else on the wire. An `incident: null`
    // reaching the renderer would print a page about nothing.
    const { incident: _incident, ...withoutIncident } = SAMPLE_FINDINGS;
    expect(isOncallBriefLike(withoutIncident)).toBe(false);
    expect(isOncallBriefLike({ ...SAMPLE_FINDINGS, incident: null })).toBe(false);
    // An ARRAY is an object too; `typeof [] === "object"` would pass a bare shape check.
    expect(isOncallBriefLike({ ...SAMPLE_FINDINGS, incident: [] })).toBe(false);
  });

  test("rejects null and non-objects", () => {
    expect(isOncallBriefLike(null)).toBe(false);
    expect(isOncallBriefLike("oncall")).toBe(false);
    expect(isOncallBriefLike(undefined)).toBe(false);
  });

  test("rejects a brief whose lanes are not arrays", () => {
    expect(isOncallBriefLike({ ...SAMPLE_FINDINGS, messages: null })).toBe(false);
    expect(isOncallBriefLike({ ...SAMPLE_FINDINGS, priorIncidents: 3 })).toBe(false);
    expect(isOncallBriefLike({ ...SAMPLE_FINDINGS, gaps: "none" })).toBe(false);
  });
});

describe("parseOncallArgs", () => {
  test("defaults to a 24h CHAT window, markdown, no selection flags", () => {
    expect(parseOncallArgs([])).toEqual({ sinceMs: DAY_MS, format: "markdown", json: false });
  });

  test("parses each selection shape", () => {
    expect(parseOncallArgs(["--incident", "pagerduty:inc-9"]).incidentId).toBe("pagerduty:inc-9");
    expect(parseOncallArgs(["--service", "checkout"]).service).toBe("checkout");
  });

  test("--incident and --service are mutually exclusive", () => {
    // Rejected locally as well as in the gateway: the gateway's check is the real one (it guards
    // every transport), but forwarding a contradictory pair would make the user wait for a round
    // trip to learn about a typo visible on their own command line.
    expect(() => parseOncallArgs(["--incident", "x", "--service", "y"])).toThrow(
      /mutually exclusive/,
    );
  });

  test("parses --since into milliseconds", () => {
    expect(parseOncallArgs(["--since", "3d"]).sinceMs).toBe(3 * DAY_MS);
    expect(parseOncallArgs(["--since", "6h"]).sinceMs).toBe(6 * HOUR_MS);
  });

  test("accepts each format and rejects an unknown one", () => {
    for (const f of ["markdown", "slack", "plain"] as const) {
      expect(parseOncallArgs(["--format", f]).format).toBe(f);
    }
    expect(() => parseOncallArgs(["--format", "html"])).toThrow(/--format must be one of/);
  });

  test("rejects unknown flags and stray positionals rather than ignoring them", () => {
    expect(() => parseOncallArgs(["--nope"])).toThrow(/Unknown flag/);
    expect(() => parseOncallArgs(["checkout"])).toThrow(/Unexpected argument/);
  });

  test("--help throws the usage text", () => {
    expect(() => parseOncallArgs(["--help"])).toThrow(/Usage: nimbus oncall/);
    expect(() => parseOncallArgs(["-h"])).toThrow(/Usage: nimbus oncall/);
  });

  test("a flag missing its value is an error, not a silent undefined", () => {
    expect(() => parseOncallArgs(["--since"])).toThrow();
    expect(() => parseOncallArgs(["--incident"])).toThrow();
  });
});

describe("runOncallCommand", () => {
  test("prints the brief's own Markdown by default", async () => {
    const cap = createStreamCapture();
    cap.install();
    try {
      await runOncallCommand([], deps({ brief: "# On-call\n\n## Incident\n" }));
    } finally {
      cap.restore();
    }
    expect(cap.stdoutChunks.join("")).toContain("## Incident");
  });

  test("--json prints the findings instead of the brief", async () => {
    const cap = createStreamCapture();
    cap.install();
    try {
      await runOncallCommand(["--json"], deps({ brief: "# On-call\n" }));
    } finally {
      cap.restore();
    }
    const out = JSON.parse(cap.stdoutChunks.join("")) as OncallBriefLike;
    expect(out.kind).toBe("oncall");
    expect(out.incident["id"]).toBe("pagerduty:inc-1");
    // The brief's Markdown must NOT be what --json prints.
    expect(cap.stdoutChunks.join("")).not.toContain("# On-call");
  });

  test("--format transforms the brief's Markdown rather than re-rendering from findings", async () => {
    // Synthesis may have rewritten the brief into prose; re-deriving output from `findings` here
    // would silently discard that prose. The transform must therefore operate on `brief`.
    const cap = createStreamCapture();
    cap.install();
    try {
      await runOncallCommand(
        ["--format", "plain"],
        deps({ brief: "# On-call\n\n**bold** prose the model wrote\n" }),
      );
    } finally {
      cap.restore();
    }
    expect(cap.stdoutChunks.join("")).toContain("prose the model wrote");
  });

  test("forwards the selection flags to the gateway verbatim", async () => {
    let seen: { sinceMs: number; incidentId?: string; service?: string } | undefined;
    const capturing: OncallCommandDeps = {
      fetchBrief: async (params) => {
        seen = params;
        return { brief: "# On-call\n", findings: SAMPLE_FINDINGS };
      },
    };
    const cap = createStreamCapture();
    cap.install();
    try {
      await runOncallCommand(["--service", "checkout", "--since", "2d"], capturing);
    } finally {
      cap.restore();
    }
    expect(seen).toEqual({ sinceMs: 2 * DAY_MS, service: "checkout" });
    // `incidentId` must be ABSENT rather than explicitly undefined: the gateway validator
    // distinguishes "not supplied" from a supplied bad value, and an explicit `undefined`
    // survives JSON.stringify as a dropped key here but not through every transport.
    expect(Object.hasOwn(seen ?? {}, "incidentId")).toBe(false);
  });

  test("forwards --incident and omits service", async () => {
    let seen: { sinceMs: number; incidentId?: string; service?: string } | undefined;
    const capturing: OncallCommandDeps = {
      fetchBrief: async (params) => {
        seen = params;
        return { brief: "# On-call\n", findings: SAMPLE_FINDINGS };
      },
    };
    const cap = createStreamCapture();
    cap.install();
    try {
      await runOncallCommand(["--incident", "pagerduty:inc-9"], capturing);
    } finally {
      cap.restore();
    }
    expect(seen?.incidentId).toBe("pagerduty:inc-9");
    expect(Object.hasOwn(seen ?? {}, "service")).toBe(false);
  });
});

describe("fetchOncallBrief", () => {
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
    const err = await fetchOncallBrief({ sinceMs: DAY_MS }).catch((e: unknown) => e);
    expect(err instanceof Error ? err.message : String(err)).toContain("process.exit(1)");
    expect(out.stderrChunks.join("")).toContain("Gateway is not running");
  });

  test("a no-active-incident refusal reaches stderr with its remediation intact", async () => {
    // The whole value of `ERR_ONCALL_NO_ACTIVE_INCIDENT` is the instruction it carries. If the CLI
    // swallowed or reworded it, the user would see "exit 2" during an incident and have nothing to
    // act on — the moment this command exists for.
    const message =
      "ERR_ONCALL_NO_ACTIVE_INCIDENT: no active incident is assigned to you. Name one explicitly " +
      "with `--incident <item-id>`, widen with `--service <name>`, or check `nimbus index health`.";
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
    const err = await fetchOncallBrief({ sinceMs: DAY_MS }).catch((e: unknown) => e);
    expect(err instanceof Error ? err.message : String(err)).toContain("process.exit(2)");
    const stderr = out.stderrChunks.join("");
    expect(stderr).toContain("ERR_ONCALL_NO_ACTIVE_INCIDENT");
    expect(stderr).toContain("--incident");
    expect(stderr).toContain("nimbus index health");
  });

  test("an identity refusal is NOT collapsed into the no-incident one", async () => {
    // "Nobody is paging you" and "I cannot tell who you are" have opposite fixes, and the CLI must
    // pass whichever the gateway sent through untouched.
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        connect: async () => {},
        disconnect: async () => {},
        onNotification: () => {},
        call: async () => {
          throw new Error("ERR_ONCALL_IDENTITY_UNRESOLVED: set `[user] mePersonId`.");
        },
      },
    });
    await fetchOncallBrief({ sinceMs: DAY_MS }).catch((e: unknown) => e);
    const stderr = out.stderrChunks.join("");
    expect(stderr).toContain("ERR_ONCALL_IDENTITY_UNRESOLVED");
    expect(stderr).not.toContain("ERR_ONCALL_NO_ACTIVE_INCIDENT");
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
            handlers["oncall.briefReady"]?.({
              sessionId: "s1",
              brief: "hello",
              findings: SAMPLE_FINDINGS,
            });
          });
          return { sessionId: "s1" };
        },
      },
    });

    const result = await fetchOncallBrief({ sinceMs: DAY_MS });
    expect(result.brief).toBe("hello");
    expect(result.findings).toStrictEqual(SAMPLE_FINDINGS);
  });

  test("subscribes to the oncall notification, not another agent's", async () => {
    // `awaitAgentBrief(client, "oncall", ...)` derives both event names from that string. A
    // copy-paste leaving `"standup"` there would hang until the TTL rather than fail loudly.
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
            handlers["oncall.briefReady"]?.({
              sessionId: "s1",
              brief: "x",
              findings: SAMPLE_FINDINGS,
            });
          });
          return { sessionId: "s1" };
        },
      },
    });
    await fetchOncallBrief({ sinceMs: DAY_MS });
    expect(Object.keys(handlers)).toContain("oncall.briefReady");
    expect(Object.keys(handlers)).toContain("oncall.briefError");
    expect(Object.keys(handlers).some((k) => k.startsWith("standup."))).toBe(false);
  });

  test("forwards the selection params over IPC verbatim", async () => {
    let sentParams: unknown;
    const handlers: Record<string, (params: unknown) => void> = {};
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        connect: async () => {},
        disconnect: async () => {},
        onNotification: (event: string, handler: (params: unknown) => void) => {
          handlers[event] = handler;
        },
        call: async (_method: string, params: unknown) => {
          sentParams = params;
          queueMicrotask(() => {
            handlers["oncall.briefReady"]?.({
              sessionId: "s1",
              brief: "x",
              findings: SAMPLE_FINDINGS,
            });
          });
          return { sessionId: "s1" };
        },
      },
    });
    await fetchOncallBrief({ sinceMs: DAY_MS, service: "checkout" });
    expect(sentParams).toEqual({ sinceMs: DAY_MS, service: "checkout" });
  });
});

describe("parseOncallArgs — the 90d bound (CodeRabbit #1509)", () => {
  test("rejects a window past the documented maximum instead of forwarding it", () => {
    // The usage text declares `max 90d`. Forwarding 91d anyway made that text a lie and cost the
    // user a gateway round trip to learn it — the same reasoning that already rejects a
    // contradictory `--incident`/`--service` pair locally.
    expect(() => parseOncallArgs(["--since", "91d"])).toThrow(/must not exceed 90d/);
    expect(() => parseOncallArgs(["--since", "52w"])).toThrow(/must not exceed 90d/);
  });

  test("accepts exactly 90d — the bound is inclusive, matching the gateway's", () => {
    expect(parseOncallArgs(["--since", "90d"]).sinceMs).toBe(90 * DAY_MS);
  });
});
