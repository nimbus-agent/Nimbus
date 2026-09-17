import { describe, expect, test } from "bun:test";
import { JsonRpcError } from "@nimbus-dev/client";
import { BATCH_RPC_TIMEOUT_MS } from "../lib/rpc-timeouts.ts";
import {
  FLEET_EXIT_CODES,
  type FleetIpc,
  type OutcomeSink,
  type ParsedFleetArgs,
  parseFleetArgs,
  type RunFleetDeps,
  runFleet,
  runFleetCommand,
} from "./fleet.ts";

test("parses the subcommands", () => {
  expect(parseFleetArgs(["status"])).toEqual({ sub: "status", json: false });
  expect(parseFleetArgs(["briefs", "--limit", "5", "--json"])).toEqual({
    sub: "briefs",
    limit: 5,
    json: true,
  });
  expect(parseFleetArgs(["run", "morning_catchup", "--force"])).toEqual({
    sub: "run",
    job: "morning_catchup",
    force: true,
    json: false,
  });
});

test("an unknown subcommand is rejected", () => {
  expect(parseFleetArgs(["frobnicate"])).toBeUndefined();
});

test("run without a job name is rejected", () => {
  expect(parseFleetArgs(["run"])).toBeUndefined();
});

test("list and show parse cleanly", () => {
  expect(parseFleetArgs(["list", "--json"])).toEqual({ sub: "list", json: true });
  expect(parseFleetArgs(["show", "brief-1"])).toEqual({ sub: "show", id: "brief-1", json: false });
});

test("show without an id is rejected", () => {
  expect(parseFleetArgs(["show"])).toBeUndefined();
});

test("briefs --limit 0 or non-numeric is rejected, not silently defaulted", () => {
  expect(parseFleetArgs(["briefs", "--limit", "0"])).toBeUndefined();
  expect(parseFleetArgs(["briefs", "--limit", "abc"])).toBeUndefined();
});

test("briefs --job filters by job id", () => {
  expect(parseFleetArgs(["briefs", "--job", "morning_catchup"])).toEqual({
    sub: "briefs",
    job: "morning_catchup",
    json: false,
  });
});

test("parses briefs --subject", () => {
  expect(parseFleetArgs(["briefs", "--subject", "paths:file:/r:a.ts"])).toEqual({
    sub: "briefs",
    subject: "paths:file:/r:a.ts",
    json: false,
  });
});

function sinkSpy(): {
  out: string[];
  err: string[];
  sink: { out: (s: string) => void; err: (s: string) => void };
} {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, sink: { out: (s) => out.push(s), err: (s) => err.push(s) } };
}

test("fleet.status renders the probe and config", async () => {
  const client: FleetIpc = {
    call: async () => ({
      enabled: true,
      running: true,
      allowRemote: false,
      remoteCallBudget: 0,
      minIdleSeconds: 900,
      requireAcPower: true,
      retentionDays: 14,
      jobsConfigured: 2,
      probe: { power: "ac", idleMs: 1000, source: "measured" },
    }),
  };
  const { out, sink } = sinkSpy();
  const code = await runFleetCommand(client, { sub: "status", json: false }, sink);
  expect(code).toBe(FLEET_EXIT_CODES.ok);
  const rendered = out.join("");
  expect(rendered).toContain("fleet: enabled (running)");
  expect(rendered).toContain("jobs configured:    2");
});

test("fleet.runNow threads job and force through to the call params", async () => {
  let seenMethod = "";
  let seenParams: unknown;
  const client: FleetIpc = {
    call: async (method, params) => {
      seenMethod = method;
      seenParams = params;
      return {
        runId: "r1",
        outcome: "completed",
        jobsAttempted: 1,
        jobsCompleted: 1,
        jobsUnattempted: 0,
        jobsSkippedNotDue: 0,
      };
    },
  };
  const { sink } = sinkSpy();
  const code = await runFleetCommand(
    client,
    { sub: "run", job: "morning_catchup", force: true, json: false },
    sink,
  );
  expect(code).toBe(FLEET_EXIT_CODES.ok);
  expect(seenMethod).toBe("fleet.runNow");
  expect(seenParams).toEqual({ job: "morning_catchup", force: true });
});

test("a deferred run with runId null reports the machine was already busy running something else", async () => {
  const client: FleetIpc = {
    call: async () => ({
      runId: null,
      outcome: "deferred",
      jobsAttempted: 0,
      jobsCompleted: 0,
      jobsUnattempted: 2,
      jobsSkippedNotDue: 0,
    }),
  };
  const { out, sink } = sinkSpy();
  const code = await runFleetCommand(
    client,
    { sub: "run", job: "morning_catchup", force: false, json: false },
    sink,
  );
  expect(code).toBe(FLEET_EXIT_CODES.deferred);
  expect(out.join("")).toContain("already in flight");
});

test("a deferred run with a real runId reports a power/idle refusal, not an in-flight one", async () => {
  const client: FleetIpc = {
    call: async () => ({
      runId: "run-42",
      outcome: "deferred",
      jobsAttempted: 0,
      jobsCompleted: 0,
      jobsUnattempted: 2,
      jobsSkippedNotDue: 0,
    }),
  };
  const { out, sink } = sinkSpy();
  const code = await runFleetCommand(
    client,
    { sub: "run", job: "morning_catchup", force: false, json: false },
    sink,
  );
  expect(code).toBe(FLEET_EXIT_CODES.deferred);
  const rendered = out.join("");
  expect(rendered).toContain("battery or in use");
  expect(rendered).not.toContain("already in flight");
});

test("a failed run exits nonzero and a completed run exits 0", async () => {
  const outcomes: Array<[string, number]> = [
    ["completed", FLEET_EXIT_CODES.ok],
    ["yielded", FLEET_EXIT_CODES.ok],
    ["failed", FLEET_EXIT_CODES.failed],
  ];
  for (const [outcome, expected] of outcomes) {
    const client: FleetIpc = {
      call: async () => ({
        runId: "r",
        outcome,
        jobsAttempted: 1,
        jobsCompleted: outcome === "completed" ? 1 : 0,
        jobsUnattempted: 0,
        jobsSkippedNotDue: 0,
      }),
    };
    const { sink } = sinkSpy();
    const code = await runFleetCommand(
      client,
      { sub: "run", job: "j", force: false, json: false },
      sink,
    );
    expect(code).toBe(expected);
  }
});

test("fleet.show returns null for an unknown or expired brief and exits notFound", async () => {
  const client: FleetIpc = { call: async () => ({ brief: null }) };
  const { out, err, sink } = sinkSpy();
  const code = await runFleetCommand(client, { sub: "show", id: "nope", json: false }, sink);
  expect(code).toBe(FLEET_EXIT_CODES.notFound);
  expect(out).toEqual([]);
  expect(err.join("")).toContain("no such brief");
});

test("--json emits machine-readable output for every subcommand", async () => {
  const statusResponse = {
    enabled: true,
    running: false,
    allowRemote: false,
    remoteCallBudget: 0,
    minIdleSeconds: 900,
    requireAcPower: true,
    retentionDays: 14,
    jobsConfigured: 0,
    probe: { power: "ac", idleMs: 0, source: "measured" },
  };
  const briefResponse = {
    id: "b1",
    runId: "r1",
    jobId: "j1",
    agentMethod: "agents.catchup",
    briefMarkdown: "# hi",
    findingsJson: "{}",
    synthesisJson: null,
    createdAt: 0,
  };
  const responses: Record<string, unknown> = {
    "fleet.status": statusResponse,
    "fleet.list": { jobs: [] },
    "fleet.briefs": { briefs: [briefResponse] },
    "fleet.show": { brief: briefResponse },
    "fleet.runNow": {
      runId: "r1",
      outcome: "completed",
      jobsAttempted: 1,
      jobsCompleted: 1,
      jobsUnattempted: 0,
      jobsSkippedNotDue: 0,
    },
  };
  const client: FleetIpc = { call: async (method) => responses[method] };
  const cmds: ParsedFleetArgs[] = [
    { sub: "status", json: true },
    { sub: "list", json: true },
    { sub: "briefs", json: true },
    { sub: "show", id: "b1", json: true },
    { sub: "run", job: "j1", force: false, json: true },
  ];
  for (const cmd of cmds) {
    const { out, sink } = sinkSpy();
    await runFleetCommand(client, cmd, sink);
    expect(() => JSON.parse(out.join(""))).not.toThrow();
  }
});

test("runFleet prints usage and exits `usage` for an unparseable command", async () => {
  const { err, sink } = sinkSpy();
  const code = await runFleet(["frobnicate"], {
    runWithClient: () => {
      throw new Error("should not connect for an unparseable command");
    },
    sink,
  });
  expect(code).toBe(FLEET_EXIT_CODES.usage);
  expect(err.join("")).toContain("Usage: nimbus fleet");
});

test("runFleet uses the batch timeout budget for `run` and none for reads", async () => {
  const seenTimeouts: Array<number | undefined> = [];
  const deps = {
    runWithClient: async <T>(fn: (c: FleetIpc) => Promise<T>, timeoutMs?: number): Promise<T> => {
      seenTimeouts.push(timeoutMs);
      return fn({ call: async () => ({}) });
    },
    sink: sinkSpy().sink,
  };
  await runFleet(["status"], deps);
  await runFleet(["run", "j"], deps);
  expect(seenTimeouts[0]).toBeUndefined();
  expect(seenTimeouts[1]).toBeGreaterThan(0);
});

test("a real JsonRpcError with code -32602 (no such job) exits notFound; -32000 exits disabled", async () => {
  // The REAL transport class, not a lookalike: `jsonRpcErrorCode` is a brand check (see its own
  // doc comment), so a plain Error-with-a-.code property would silently fail to be recognised —
  // exactly the gap this test exists to catch.
  const notFoundClient: FleetIpc = {
    call: async () => {
      throw new JsonRpcError("fleet: no such fleet job: typo_job", -32602, undefined);
    },
  };
  const disabledClient: FleetIpc = {
    call: async () => {
      throw new JsonRpcError("fleet: not running", -32000, undefined);
    },
  };
  const s1 = sinkSpy();
  const code1 = await runFleetCommand(
    notFoundClient,
    { sub: "run", job: "typo_job", force: false, json: false },
    s1.sink,
  );
  const s2 = sinkSpy();
  const code2 = await runFleetCommand(
    disabledClient,
    { sub: "run", job: "j", force: false, json: false },
    s2.sink,
  );
  expect(code1).toBe(FLEET_EXIT_CODES.notFound);
  expect(code2).toBe(FLEET_EXIT_CODES.disabled);
});

test("the SAME translation applies to fleet.show, not just fleet.run", async () => {
  // Before this fix, only `runRun` translated -32602/-32000; every other subcommand's error fell
  // through to `runFleet`'s outer catch, which always reports `disabled` regardless of the real
  // code — so a -32602 from `fleet.show` (a bad/missing id) looked identical to a -32000 (the
  // fleet has no store wired at all), and a user asking about a specific brief would always be
  // told "the fleet is disabled" even when that was not the actual reason.
  const badIdClient: FleetIpc = {
    call: async () => {
      throw new JsonRpcError("fleet: id (non-empty string) required", -32602, undefined);
    },
  };
  const noStoreClient: FleetIpc = {
    call: async () => {
      throw new JsonRpcError("fleet: store not available", -32000, undefined);
    },
  };
  const s1 = sinkSpy();
  const code1 = await runFleetCommand(
    badIdClient,
    { sub: "show", id: "whatever", json: false },
    s1.sink,
  );
  const s2 = sinkSpy();
  const code2 = await runFleetCommand(
    noStoreClient,
    { sub: "show", id: "whatever", json: false },
    s2.sink,
  );
  expect(code1).toBe(FLEET_EXIT_CODES.notFound);
  expect(code2).toBe(FLEET_EXIT_CODES.disabled);
});

test("fleet.briefs also gets the shared translation for a -32000 (no store wired)", async () => {
  const client: FleetIpc = {
    call: async () => {
      throw new JsonRpcError("fleet: store not available", -32000, undefined);
    },
  };
  const { sink } = sinkSpy();
  const code = await runFleetCommand(client, { sub: "briefs", json: false }, sink);
  expect(code).toBe(FLEET_EXIT_CODES.disabled);
});
// ── Human-readable rendering. Every subcommand has a `--json` arm AND a text arm, and only the
// JSON arm was exercised. That is the half a person actually reads, and it is where the empty-vs-
// populated distinction lives: "no fleet briefs" and a list of briefs are different answers, and a
// renderer that printed nothing for both would have passed every test above.

test("fleet.list renders each configured job, including one that has never run", async () => {
  const client: FleetIpc = {
    call: async () => ({
      jobs: [
        {
          name: "morning-catchup",
          agent: "catchup",
          intervalSeconds: 86400,
          state: {
            jobId: "morning-catchup",
            lastAttemptAt: 1_757_200_000_000,
            lastSuccessAt: 1_757_200_000_000,
            consecutiveFailures: 0,
            backoffUntil: null,
            lastError: null,
          },
        },
        // `state: null` is the never-run case — it must render "never"/0 rather than crashing on
        // the optional chain or printing "undefined" at the user.
        { name: "weekly-owners", agent: "ownership", intervalSeconds: 604800, state: null },
      ],
    }),
  };
  const s = sinkSpy();
  const code = await runFleetCommand(client, { sub: "list", json: false }, s.sink);
  expect(code).toBe(FLEET_EXIT_CODES.ok);
  const text = s.out.join("");
  expect(text).toContain("morning-catchup  agent=catchup  interval=86400s");
  expect(text).toContain("weekly-owners  agent=ownership  interval=604800s");
  expect(text).toContain("last success=never");
  expect(text).toContain("consecutive failures=0");
  // The ISO timestamp is rendered from `lastSuccessAt`, not omitted, on the job that HAS run.
  expect(text).toContain(new Date(1_757_200_000_000).toISOString());
});

test("fleet.list with nothing configured says so rather than printing an empty block", async () => {
  const client: FleetIpc = { call: async () => ({ jobs: [] }) };
  const s = sinkSpy();
  const code = await runFleetCommand(client, { sub: "list", json: false }, s.sink);
  expect(code).toBe(FLEET_EXIT_CODES.ok);
  expect(s.out.join("")).toBe("no fleet jobs configured\n");
});

test("fleet.briefs renders one line per brief, newest-first order preserved", async () => {
  const client: FleetIpc = {
    call: async () => ({
      briefs: [
        {
          id: "b2",
          runId: "r1",
          jobId: "morning-catchup",
          agentMethod: "agents.catchup",
          briefMarkdown: "# later",
          findingsJson: "[]",
          synthesisJson: null,
          createdAt: 1_757_200_000_000,
        },
        {
          id: "b1",
          runId: "r1",
          jobId: "weekly-owners",
          agentMethod: "agents.ownership",
          briefMarkdown: null,
          findingsJson: "[]",
          synthesisJson: null,
          createdAt: 1_757_100_000_000,
        },
      ],
    }),
  };
  const s = sinkSpy();
  const code = await runFleetCommand(client, { sub: "briefs", json: false }, s.sink);
  expect(code).toBe(FLEET_EXIT_CODES.ok);
  expect(s.out).toEqual([
    `b2  morning-catchup  agents.catchup  ${new Date(1_757_200_000_000).toISOString()}\n`,
    `b1  weekly-owners  agents.ownership  ${new Date(1_757_100_000_000).toISOString()}\n`,
  ]);
});

test("briefs sends subjectKey and shows a subject only when it differs from the job", async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const out: string[] = [];
  const ipc: FleetIpc = {
    call: async (method, params) => {
      calls.push({ method, params });
      return {
        briefs: [
          {
            id: "b1",
            runId: "r",
            jobId: "nightly",
            subjectKey: "nightly",
            agentMethod: "agents.catchup",
            briefMarkdown: null,
            findingsJson: "{}",
            synthesisJson: null,
            createdAt: 0,
          },
          {
            id: "b2",
            runId: "r",
            jobId: "bus",
            subjectKey: "paths:a",
            agentMethod: "agents.ownership",
            briefMarkdown: null,
            findingsJson: "{}",
            synthesisJson: null,
            createdAt: 0,
          },
        ],
      };
    },
  };
  await runFleetCommand(
    ipc,
    { sub: "briefs", subject: "paths:a", json: false },
    { out: (s) => out.push(s), err: () => {} },
  );
  expect(calls[0]?.params).toEqual({ subjectKey: "paths:a" });
  expect(out[0]).toBe(`b1  nightly  agents.catchup  ${new Date(0).toISOString()}\n`);
  expect(out[1]).toBe(`b2  bus  [paths:a]  agents.ownership  ${new Date(0).toISOString()}\n`);
});

test("list shows sweep info and an empty reason", async () => {
  const out: string[] = [];
  const ipc: FleetIpc = {
    call: async () => ({
      jobs: [
        {
          name: "bus",
          agent: "ownership",
          intervalSeconds: 60,
          state: null,
          sweep: {
            kind: "paths",
            maxSubjects: 20,
            pathPrefix: null,
            subjectsTotal: 0,
            cursor: null,
            emptyReason: "no roots",
            rotationExceedsRetention: null,
          },
        },
      ],
    }),
  };
  await runFleetCommand(
    ipc,
    { sub: "list", json: false },
    { out: (s) => out.push(s), err: () => {} },
  );
  expect(out.join("")).toContain("sweep=paths max=20 total=0");
  expect(out.join("")).toContain("empty: no roots");
});

// Finding 8 of the whole-branch review: the gateway asserts the `rotationExceedsRetention`
// BOOLEAN in its own tests, but nothing anywhere asserted the WARNING sentence a user actually
// sees printed for it. Sibling of the test above, same fixture shape, `rotationExceedsRetention`
// flipped to `true`.
test("list shows the rotation-exceeds-retention WARNING text", async () => {
  const out: string[] = [];
  const ipc: FleetIpc = {
    call: async () => ({
      jobs: [
        {
          name: "bus",
          agent: "ownership",
          intervalSeconds: 60,
          state: null,
          sweep: {
            kind: "paths",
            maxSubjects: 20,
            pathPrefix: null,
            subjectsTotal: 500,
            cursor: null,
            emptyReason: null,
            rotationExceedsRetention: true,
          },
        },
      ],
    }),
  };
  await runFleetCommand(
    ipc,
    { sub: "list", json: false },
    { out: (s) => out.push(s), err: () => {} },
  );
  expect(out.join("")).toContain(
    "WARNING: a full rotation outlasts retention; this sweep cannot report movement",
  );
});

test("fleet.briefs with no rows says so rather than printing nothing", async () => {
  const client: FleetIpc = { call: async () => ({ briefs: [] }) };
  const s = sinkSpy();
  const code = await runFleetCommand(client, { sub: "briefs", json: false }, s.sink);
  expect(code).toBe(FLEET_EXIT_CODES.ok);
  expect(s.out.join("")).toBe("no fleet briefs\n");
});

test("fleet.show prints the markdown body to stdout", async () => {
  const client: FleetIpc = {
    call: async () => ({
      brief: {
        id: "b1",
        runId: "r1",
        jobId: "morning-catchup",
        agentMethod: "agents.catchup",
        briefMarkdown: "# Catchup\n\nnothing moved.",
        findingsJson: "[]",
        synthesisJson: null,
        createdAt: 1_757_200_000_000,
      },
    }),
  };
  const s = sinkSpy();
  const code = await runFleetCommand(client, { sub: "show", id: "b1", json: false }, s.sink);
  expect(code).toBe(FLEET_EXIT_CODES.ok);
  expect(s.out.join("")).toBe("# Catchup\n\nnothing moved.\n");
  expect(s.err).toEqual([]);
});

test("fleet.show on a brief with findings but no synthesised body says so, not 'null'", async () => {
  // `brief_markdown` is nullable by design — a job can complete with findings and no synthesis
  // (I38 refusing a remote model is exactly that case). Printing the literal "null" here would be
  // the disclosure failure, on the surface a person reads.
  const client: FleetIpc = {
    call: async () => ({
      brief: {
        id: "b1",
        runId: "r1",
        jobId: "morning-catchup",
        agentMethod: "agents.catchup",
        briefMarkdown: null,
        findingsJson: "[]",
        synthesisJson: null,
        createdAt: 1_757_200_000_000,
      },
    }),
  };
  const s = sinkSpy();
  const code = await runFleetCommand(client, { sub: "show", id: "b1", json: false }, s.sink);
  expect(code).toBe(FLEET_EXIT_CODES.ok);
  expect(s.out.join("")).toBe("(no markdown body)\n");
});

test("fleet.show reports an unresolvable id on STDERR with the notFound code", async () => {
  const client: FleetIpc = { call: async () => ({ brief: null }) };
  const s = sinkSpy();
  const code = await runFleetCommand(client, { sub: "show", id: "nope", json: false }, s.sink);
  expect(code).toBe(FLEET_EXIT_CODES.notFound);
  expect(s.out).toEqual([]);
  expect(s.err.join("")).toBe("nimbus: no such brief, or it has expired: nope\n");
});

// ── `runFleet`'s own orchestration, through its injected deps — an arm no test entered. ──

test("runFleet prints USAGE to stderr and exits 1 without opening a connection", async () => {
  const s = sinkSpy();
  const code = await runFleet(["frobnicate"], {
    runWithClient: async () => {
      throw new Error("must not connect to a gateway for a usage error");
    },
    sink: s.sink,
  });
  expect(code).toBe(FLEET_EXIT_CODES.usage);
  expect(s.err.join("")).toContain("Usage: nimbus fleet");
  expect(s.out).toEqual([]);
});

test("runFleet gives `run` the batch timeout and the other subcommands the default", async () => {
  // `run` awaits a whole overnight job; the 30s default would abort a cold catchup mid-synthesis
  // and report it as a failure. Asserted as the VALUE passed, not merely that a timeout was given.
  const seen: (number | undefined)[] = [];
  const mkDeps = (sink: OutcomeSink): RunFleetDeps => ({
    runWithClient: async (fn, timeoutMs) => {
      seen.push(timeoutMs);
      return await fn({
        call: async () => ({
          runId: "r1",
          outcome: "completed",
          jobsAttempted: 1,
          jobsCompleted: 1,
          jobsUnattempted: 0,
          jobsSkippedNotDue: 0,
          jobs: [],
        }),
      });
    },
    sink,
  });
  const s = sinkSpy();
  await runFleet(["run", "morning-catchup"], mkDeps(s.sink));
  await runFleet(["list"], mkDeps(s.sink));
  expect(seen).toEqual([BATCH_RPC_TIMEOUT_MS, undefined]);
});

test("runFleet turns a transport failure into one stderr line and the disabled code", async () => {
  // The gateway not being up at all reaches `runFleet`'s OUTER catch rather than the per-command
  // RPC translation, so it needs its own arm: a user with no gateway running must get one line,
  // not a stack trace.
  const s = sinkSpy();
  const code = await runFleet(["status"], {
    runWithClient: async () => {
      throw new Error("connect ENOENT /tmp/nimbus.sock");
    },
    sink: s.sink,
  });
  expect(code).toBe(FLEET_EXIT_CODES.disabled);
  expect(s.err.join("")).toBe("connect ENOENT /tmp/nimbus.sock\n");
});

test("a non-Error throw is still reported as one line, never as [object Object]", async () => {
  const s = sinkSpy();
  const code = await runFleet(["status"], {
    runWithClient: async () => {
      // A bare string throw, deliberately: `runFleet`'s catch has an `instanceof Error` ternary,
      // and only a non-Error value reaches its other arm.
      throw "socket closed";
    },
    sink: s.sink,
  });
  expect(code).toBe(FLEET_EXIT_CODES.disabled);
  expect(s.err.join("")).toBe("socket closed\n");
});

describe("nimbus fleet digest", () => {
  test("parses --since into windowMs", () => {
    const p = parseFleetArgs(["digest", "--since", "7d"]);
    expect(p).toMatchObject({ sub: "digest", windowMs: 7 * 86_400_000 });
  });

  test("defaults to 24h", () => {
    expect(parseFleetArgs(["digest"])).toMatchObject({ windowMs: 86_400_000 });
  });

  test("rejects an unparseable duration", () => {
    expect(parseFleetArgs(["digest", "--since", "banana"])).toBeUndefined();
  });

  // `parseDurationToMs("0s")` parses cleanly to 0 — this is a usage error via the `windowMs <= 0`
  // check, not a parse failure, so it must be red-proved separately from "banana" above.
  test("rejects a zero-length window", () => {
    expect(parseFleetArgs(["digest", "--since", "0s"])).toBeUndefined();
  });

  // `--since` as the final token has no value to read — `rest[i + 1]` is `undefined` — and must
  // route to the same usage-error path as every other malformed flag on this command.
  test("rejects --since as the final token with no value", () => {
    expect(parseFleetArgs(["digest", "--since"])).toBeUndefined();
  });

  // Uses the file's existing `sinkSpy()` helper (fleet.test.ts:60) and the real
  // `runFleetCommand(client, cmd, sink)` signature — NOT a `deps` object, which does not exist.
  const digestResult = {
    windowMs: 86_400_000,
    generatedAt: 0,
    markdown: "# Fleet digest\n",
    jobs: [],
    notCompared: {
      firstObservation: [],
      notSummarizable: [],
      noBriefInWindow: [],
      agentChanged: [],
    },
  };

  test("calls fleet.digest with the parsed window and prints the markdown", async () => {
    let seen: unknown;
    const client: FleetIpc = {
      call: async (_m, params) => {
        seen = params;
        return digestResult;
      },
    };
    const { out, sink } = sinkSpy();
    const code = await runFleetCommand(
      client,
      { sub: "digest", windowMs: 86_400_000, json: false },
      sink,
    );
    expect(code).toBe(FLEET_EXIT_CODES.ok);
    expect(seen).toEqual({ windowMs: 86_400_000 });
    expect(out.join("")).toContain("# Fleet digest");
  });

  test("--json emits the structured result", async () => {
    const client: FleetIpc = { call: async () => digestResult };
    const { out, sink } = sinkSpy();
    const code = await runFleetCommand(client, { sub: "digest", windowMs: 1000, json: true }, sink);
    expect(code).toBe(FLEET_EXIT_CODES.ok);
    expect(JSON.parse(out.join(""))).toMatchObject({ windowMs: 86_400_000 });
  });

  test("an empty digest is NOT an error", async () => {
    // A quiet night and a broken fleet must not look the same to a script.
    const client: FleetIpc = {
      call: async () => ({ ...digestResult, markdown: "# Fleet digest\n\n## Not compared\n" }),
    };
    const { sink } = sinkSpy();
    const code = await runFleetCommand(
      client,
      { sub: "digest", windowMs: 1000, json: false },
      sink,
    );
    expect(code).toBe(FLEET_EXIT_CODES.ok);
  });
});
