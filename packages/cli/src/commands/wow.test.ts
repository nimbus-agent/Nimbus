import { describe, expect, test } from "bun:test";
import { CliExit } from "../lib/cli-exit.ts";
import type { LocalityReport } from "../lib/locality-panel.ts";
import type { TourRunners, TourStep, TourStepKind } from "../lib/run-tour.ts";
import { GatewayNotRunningError } from "../lib/with-gateway-ipc.ts";
import type { ProveResult } from "./prove.ts";
import { parseWowArgs, runWow, type TourPlan, type WowDeps } from "./wow.ts";

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

/**
 * A clean, all-`none` coverage vector — deliberately NOT the shared `COVERED` fixture from
 * `prove-format.test.ts` (which has `chatops`/`mcp`/`http`/`task` at `"per-call"`) and not a mirror
 * of the gateway's real class list (both this fixture and `COVERED` are missing `tool`). No
 * assertion in this file depends on the vector's content — only on `verify.ok` and
 * `outboundEgressEvents` — so an all-`none` vector assignable to `ProveCompleteness` is all this
 * fixture needs to be.
 */
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

  // Duplicate of `locality-panel.test.ts`'s test of the same name removed — kept beside
  // `PANEL_COMMANDS`' definition there, since that is where the list lives.

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

  // M11: nothing previously pinned that the parsed `--steps` VALUE actually reaches
  // `deps.plan(N)` — only that an out-of-range value refused. `planWith(0)` keeps each call on
  // the "Nothing indexed yet" early-return path, so no locality/prove call is made either.
  test("--steps N reaches deps.plan(N); with no flag it defaults to 3", async () => {
    const seen: number[] = [];
    const fakePlan = async (steps: number): Promise<TourPlan> => {
      seen.push(steps);
      return planWith(0);
    };
    await runWow(["--steps", "5"], deps({ plan: fakePlan }));
    await runWow([], deps({ plan: fakePlan }));
    expect(seen).toEqual([5, 3]);
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
    expect(text).not.toContain("Listeners the gateway has open right now:");
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

  // Fix round 1, Important finding: nothing pinned that `locality()` runs AFTER the steps and
  // `prove()` after `locality()` resolves. A plausible "fail fast on a dead gateway" refactor
  // hoisting `const locality = await deps.locality()` above `runTour` kept every prior test green
  // (fixed t0/t1 fixtures, text-presence-only panel assertions, nothing recording call order) —
  // exactly the regression this task exists to prevent, since `until` would then predate the tour.
  test("locality runs after every tour step, and prove runs after locality resolves (call order is pinned)", async () => {
    const seq: string[] = [];
    await runWow(
      [],
      deps({
        plan: async () => planWith(2),
        runners: countingRunners(() => {
          seq.push("step");
        }),
        locality: async () => {
          seq.push("locality");
          return locWith({});
        },
        prove: async () => {
          seq.push("prove");
          return cleanProof();
        },
      }),
    );
    expect(seq).toEqual(["step", "step", "locality", "prove"]);
  });

  // RULING (fix round 1): the panel prints its own rule-line header, immediately before
  // "Listeners the gateway has open right now:" — the same shape `tourHeader` renders for its
  // first line, minus the blank-line lead and the `$ command` line, with no change to
  // `tourHeader` itself. (I1: the heading was scoped from the unqualified "Listeners (open right
  // now):" — a gateway-spawned CHILD PROCESS, such as Chromium's CDP debugging port during a
  // `nimbus computer` browser session, can hold a real listening socket this panel never sees.)
  test("the panel prints its own rule-line header immediately before 'Listeners', ending the step sequence at N/N", async () => {
    const out: string[] = [];
    await runWow([], deps({ plan: async () => planWith(1), out: (s) => out.push(s) }));
    const text = out.join("");
    // Computed independently of `tourRule`/`tourHeader` — the same shape convention
    // `run-tour.test.ts`'s own header test uses — so this cannot pass merely by echoing the
    // implementation back at itself.
    const expectedRuleLine = "── [2/2] Where your data is ".padEnd(56, "─");
    expect(text).toContain(`\n${expectedRuleLine}\nListeners the gateway has open right now:`);
  });

  test("--no-proof prints no panel header (there is no panel at all)", async () => {
    const out: string[] = [];
    await runWow(["--no-proof"], deps({ plan: async () => planWith(1), out: (s) => out.push(s) }));
    expect(out.join("")).not.toContain("Where your data is");
  });

  // RULING (fix round 1): a FAILED `prove` call must not discard the already-obtained locality
  // report — the panel (header, listeners, inventory, the outbound-activity heading, Next:) still
  // prints, with a distinct "proof unavailable" fact under the heading rather than routed through
  // `formatProveResult` (a different fact from "the chain is unverifiable": the call itself failed).
  test("a failed prove call still prints the full panel with a proof-unavailable line, then rejects CliExit(1)", async () => {
    const out: string[] = [];
    const run = runWow(
      [],
      deps({
        plan: async () => planWith(1),
        out: (s) => out.push(s),
        prove: async () => {
          throw new Error("boom");
        },
      }),
    );
    await expect(run).rejects.toMatchObject({ name: "CliExit", code: 1 });
    const text = out.join("");
    expect(text).toContain("Listeners the gateway has open right now:");
    expect(text).toContain("10 items across 1 service"); // the default locWith() inventory line
    expect(text).toContain("Outbound activity during this tour (gateway-wide):");
    expect(text).toContain("proof unavailable — the egress.proveWindow call failed: boom");
    expect(text).not.toContain("in the covered classes:"); // never routed through formatProveResult
    expect(text).toContain("Next:"); // the rest of the panel still renders
  });

  test("a non-Error prove rejection is stringified in the proof-unavailable line", async () => {
    const out: string[] = [];
    const run = runWow(
      [],
      deps({
        plan: async () => planWith(1),
        out: (s) => out.push(s),
        // A deliberate non-Error rejection, mirroring a badly-behaved IPC transport.
        prove: async () => {
          throw "raw-failure";
        },
      }),
    );
    await expect(run).rejects.toMatchObject({ name: "CliExit", code: 1 });
    expect(out.join("")).toContain(
      "proof unavailable — the egress.proveWindow call failed: raw-failure",
    );
  });

  test("a failed prove call still forces CliExit(1) even when every step succeeded", async () => {
    const run = runWow(
      [],
      deps({
        plan: async () => planWith(1),
        prove: async () => {
          throw new Error("boom");
        },
      }),
    );
    await expect(run).rejects.toMatchObject({ name: "CliExit", code: 1 });
  });

  test("a failed locality call still propagates unchanged (there is nothing to print)", async () => {
    const run = runWow(
      [],
      deps({
        plan: async () => planWith(1),
        locality: async () => {
          throw new Error("locality down");
        },
      }),
    );
    await expect(run).rejects.toThrow("locality down");
  });

  // Elevated fix: `--help`/`-h` today reached `parseWowArgs`'s unknown-flag refusal (CliExit(2)),
  // while `help.ts` tells users "Add --help after a command for its own flags". Both spellings must
  // print usage to stdout and resolve, making no IPC call at all.
  test("--help prints usage on stdout, makes no IPC call, and resolves", async () => {
    let planCalled = false;
    const out: string[] = [];
    await runWow(
      ["--help"],
      deps({
        plan: async () => {
          planCalled = true;
          return planWith(1);
        },
        out: (s) => out.push(s),
      }),
    );
    expect(planCalled).toBe(false);
    expect(out.join("")).toContain("Usage: nimbus wow");
  });

  test("-h prints usage on stdout, makes no IPC call, and resolves", async () => {
    let planCalled = false;
    const out: string[] = [];
    await runWow(
      ["-h"],
      deps({
        plan: async () => {
          planCalled = true;
          return planWith(1);
        },
        out: (s) => out.push(s),
      }),
    );
    expect(planCalled).toBe(false);
    expect(out.join("")).toContain("Usage: nimbus wow");
  });
});
