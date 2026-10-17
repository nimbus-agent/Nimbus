import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { load as loadYaml } from "js-yaml";

import { unitTestCommand } from "../lib/ci-tests.ts";
import { REPO_ROOT } from "../structure-audit/lib.ts";

/**
 * The PR cross-platform legs and the macOS/Windows push leg must run the SAME `bun test`
 * package list — and so must the two local entry points, `bun run test` and `test:ci`.
 *
 * They did not, from whenever `pr-quality-cross-platform` was introduced until 2026-08-23. The
 * PR leg ran `bun test packages/<pkg>/src`; the push leg ran
 * `bun test packages/gateway packages/cli scripts` in one process. The
 * difference was not academic — over the 200 CI runs on `main` between 2026-08-02 and
 * 2026-08-22, 50 failed, 35 had a failing macOS job, and 33 of those 35 were in files the PR
 * gate never loaded at all (`scripts/`, `test/integration/`, `test/e2e/`). Every one of them was
 * discovered after merge, because there was no earlier place they COULD be discovered.
 *
 * A comment saying "keep these in sync" is not a mechanism; the two commands sit in different
 * files, ~500 lines apart, and each has its own dense rationale block that reads complete on its
 * own. This is the mechanism.
 *
 * Deliberately narrow: it compares the POSITIONAL path arguments only. Flags legitimately
 * differ — the PR legs shard (`--shard`) and read the per-file timings, the push leg writes them
 * (`--update-timings`). What must not drift is WHICH TESTS RUN, in which process shape.
 *
 * Both run through `scripts/ci/test-with-retry.ts`, which owns the reporter flags and the retry;
 * the `bun test …` after its `--` is the command compared here.
 */

const CI_YML = join(REPO_ROOT, ".github", "workflows", "ci.yml");
const TEST_SUITE_YML = join(REPO_ROOT, ".github", "workflows", "_test-suite.yml");

/**
 * Positional (non-flag) arguments of a `bun test …` invocation on a workflow `run:` line.
 *
 * Stops at the first token that starts with `-` or a redirect, which is where the paths end in
 * both workflow invocations. It cannot read on: their flags take separate values (`--timeout
 * 60000`, `--preload <file>`), which would count as paths. Returns `undefined` when the line has no
 * `bun test` at all.
 */
function bunTestPaths(line: string): readonly string[] | undefined {
  const marker = /(?:^|\s)bun test\s/.exec(line);
  if (marker === null) {
    return undefined;
  }
  const rest = line.slice(marker.index + marker[0].length).trim();
  const paths: string[] = [];
  for (const token of rest.split(/\s+/)) {
    if (token.startsWith("-") || token.startsWith(">") || token.startsWith("2>")) {
      break;
    }
    paths.push(token.replace(/^["']|["']$/g, ""));
  }
  return paths;
}

/**
 * Every non-flag argument of a command that starts with `bun test` and that this repository writes
 * in full: the `test` script and the command `test:ci`'s unit run spawns.
 *
 * Unlike `bunTestPaths`, it does not stop at the first flag. Bun takes a positional after a flag as
 * a path filter too (measured on bun 1.3.14: `bun test alpha --coverage beta` runs both
 * directories), so stopping there would miss a path added after one. Neither command has a flag
 * that takes a separate value; one that did would show up here as a path and fail the check, so
 * write such a flag as `--flag=value`. Returns `undefined` unless the command starts with
 * `bun test`.
 */
function everyBunTestPath(argv: readonly string[]): readonly string[] | undefined {
  if (argv[0] !== "bun" || argv[1] !== "test") {
    return undefined;
  }
  return argv.slice(2).filter((arg) => !arg.startsWith("-"));
}

/** Every line of `file` matching `predicate`, as a list — so "exactly one" is assertable. */
function matchingLines(file: string, predicate: (line: string) => boolean): readonly string[] {
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((l) => predicate(l));
}

// The push leg's command, identified by the JUnit outfile, which names the unit shard and appears
// exactly once. Module scope because both describes below compare against it.
const pushLines = matchingLines(
  TEST_SUITE_YML,
  (l) => l.includes(" bun test ") && l.includes("junit-reports/junit-unit.xml"),
);

/**
 * The PR legs' command line in ci.yml: the retry script handing it a `bun test` to run. Keyed on
 * the script, which is unique to this step — keying on the step NAME would break the moment the
 * step is renamed, and keying on `packages/…` would match any future `bun test` added to the
 * file. It deliberately ignores the script's own options (the cap SECONDS among them): a routine
 * cap change once failed this test for a reason unrelated to parity, back when the predicate
 * hard-coded `900`. The length assertion below catches a predicate relaxed until it matches
 * nothing.
 */
const isPrLine = (l: string): boolean => /test-with-retry\.ts .* -- bun test /.test(l);

describe("PR cross-platform legs run the same tests as the push matrix", () => {
  const prLines = matchingLines(CI_YML, isPrLine);

  test("each command is found exactly once", () => {
    // A zero match would make the parity assertion below vacuously true — the classic shape of
    // a gate that cannot fail. Assert presence before asserting equality.
    expect(prLines).toHaveLength(1);
    expect(pushLines).toHaveLength(1);
  });

  test("the two invocations name the same test paths", () => {
    const pr = bunTestPaths(prLines[0] ?? "");
    const push = bunTestPaths(pushLines[0] ?? "");
    expect(pr).toBeDefined();
    expect(push).toBeDefined();
    expect(pr).toEqual(push as readonly string[]);
  });

  test("the shared path list is whole-repo, not scoped to src", () => {
    // The specific regression this file exists to prevent: a `/src` suffix silently drops every
    // `test/integration/`, `test/e2e/` and `test/unit/` file from the run, and — because
    // `mock.module` is process-global — changes which mocks are registered for the files that
    // DO run. Both halves of that mattered; see #1311.
    // Asserted on BOTH lists, not just one plus the equality above. Equality alone would let a
    // change that scoped both legs identically pass two of these three tests; and checking only
    // the push side would leave the PR side resting on equality. Each list stands on its own.
    for (const paths of [
      bunTestPaths(prLines[0] ?? "") ?? [],
      bunTestPaths(pushLines[0] ?? "") ?? [],
    ]) {
      expect(paths).toContain("packages/gateway");
      expect(paths).toContain("packages/cli");
      expect(paths).toContain("scripts");
      // `packages/mcp-connectors` was in this list until the connectors were extracted to their
      // own repository. It is asserted ABSENT rather than simply dropped because nothing else
      // would ever flag it: `bun test` exits 0 when one of its paths matches no test file as long
      // as another matches something (measured on bun 1.3.14), so a dead path is silently
      // ignored, and the equality check above cannot catch it either — both lists would agree,
      // and both would be wrong. This comment used to claim the dead path fails `bun test`; it
      // does not, which is how the two local entry points tested below kept it for five weeks.
      expect(paths).not.toContain("packages/mcp-connectors");
      for (const p of paths) {
        expect(p.endsWith("/src")).toBe(false);
      }
    }
  });

  test("both legs run with --parallel, or neither does", () => {
    // `--parallel` is not just a speed flag: it implies `--isolate`, so it decides whether a
    // `mock.module` in one file can leak into another. That is the process SHAPE the paths check
    // above cannot see, and the one #1307 was red on. One leg isolated and the other not would
    // pass every path assertion and still not run the same thing.
    const hasParallel = (line: string): boolean => /\s--parallel(?:=\d+)?(?:\s|$)/.test(line);
    expect(hasParallel(prLines[0] ?? "")).toBe(hasParallel(pushLines[0] ?? ""));
    // Positive, not just equal: equality alone would also pass if both dropped it.
    expect(hasParallel(prLines[0] ?? "")).toBe(true);
  });

  test("the push leg runs uninstrumented, through the same retry script", () => {
    // The per-file timings the push leg records (`--update-timings`) are what the Windows PR
    // shards split by. Istanbul inflated CPU-bound unit files ~3x and disk-bound ones not at all,
    // which put ~78% of the real work in shard 2/2 (run 38949021174) — so a coverage preload here
    // is a sharding defect, not a speed preference. Nothing reads macOS/Windows coverage anyway.
    const push = pushLines[0] ?? "";
    expect(push).not.toContain("istanbul-register");
    expect(push).not.toContain("report-coverage");
    expect(push).toContain("--update-timings");
    expect(push).toMatch(/test-with-retry\.ts .* -- bun test /);
  });
});

describe("the PR legs' shards add up to the whole suite", () => {
  // The Windows leg runs as `--shard=1/2` and `--shard=2/2` jobs. A shard set with a gap — `1/2`
  // with no `2/2`, or `1/3` and `2/3` with no `3/3` — still passes every path assertion above,
  // because each job's COMMAND names the whole repo; the files it drops are dropped silently by
  // `--shard`. Parity with the push leg holds only over the union of the shards, so that union is
  // what this checks.
  const prLine = matchingLines(CI_YML, isPrLine)[0] ?? "";

  type Leg = { readonly os?: unknown; readonly shard?: unknown };
  type Step = {
    readonly name?: unknown;
    readonly uses?: unknown;
    readonly if?: unknown;
    readonly "continue-on-error"?: unknown;
    readonly with?: Record<string, unknown>;
  };
  const workflow = loadYaml(readFileSync(CI_YML, "utf8")) as {
    jobs?: Record<
      string,
      { strategy?: { matrix?: { include?: readonly Leg[] } }; steps?: readonly Step[] }
    >;
  };
  const crossPlatform = workflow.jobs?.["pr-quality-cross-platform"];
  const legs = crossPlatform?.strategy?.matrix?.include ?? [];
  const steps = crossPlatform?.steps ?? [];

  test("the command shards by the matrix value, after the paths", () => {
    // After the paths: `bunTestPaths` ends the path list at the first flag, so a `--shard` placed
    // before them would hide paths from the parity check above. `=` form keeps the value from
    // reading as a path to `everyBunTestPath`-style parsers.
    expect(prLine).toMatch(/--shard=\$\{\{ matrix\.shard \}\}/);
    expect(prLine.indexOf("--shard=")).toBeGreaterThan(prLine.indexOf(" scripts "));
  });

  test("every OS's shards are exactly 1/N … N/N", () => {
    expect(legs.length).toBeGreaterThan(0);
    const byOs = new Map<string, string[]>();
    for (const leg of legs) {
      expect(typeof leg.os).toBe("string");
      expect(typeof leg.shard).toBe("string");
      const list = byOs.get(String(leg.os)) ?? [];
      list.push(String(leg.shard));
      byOs.set(String(leg.os), list);
    }
    for (const [os, shards] of byOs) {
      const totals = new Set(shards.map((s) => s.split("/")[1]));
      expect({ os, totals: [...totals] }).toEqual({ os, totals: [String(shards.length)] });
      const expected = shards.map((_, i) => `${i + 1}/${shards.length}`);
      expect({ os, shards: [...shards].sort() }).toEqual({ os, shards: expected.sort() });
    }
  });

  test("the Windows shards read one shared timings snapshot, never their own restore", () => {
    // `--shard=k/N` partitions by the timings it reads. If each shard restored "the newest" entry
    // itself, a push to `main` landing between the two restores would hand them different tables,
    // and their partitions need not cover the suite. So no step in this job may restore Windows
    // timings from the cache; they arrive as the one artifact `filter` uploaded.
    const restoresWindowsTimings = steps.filter((st) => {
      if (typeof st.uses !== "string" || !st.uses.startsWith("actions/cache")) return false;
      return JSON.stringify(st.with ?? {}).includes("test-timings-Windows");
    });
    expect(restoresWindowsTimings).toEqual([]);

    const fetch = steps.filter(
      (st) => typeof st.uses === "string" && st.uses.startsWith("actions/download-artifact"),
    );
    expect(fetch).toHaveLength(1);
    expect(fetch[0]?.with?.["name"]).toBe("test-timings-snapshot-windows");
    // Fail, never continue: a shard that silently ran without the snapshot its sibling used would
    // split the suite differently — the gap this exists to close.
    expect(fetch[0]?.["continue-on-error"]).toBeUndefined();
  });

  test("both OSes the PR gate promises are present", () => {
    const oses = new Set(legs.map((l) => String(l.os)));
    expect(oses.has("macos-15")).toBe(true);
    expect(oses.has("windows-2025")).toBe(true);
  });
});

describe("the local entry points run the same tests as the push matrix", () => {
  // `bun run test` and `test:ci` are what a contributor runs locally, and the full `preflight`
  // tier runs the second. Neither was held to the CI list, and when #1347 deleted
  // `packages/mcp-connectors` and dropped it from the two CI commands above, both kept it — five
  // weeks, unnoticed, because `bun test` does not report a path that matches nothing (see the
  // comment above). Equality with the push leg is the check; a drift in either direction — a
  // dead path kept, or a real one missing — fails it.
  const push = bunTestPaths(pushLines[0] ?? "");

  test("`bun run test` names exactly the push leg's test paths", () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const script = pkg.scripts["test"];
    expect(script).toBeDefined();
    const paths = everyBunTestPath((script ?? "").trim().split(/\s+/));
    expect(paths).toBeDefined();
    expect(push).toBeDefined();
    expect(paths).toEqual(push as readonly string[]);
  });

  test("`test:ci`'s whole-repo unit run spawns exactly the push leg's test paths", () => {
    // Read from the command the run spawns, not from a list beside it: a path added to the command
    // beside the list would pass a check of the list alone.
    const paths = everyBunTestPath(unitTestCommand());
    expect(paths).toBeDefined();
    expect(push).toBeDefined();
    expect(paths).toEqual(push as readonly string[]);
  });
});

describe("the macOS/Windows push legs still run the integration and e2e trees", () => {
  // On those legs ci.yml turns off the separate Integration / E2E Gateway / E2E CLI jobs, because
  // the unit job's whole-repo command collects every file they ran. That is safe only while it
  // still does: a unit command narrowed to `packages/gateway/src`, or told to skip files, would
  // leave those trees running on Ubuntu alone, with every check green. So every path one of those
  // jobs runs must sit inside a path the push leg's unit command names.
  type Job = { readonly if?: unknown; readonly steps?: readonly { readonly run?: unknown }[] };
  const suite = loadYaml(readFileSync(TEST_SUITE_YML, "utf8")) as {
    on?: {
      workflow_call?: {
        inputs?: Record<string, { description?: unknown; type?: unknown; default?: unknown }>;
      };
    };
    jobs?: Record<string, Job>;
  };
  const ci = loadYaml(readFileSync(CI_YML, "utf8")) as {
    jobs?: Record<string, { readonly with?: Record<string, unknown> }>;
  };
  const SEPARATE_JOBS = ["integration", "e2e-gateway", "e2e-cli"] as const;
  const pushLine = pushLines[0] ?? "";
  const unitPaths = bunTestPaths(pushLine) ?? [];

  /** Every path a job hands `bun test`, over every `bun test` line of every `run:` it has. */
  function jobTestPaths(job: Job | undefined): readonly string[] {
    const paths: string[] = [];
    for (const step of job?.steps ?? []) {
      if (typeof step.run !== "string") continue;
      for (const line of step.run.split(/\r?\n/)) paths.push(...(bunTestPaths(line) ?? []));
    }
    return paths;
  }

  test("only the push matrix turns the jobs off, and only off Ubuntu", () => {
    for (const name of SEPARATE_JOBS) {
      expect({ name, if: suite.jobs?.[name]?.if }).toEqual({
        name,
        if: "inputs.run-tests && inputs.run-integration-and-e2e",
      });
    }
    expect(String(ci.jobs?.["ci-ts"]?.with?.["run-integration-and-e2e"])).toMatch(
      /^\$\{\{ matrix\.os == 'ubuntu-24\.04' \}\}$/,
    );
    // Every other caller — ci.yml's PR gate and release.yml's suite — leaves the input unset, so
    // they run the jobs only while the declared default is `true`: GitHub reads an unset boolean
    // input with no default as false, and those jobs would then skip with every check green.
    expect(suite.on?.workflow_call?.inputs?.["run-integration-and-e2e"]).toEqual({
      description: expect.any(String),
      type: "boolean",
      default: true,
    });
    const setters = readdirSync(join(REPO_ROOT, ".github", "workflows"))
      .filter((f) => f.endsWith(".yml") && f !== "_test-suite.yml")
      .filter((f) =>
        readFileSync(join(REPO_ROOT, ".github", "workflows", f), "utf8").includes(
          "run-integration-and-e2e:",
        ),
      );
    expect(setters).toEqual(["ci.yml"]);
    expect(ci.jobs?.["pr-quality-ts"]?.with ?? {}).not.toHaveProperty("run-integration-and-e2e");
  });

  test("every path those jobs run sits inside a path the unit command names", () => {
    expect(unitPaths.length).toBeGreaterThan(0);
    for (const name of SEPARATE_JOBS) {
      const paths = jobTestPaths(suite.jobs?.[name]);
      // Presence first: a job whose `bun test` line this stopped finding would pass the loop.
      expect({ name, found: paths.length > 0 }).toEqual({ name, found: true });
      for (const raw of paths) {
        const path = raw.replace(/\/+$/, "");
        const covered = unitPaths.some((u) => path === u || path.startsWith(`${u}/`));
        expect({ name, path, covered }).toEqual({ name, path, covered: true });
      }
    }
  });

  test("the unit command filters out no file and no test", () => {
    // A path or name filter would let the containment check above pass while the files never ran.
    // Every flag in Bun 1.4.3's `bun test --help` that runs less, plus `--grep`, which that help
    // omits but 1.4.3 honours as a test-name filter. Matched as `--flag`, `--flag value` (the flag
    // is its own token) and `--flag=value`.
    const FILTERS = [
      "-t",
      "--test-name-pattern",
      "--grep",
      "--path-ignore-patterns",
      "--changed",
      "--only",
      "--shard",
    ];
    const tokens = pushLine.slice(pushLine.indexOf(" bun test ")).split(/\s+/);
    const filters = tokens.filter((t) => FILTERS.some((f) => t === f || t.startsWith(`${f}=`)));
    expect(filters).toEqual([]);
  });
});
