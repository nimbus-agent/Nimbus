import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
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
  type TourStepResult,
  tourHeader,
  tourRule,
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

const RUN_TOUR_PATH = join(import.meta.dir, "run-tour.ts");
// lib -> src -> cli -> packages -> repo root.
const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..");
const ISTANBUL_REGISTER = join(REPO_ROOT, "scripts", "coverage", "istanbul-register.ts");

// True only when THIS process was itself launched with the istanbul preload (i.e. we are
// running under `audit:coverage-floor:build-lcov`, not an ordinary `bun test`) — checked so the
// coverage side-channel below (see `runInFreshProcess`) never spawns an extra, instrumented
// child, or touches the repo's `coverage/.nyc-tmp` directory, on a plain dev/CI test run.
const PARENT_COVERAGE_ACTIVE =
  (globalThis as { __coverage__?: unknown }).__coverage__ !== undefined;

/**
 * Runs `runTour` for one "why" step in a BRAND-NEW bun process, where `process.exitCode` is
 * genuinely `undefined` — the ambient every real `nimbus wow` invocation actually starts from,
 * and NOT reproducible in this shared test process: once any code anywhere in a process assigns
 * `process.exitCode` a real number, Bun's own setter silently ignores every later
 * undefined/null assignment for the rest of that process's life (verified: assigning `undefined`
 * after a real number leaves the old number in place). `runnerBody` is inlined verbatim as the
 * "why" runner's source.
 *
 * Only when `PARENT_COVERAGE_ACTIVE`, the child is ALSO instrumented with the same istanbul
 * preload `audit:coverage-floor:build-lcov` uses and, best-effort, drops its coverage shard into
 * the SAME `coverage/.nyc-tmp` directory that run's merge step reads — otherwise this file's only
 * branches reachable from a fresh ambient would be invisible to the coverage-floor gate purely
 * because they execute on the far side of a process boundary, never because they're untested. An
 * ordinary test run spawns a plain, uninstrumented child instead.
 */
async function runInFreshProcess(
  runnerBody: string,
): Promise<{ exitCode: number | null; results: TourStepResult[] }> {
  const shardDump = PARENT_COVERAGE_ACTIVE
    ? `
    try {
      const cov = globalThis.__coverage__;
      if (cov) {
        const fs = await import("node:fs");
        const path = await import("node:path");
        const dir = path.resolve(${JSON.stringify(REPO_ROOT)}, "coverage", ".nyc-tmp");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.resolve(dir, \`\${process.pid}-run-tour-fresh.json\`), JSON.stringify(cov));
      }
    } catch {
      // Best-effort only — must not fail this test over a coverage-plumbing hiccup.
    }`
    : "";
  const code = `
    const mod = await import(${JSON.stringify(RUN_TOUR_PATH)});
    const results = await mod.runTour(
      [{ kind: "why", title: "T", command: "c", args: [], reason: "r" }],
      { why: ${runnerBody} },
      () => {},
      () => {},
      1,
    );
    process.stdout.write(JSON.stringify({ exitCode: process.exitCode ?? null, results }));
    ${shardDump}
  `;
  const args = PARENT_COVERAGE_ACTIVE
    ? [process.execPath, "--preload", ISTANBUL_REGISTER, "-e", code]
    : [process.execPath, "-e", code];
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [out, errText, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`fresh-process child exited ${String(exitCode)}: ${out}\n${errText}`);
  }
  return JSON.parse(out) as { exitCode: number | null; results: TourStepResult[] };
}

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

  // These two run the real "why" runner (and every fallback it exercises) in a genuinely fresh
  // process — the ambient every real `nimbus wow` invocation actually starts from, and the one
  // case this shared test process can never reproduce on its own (see `runInFreshProcess`).
  describe("a fresh process, where process.exitCode was never set", () => {
    test("a runner that never touches exitCode leaves it undefined, and runTour restores 0", async () => {
      const { exitCode, results } = await runInFreshProcess("async () => {}");
      // (undefined ?? 0) === 0 is true, so the step is ok, and the `before ?? 0` restore in
      // `finally` turns the still-undefined ambient into the real number 0 — never `undefined`
      // itself, which is what makes 0 the one value that reliably lands at process exit.
      expect(exitCode).toBe(0);
      expect(results).toEqual([{ kind: "why", ok: true }]);
    });

    test("a runner that sets a non-zero code fails the step and still restores to 0", async () => {
      const { exitCode, results } = await runInFreshProcess(
        "async () => { process.exitCode = 5; }",
      );
      // (5 ?? 0) === 0 is false and (5 ?? 0) === (undefined ?? 0) is 5 === 0, also false, so the
      // step is ok:false; `before` (captured before the runner ran) was undefined, so the
      // `finally` restore is `undefined ?? 0` = 0, not the runner's leftover 5.
      expect(exitCode).toBe(0);
      expect(results).toEqual([{ kind: "why", ok: false }]);
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

  // M4: `runners["constructor"]` and `runners["toString"]` resolve to `Object.prototype`
  // members through the JS prototype chain — both pass a bare `typeof runner === "function"`
  // guard, get invoked, return without throwing, and were reported `ok: true`: a fabricated
  // success for a kind that was never a real tour step. `Object.hasOwn` (own-property only,
  // never the prototype chain) is what tells the two apart from a genuine registered runner.
  for (const bogusKind of ["constructor", "toString"]) {
    test(`kind: "${bogusKind}" is reported unknown, not fabricated as ok:true`, async () => {
      const errs: string[] = [];
      const badStep = {
        kind: bogusKind,
        title: `T-${bogusKind}`,
        command: `nimbus ${bogusKind}`,
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
        { kind: bogusKind as unknown as TourStepKind, ok: false },
        { kind: "why", ok: true },
      ]);
      expect(errs.join("")).toContain(`unknown tour step kind: ${bogusKind}`);
    });
  }

  test("header is byte-exact: leading blank line, padded rule, and the literal command line", () => {
    // Computed independently of `tourHeader` — the same visible shape `demo.ts`'s `header()`
    // produces, generalised with an explicit total — so this test cannot pass merely by echoing
    // the implementation back at itself.
    const expected = `\n${"── [2/4] Why ".padEnd(56, "─")}\n$ nimbus why a\n`;
    expect(tourHeader(2, 4, "Why", "nimbus why a")).toBe(expected);
  });

  // Added for `nimbus wow`'s panel header (fix round 1): the panel needs the same rule-line shape
  // as a step header, but with no `$ command` line beneath it. `tourRule` is the sibling
  // `tourHeader` itself uses for its first line, so the two cannot drift apart.
  test("tourRule renders the padded rule line alone — no leading blank line, no $ command", () => {
    const expected = "── [2/4] Why ".padEnd(56, "─");
    expect(tourRule(2, 4, "Why")).toBe(expected);
  });

  test("tourHeader's first line is exactly what tourRule produces, so the two cannot drift", () => {
    const header = tourHeader(3, 5, "Standup", "nimbus standup");
    const rule = tourRule(3, 5, "Standup");
    expect(header).toBe(`\n${rule}\n$ nimbus standup\n`);
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
