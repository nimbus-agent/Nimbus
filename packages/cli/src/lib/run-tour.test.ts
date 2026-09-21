import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runDecisionsCommand } from "../commands/decisions.ts";
import { runGlossaryCommand } from "../commands/glossary.ts";
import { runOncallCommand } from "../commands/oncall.ts";
import { runOwnersCommand } from "../commands/owners.ts";
import { runStandupCommand } from "../commands/standup.ts";
import { runWhyCli } from "../commands/why.ts";
import { CliExit } from "./cli-exit.ts";
import {
  defaultTourRunners,
  runTour,
  type TourRunners,
  type TourStep,
  type TourStepKind,
  tourHeader,
} from "./run-tour.ts";

const step = (kind: TourStepKind): TourStep => ({
  kind,
  title: `T-${kind}`,
  command: `nimbus ${kind}`,
  args: ["x"],
  reason: "r",
});

const noop = async (): Promise<void> => {};

const runners = (over: Partial<TourRunners>): TourRunners => ({
  why: noop,
  owners: noop,
  oncall: noop,
  standup: noop,
  decisions: noop,
  glossary: noop,
  ...over,
});

describe("runTour", () => {
  // Every test in this file may write the REAL `process.exitCode` (no isolation — see
  // run-tour.ts's own restore-note). Capture/restore with the same `?? 0` idiom `runTour` itself
  // uses, so a bug in one test's assertions cannot leak a stray exit code into a sibling test in
  // this file or into another file sharing the same `bun test` process.
  let priorExitCode: typeof process.exitCode;
  beforeEach(() => {
    priorExitCode = process.exitCode;
  });
  afterEach(() => {
    process.exitCode = priorExitCode ?? 0;
  });

  test("a CliExit from one step does not stop the next", async () => {
    const ran: string[] = [];
    const errs: string[] = [];
    const res = await runTour(
      [step("oncall"), step("why")],
      runners({
        oncall: async () => {
          throw new CliExit(2);
        },
        why: async (a) => {
          ran.push(a.join(","));
        },
      }),
      () => {},
      (s) => errs.push(s),
      3,
    );
    expect(res).toEqual([
      { kind: "oncall", ok: false },
      { kind: "why", ok: true },
    ]);
    expect(ran).toEqual(["x"]);
    expect(errs).toEqual([]); // CliExit: the site already printed
  });

  test("an ordinary Error is printed under its header, and the tour continues", async () => {
    const errs: string[] = [];
    const res = await runTour(
      [step("why")],
      runners({
        why: async () => {
          throw new Error("boom");
        },
      }),
      () => {},
      (s) => errs.push(s),
      1,
    );
    expect(res[0]?.ok).toBe(false);
    expect(errs.join("")).toContain("boom");
  });

  test("a runner that throws a non-Error value is ok:false and the raw value reaches err", async () => {
    const errs: string[] = [];
    const res = await runTour(
      [step("why")],
      runners({
        why: () => {
          throw "raw-string-failure";
        },
      }),
      () => {},
      (s) => errs.push(s),
      1,
    );
    expect(res[0]?.ok).toBe(false);
    expect(errs.join("")).toContain("raw-string-failure");
  });

  // Ambient-independent: each case sets a KNOWN ambient value before calling runTour, rather than
  // trusting whatever `process.exitCode` happens to be when this file runs (which CI's combined
  // `bun test packages/gateway packages/cli scripts` run makes an unreliable `undefined` — sibling
  // CLI tests routinely leave it at the NUMBER 0, where even a naive restore already "works" and
  // this test would stop discriminating anything).
  describe("process.exitCode does not leak past its own step", () => {
    test("ambient 0: a runner that sets a non-zero code is restored to 0 afterwards", async () => {
      process.exitCode = 0;
      const res = await runTour(
        [step("why")],
        runners({
          why: async () => {
            process.exitCode = 2;
          },
        }),
        () => {},
        () => {},
        1,
      );
      expect(process.exitCode ?? 0).toBe(0);
      expect(res[0]?.ok).toBe(false);
    });

    test("ambient 3: a runner that sets a non-zero code is restored to the prior ambient code", async () => {
      process.exitCode = 3;
      const res = await runTour(
        [step("why")],
        runners({
          why: async () => {
            process.exitCode = 2;
          },
        }),
        () => {},
        () => {},
        1,
      );
      expect(process.exitCode).toBe(3);
      expect(res[0]?.ok).toBe(false);
    });
  });

  test("a runner that explicitly sets exit code 0 without throwing is ok:true", async () => {
    const res = await runTour(
      [step("why")],
      runners({
        why: async () => {
          process.exitCode = 0;
        },
      }),
      () => {},
      () => {},
      1,
    );
    expect(res[0]?.ok).toBe(true);
  });

  test("an out-of-union step.kind is reported to err and the tour continues, never throwing", async () => {
    const errs: string[] = [];
    // The plan arrives from the gateway over IPC — `TourStepKind` is a compile-time claim about
    // it, not a runtime guarantee. Cast through `unknown` to build a step no real caller could
    // construct without going through IPC first.
    const badStep = {
      kind: "bogus",
      title: "T-bogus",
      command: "nimbus bogus",
      args: ["x"],
      reason: "r",
    } as unknown as TourStep;
    const res = await runTour(
      [badStep, step("why")],
      runners({}),
      () => {},
      (s) => errs.push(s),
      2,
    );
    expect(res).toEqual([
      { kind: "bogus" as unknown as TourStepKind, ok: false },
      { kind: "why", ok: true },
    ]);
    expect(errs.join("")).toContain("unknown tour step kind: bogus");
  });

  test("header is byte-exact: leading blank line, padded rule, and the literal command line", () => {
    // Computed independently of `tourHeader` — the same visible shape `demo.ts`'s `header()`
    // produces, generalised with an explicit total — so this test cannot pass merely by echoing
    // the implementation back at itself.
    const expected = `\n${"── [2/4] Why ".padEnd(56, "─")}\n$ nimbus why a\n`;
    expect(tourHeader(2, 4, "Why", "nimbus why a")).toBe(expected);
  });

  test("defaultTourRunners binds every kind to the real command it names", () => {
    // A transposed mapping (e.g. `owners` wired to `runOncallCommand`) passes every other test in
    // this file and every typecheck — this is the only thing that would catch it.
    expect(defaultTourRunners.why).toBe(runWhyCli);
    expect(defaultTourRunners.owners).toBe(runOwnersCommand);
    expect(defaultTourRunners.oncall).toBe(runOncallCommand);
    expect(defaultTourRunners.standup).toBe(runStandupCommand);
    expect(defaultTourRunners.decisions).toBe(runDecisionsCommand);
    expect(defaultTourRunners.glossary).toBe(runGlossaryCommand);
  });
});
