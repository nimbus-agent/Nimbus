import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isolatePlatformEnv } from "../../test/helpers/isolate-platform-env.ts";
import { createStreamCapture } from "../../test/helpers/stream-capture.ts";
import {
  FLEET_EXIT_CODES,
  type FleetIpc,
  type OutcomeSink,
  parseFleetArgs,
  runFleet,
  runFleetCommand,
} from "./fleet.ts";

/**
 * Branches `fleet.test.ts` leaves unexercised: a flag whose "value" is another flag, the probe and
 * sweep fields an older or idle gateway leaves null, the briefs filters on the wire, `show --json`
 * for a missing brief, a non-Error RPC failure, and the production stdout/stderr sink.
 */

function sink(): OutcomeSink & { readonly outs: string[]; readonly errs: string[] } {
  const outs: string[] = [];
  const errs: string[] = [];
  return { outs, errs, out: (s) => outs.push(s), err: (s) => errs.push(s) };
}

function recording(reply: unknown): FleetIpc & {
  readonly calls: Array<{ method: string; params: unknown }>;
} {
  const calls: Array<{ method: string; params: unknown }> = [];
  return {
    calls,
    call: async (method, params) => {
      calls.push({ method, params });
      return reply;
    },
  };
}

describe("argument edges", () => {
  test("a flag followed by another flag has no value — it is ignored, not swallowed", () => {
    expect(parseFleetArgs(["briefs", "--job", "--json"])).toEqual({ sub: "briefs", json: true });
    expect(parseFleetArgs(["briefs", "--subject"])).toEqual({ sub: "briefs", json: false });
  });
});

describe("rendering fields the gateway may leave null", () => {
  test("status with no idle measurement prints 'unknown', not 'null'", async () => {
    const s = sink();
    const code = await runFleetCommand(
      recording({
        enabled: false,
        running: false,
        allowRemote: false,
        remoteCallBudget: 0,
        minIdleSeconds: 600,
        requireAcPower: false,
        retentionDays: 7,
        jobsConfigured: 0,
        probe: { power: "battery", idleMs: null, source: "power_only" },
      }),
      { sub: "status", json: false },
      s,
    );
    expect(code).toBe(FLEET_EXIT_CODES.ok);
    const text = s.outs.join("");
    expect(text).toContain("fleet: disabled (not running)\n");
    expect(text).toContain("  host idle ms:       unknown\n");
    expect(text).not.toContain("null");
  });

  test("a sweep whose subject total is unknown shows '?'", async () => {
    const s = sink();
    await runFleetCommand(
      recording({
        jobs: [
          {
            name: "owners-sweep",
            agent: "ownership",
            intervalSeconds: 3600,
            state: {
              lastAttemptAt: 1,
              lastSuccessAt: null,
              consecutiveFailures: 2,
              backoffUntil: null,
              lastError: "x",
            },
            sweep: {
              kind: "paths",
              maxSubjects: 10,
              pathPrefix: null,
              subjectsTotal: null,
              cursor: null,
              emptyReason: null,
              rotationExceedsRetention: false,
            },
          },
        ],
      }),
      { sub: "list", json: false },
      s,
    );
    expect(s.outs).toEqual([
      "owners-sweep  agent=ownership  interval=3600s  last success=never  consecutive failures=2  sweep=paths max=10 total=?\n",
    ]);
  });
});

describe("briefs and show on the wire", () => {
  test("--limit and --job reach fleet.briefs as limit / jobId", async () => {
    const ipc = recording({ briefs: [] });
    const cmd = parseFleetArgs(["briefs", "--limit", "3", "--job", "nightly"]);
    if (cmd === undefined) throw new Error("expected briefs to parse");
    await runFleetCommand(ipc, cmd, sink());
    expect(ipc.calls).toEqual([{ method: "fleet.briefs", params: { limit: 3, jobId: "nightly" } }]);
  });

  test("show --json for a missing brief prints the null result and exits notFound", async () => {
    const s = sink();
    const code = await runFleetCommand(
      recording({ brief: null }),
      { sub: "show", id: "brief-gone", json: true },
      s,
    );
    expect(code).toBe(FLEET_EXIT_CODES.notFound);
    expect(s.outs).toEqual(['{"brief":null}\n']);
    expect(s.errs).toEqual([]);
  });

  test("a non-Error RPC failure is reported verbatim and exits disabled", async () => {
    const s = sink();
    const code = await runFleetCommand(
      {
        call: async () => {
          throw "store unavailable";
        },
      },
      { sub: "list", json: false },
      s,
    );
    expect(code).toBe(FLEET_EXIT_CODES.disabled);
    expect(s.errs).toEqual(["store unavailable\n"]);
  });
});

describe("production sink", () => {
  test("with no sink, output goes to stdout and an RPC failure to stderr", async () => {
    const cap = createStreamCapture();
    cap.install();
    let okCode: number;
    let failCode: number;
    try {
      okCode = await runFleetCommand(recording({ jobs: [] }), { sub: "list", json: false });
      failCode = await runFleetCommand(
        {
          call: async () => {
            throw new Error("fleet: store not available");
          },
        },
        { sub: "list", json: false },
      );
    } finally {
      cap.restore();
    }
    expect(okCode).toBe(FLEET_EXIT_CODES.ok);
    expect(failCode).toBe(FLEET_EXIT_CODES.disabled);
    expect(cap.stdoutChunks).toEqual(["no fleet jobs configured\n"]);
    expect(cap.stderrChunks).toEqual(["fleet: store not available\n"]);
  });

  test("with no deps, an unparseable command prints usage to stderr and exits usage without connecting", async () => {
    const restoreEnv = isolatePlatformEnv(join(tmpdir(), "nimbus-fleet-cov-env-never-created"));
    const cap = createStreamCapture();
    cap.install();
    let code: number;
    try {
      code = await runFleet(["frobnicate"]);
    } finally {
      cap.restore();
      restoreEnv();
    }
    expect(code).toBe(FLEET_EXIT_CODES.usage);
    expect(cap.stderrChunks.join("")).toStartWith(
      "Usage: nimbus fleet <status|list|briefs|show|run|digest>",
    );
    expect(cap.stdoutChunks).toEqual([]);
  });
});
