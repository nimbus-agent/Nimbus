import { describe, expect, test } from "bun:test";
import { CliExit } from "../lib/cli-exit.ts";
import type { LocalityReport } from "../lib/locality-panel.ts";
import type { TourRunners, TourStep, TourStepKind } from "../lib/run-tour.ts";
import { GatewayNotRunningError } from "../lib/with-gateway-ipc.ts";
import type { ProveResult } from "./prove.ts";
import { COMMAND_NAMES, type CommandName } from "./registry.ts";
import { PANEL_COMMANDS, parseWowArgs, runWow, type TourPlan, type WowDeps } from "./wow.ts";

const KIND_CYCLE: readonly TourStepKind[] = [
  "why",
  "owners",
  "oncall",
  "standup",
  "decisions",
  "glossary",
];

function planWith(n: number, overrides: Partial<TourPlan> = {}): TourPlan {
  const steps: TourStep[] = Array.from({ length: n }, (_, i) => {
    const kind = KIND_CYCLE[i % KIND_CYCLE.length] as TourStepKind;
    return { kind, title: `T-${kind}`, command: `nimbus ${kind}`, args: [], reason: "r" };
  });
  return { steps, more: [], skipped: [], t0: 0, ...overrides };
}

function locWith(overrides: Partial<LocalityReport> = {}): LocalityReport {
  return {
    listeners: [{ name: "ipc", address: "npipe:...", loopback: true }],
    inventory: [{ service: "github", items: 10 }],
    db: { path: "/tmp/nimbus/nimbus.db", bytes: 1024 },
    t1: 0,
    ...overrides,
  };
}

/** Copied from the COVERED fixture in `prove-format.test.ts` — see that file's module doc for why
 *  this is the real, hand-maintained mirror of the gateway's coverage vector. */
function cleanProof(): ProveResult {
  return {
    rows: [],
    completeness: {
      coverage: {
        browser: "none",
        chatops: "none",
        mcp: "none",
        http: "none",
        task: "none",
        session: "none",
        sync: "none",
        model: "none",
        peer: "none",
      },
      outboundEgressEvents: 0,
      indeterminate: false,
    },
    verify: { ok: true, verifiedRows: 0 },
  };
}

function countingRunners(fn: () => void): TourRunners {
  const runner = async (): Promise<void> => {
    fn();
  };
  return {
    why: runner,
    owners: runner,
    oncall: runner,
    standup: runner,
    decisions: runner,
    glossary: runner,
  };
}

function deps(overrides: Partial<WowDeps> = {}): WowDeps {
  return {
    plan: async () => planWith(1),
    locality: async () => locWith({}),
    prove: async () => cleanProof(),
    runners: countingRunners(() => {}),
    out: () => {},
    err: () => {},
    ...overrides,
  };
}

describe("parseWowArgs", () => {
  for (const bad of ["0", "7", "x", "1.5"]) {
    test(`--steps ${bad} is refused`, () => {
      expect(() => parseWowArgs(["--steps", bad])).toThrow();
    });
  }

  test("--steps with no value is refused", () => {
    expect(() => parseWowArgs(["--steps"])).toThrow();
  });

  test("a valid --steps value is accepted", () => {
    expect(parseWowArgs(["--steps", "4"])).toEqual({ steps: 4, json: false, noProof: false });
  });

  test("defaults to steps=3, json=false, noProof=false", () => {
    expect(parseWowArgs([])).toEqual({ steps: 3, json: false, noProof: false });
  });

  test("--json sets json true", () => {
    expect(parseWowArgs(["--json"]).json).toBe(true);
  });

  test("--no-proof sets noProof true", () => {
    expect(parseWowArgs(["--no-proof"]).noProof).toBe(true);
  });

  test("an unknown flag is refused, not ignored", () => {
    expect(() => parseWowArgs(["--bogus"])).toThrow();
  });
});

describe("runWow", () => {
  test("the proof window is exactly the gateway's t0..t1", async () => {
    const calls: Array<[number, number]> = [];
    await runWow(
      [],
      deps({
        plan: async () => planWith(1, { t0: 1000 }),
        locality: async () => locWith({ t1: 2000 }),
        prove: async (s, u) => {
          calls.push([s, u]);
          return cleanProof();
        },
      }),
    );
    expect(calls).toEqual([[1000, 2000]]);
  });

  test("--json runs no step and makes no prove call", async () => {
    let ran = 0;
    let proved = 0;
    const out: string[] = [];
    await runWow(
      ["--json"],
      deps({
        runners: countingRunners(() => {
          ran++;
        }),
        prove: async () => {
          proved++;
          return cleanProof();
        },
        out: (s) => out.push(s),
      }),
    );
    expect(ran).toBe(0);
    expect(proved).toBe(0);
    expect(Object.keys(JSON.parse(out.join(""))).sort()).toEqual(["locality", "plan"]);
  });

  test("empty plan → pointer to init, no panel, resolves", async () => {
    let localityCalls = 0;
    const out: string[] = [];
    await runWow(
      [],
      deps({
        plan: async () => planWith(0),
        out: (s) => out.push(s),
        locality: async () => {
          localityCalls++;
          return locWith({});
        },
      }),
    );
    expect(out.join("")).toContain("nimbus init");
    expect(localityCalls).toBe(0);
  });

  test("a failed step still prints the panel, then rejects with CliExit(1)", async () => {
    const out: string[] = [];
    const run = runWow(
      [],
      deps({
        plan: async () => planWith(1),
        out: (s) => out.push(s),
        runners: countingRunners(() => {
          throw new CliExit(2);
        }),
      }),
    );
    await expect(run).rejects.toMatchObject({ name: "CliExit", code: 1 });
    expect(out.join("")).toContain("Outbound activity during this tour (gateway-wide)");
  });

  test("a broken chain prints no count", async () => {
    const out: string[] = [];
    await runWow(
      [],
      deps({
        plan: async () => planWith(1),
        out: (s) => out.push(s),
        prove: async () => ({ ...cleanProof(), verify: { ...cleanProof().verify, ok: false } }),
      }),
    );
    const text = out.join("");
    expect(text).toContain("indeterminate — cannot prove zero egress");
    expect(text).not.toContain("in the covered classes:"); // the count line is never printed
  });

  test("every command the panel names is a registered CLI command", () => {
    for (const c of PANEL_COMMANDS) {
      expect(COMMAND_NAMES).toContain(c.split(" ")[1] as CommandName); // NOSONAR S4325: raw string from a split; toContain expects CommandName
    }
  });

  test("--steps out of range refuses with a usage message and CliExit(2)", async () => {
    const err: string[] = [];
    const run = runWow(["--steps", "9"], deps({ err: (s) => err.push(s) }));
    await expect(run).rejects.toMatchObject({ name: "CliExit", code: 2 });
    expect(err.join("")).toContain("Usage: nimbus wow");
  });

  test("an unknown flag refuses with CliExit(2), not a silent no-op", async () => {
    const run = runWow(["--nope"], deps());
    await expect(run).rejects.toMatchObject({ name: "CliExit", code: 2 });
  });

  test("a successful tour with proof shown does not throw", async () => {
    await expect(runWow([], deps({ plan: async () => planWith(2) }))).resolves.toBeUndefined();
  });

  test("the panel counts as step N+1 unless --no-proof", async () => {
    const out: string[] = [];
    await runWow([], deps({ plan: async () => planWith(1), out: (s) => out.push(s) }));
    expect(out.join("")).toContain("[1/2]");
  });

  test("--no-proof drops the panel and the step total excludes it", async () => {
    const out: string[] = [];
    await runWow(["--no-proof"], deps({ plan: async () => planWith(1), out: (s) => out.push(s) }));
    const text = out.join("");
    expect(text).toContain("[1/1]");
    expect(text).not.toContain("Listeners (open right now):");
  });

  test("skipped steps print as 'Not shown: <kind> (<reason>)'", async () => {
    const out: string[] = [];
    await runWow(
      [],
      deps({
        plan: async () =>
          planWith(1, { skipped: [{ kind: "oncall", reason: "no active incident" }] }),
        out: (s) => out.push(s),
      }),
    );
    expect(out.join("")).toContain("Not shown: oncall (no active incident)");
  });

  test("no skipped steps prints no 'Not shown' line", async () => {
    const out: string[] = [];
    await runWow(
      [],
      deps({ plan: async () => planWith(1, { skipped: [] }), out: (s) => out.push(s) }),
    );
    expect(out.join("")).not.toContain("Not shown:");
  });

  test("more steps render under 'Also try:' with each command", async () => {
    const out: string[] = [];
    await runWow(
      [],
      deps({
        plan: async () =>
          planWith(1, {
            more: [
              {
                kind: "impact_dummy" as unknown as TourStepKind,
                title: "Impact",
                command: "nimbus impact x",
                args: [],
                reason: "r",
              },
            ],
          }),
        out: (s) => out.push(s),
      }),
    );
    const text = out.join("");
    expect(text).toContain("Also try:");
    expect(text).toContain("nimbus impact x");
  });

  // `runWow` adds no gateway-not-running handling of its own — the production `plan`/`locality`/
  // `prove` deps (`defaultWowDeps`) are each a `withGatewayIpc` call, which already throws
  // `GatewayNotRunningError` with a friendly message. This pins that `runWow` does not swallow or
  // re-wrap it: it propagates untouched, for `index.ts`'s top-level catch to print.
  test("a gateway-not-running failure from the first IPC call propagates untouched", async () => {
    const run = runWow(
      [],
      deps({
        plan: async () => {
          throw new GatewayNotRunningError();
        },
      }),
    );
    await expect(run).rejects.toBeInstanceOf(GatewayNotRunningError);
  });

  test("no more steps prints no 'Also try:' section", async () => {
    const out: string[] = [];
    await runWow(
      [],
      deps({ plan: async () => planWith(1, { more: [] }), out: (s) => out.push(s) }),
    );
    expect(out.join("")).not.toContain("Also try:");
  });
});
