import { describe, expect, test } from "bun:test";

import {
  annotationLines,
  type BunSummary,
  type Deps,
  type FailingCase,
  failingCases,
  killReason,
  type Limits,
  main,
  mergeJunit,
  parseBunSummary,
  planRetry,
  retryArgv,
} from "./test-with-retry.ts";

// Real Bun 1.4.3 output (`bun test … --parallel --reporter=junit`), trimmed, with the file paths a
// Windows runner writes: backslashes, repo-relative.
const JUNIT_MIXED = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="6" assertions="4" failures="3" skipped="0" time="0.8063892">
  <testsuite name="pkg\\a-pass.test.ts" file="pkg\\a-pass.test.ts" tests="1" assertions="1" failures="0" skipped="0" time="0.0017037" hostname="">
    <testcase name="passes" classname="" time="0.000073" file="pkg\\a-pass.test.ts" line="2" assertions="1" />
  </testsuite>
  <testsuite name="pkg\\b-assert.test.ts" file="pkg\\b-assert.test.ts" tests="2" assertions="2" failures="1" skipped="0" time="0.0007993" hostname="">
    <testcase name="ok one" classname="" time="0.000012" file="pkg\\b-assert.test.ts" line="2" assertions="1" />
    <testcase name="fails an assertion" classname="" time="0.000335" file="pkg\\b-assert.test.ts" line="3" assertions="1">
      <failure type="AssertionError" message="expect(received).toBe(expected)&#10;&#10;Expected: 2&#10;Received: 1&#10;">AssertionError: expect(received).toBe(expected)&#10;</failure>
    </testcase>
  </testsuite>
  <testsuite name="pkg\\c-timeout.test.ts" file="pkg\\c-timeout.test.ts" tests="1" assertions="0" failures="1" skipped="0" time="0.5032179" hostname="">
    <testcase name="times out" classname="" time="0.501559" file="pkg\\c-timeout.test.ts" line="2" assertions="0">
      <failure type="TimeoutError" message="test timed out" />
    </testcase>
  </testsuite>
  <testsuite name="pkg\\d-unhandled.test.ts" file="pkg\\d-unhandled.test.ts" tests="2" assertions="1" failures="1" skipped="0" time="0.0110394" hostname="">
    <testcase name="schedules a throw after it ends" classname="" time="0.000035" file="pkg\\d-unhandled.test.ts" line="2" assertions="1" />
    <testcase name="next test" classname="" time="0.010334" file="pkg\\d-unhandled.test.ts" line="6" assertions="0">
      <failure type="Error" message="boom between tests">Error: boom between tests&#10;</failure>
    </testcase>
  </testsuite>
</testsuites>
`;

// Nested describes, a failing beforeAll (Bun reports it as an "(unnamed)" case with no line) and
// a name that needs entity decoding.
const JUNIT_HOOKS = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="3" assertions="1" failures="2" skipped="0" time="0.4956479">
  <testsuite name="f-beforeall.test.ts" file="f-beforeall.test.ts" tests="1" assertions="0" failures="1" skipped="0" time="0.0012612" hostname="">
    <testsuite name="suite with failing beforeAll" file="f-beforeall.test.ts" line="2" tests="1" assertions="0" failures="1" skipped="0" time="0" hostname="">
      <testcase name="(unnamed)" classname="suite with failing beforeAll" time="0.000179" file="f-beforeall.test.ts" assertions="0">
        <failure type="Error" message="beforeAll exploded">Error: beforeAll exploded&#10;</failure>
      </testcase>
    </testsuite>
  </testsuite>
  <testsuite name="i-nested.test.ts" file="i-nested.test.ts" tests="2" assertions="1" failures="1" skipped="0" time="0.000901" hostname="">
    <testsuite name="outer" file="i-nested.test.ts" line="2" tests="2" assertions="1" failures="1" skipped="0" time="0" hostname="">
      <testsuite name="inner &amp; &lt;x&gt;" file="i-nested.test.ts" line="2" tests="1" assertions="1" failures="1" skipped="0" time="0" hostname="">
        <testcase name="deep &quot;quoted&quot; fails" classname="inner &amp; &lt;x&gt; &gt; outer" time="0.000194" file="i-nested.test.ts" line="2" assertions="1">
          <failure type="AssertionError" message="expect(received).toBe(expected)">AssertionError</failure>
        </testcase>
      </testsuite>
      <testcase name="sibling passes" classname="outer" time="0.0001" file="i-nested.test.ts" line="3" assertions="0" />
    </testsuite>
  </testsuite>
</testsuites>
`;

// The end of the same runs' logs. The first had a file that threw while loading: Bun prints an
// "Unhandled error between tests" block, counts it as a fail, and leaves the file OUT of the JUnit.
const LOG_WITH_UNHANDLED = `e-import-throws.test.ts:

# Unhandled error between tests
-------------------------------
error: top-level import failure
-------------------------------


 3 pass
 4 fail
 1 error
 4 expect() calls
Ran 7 tests across 5 files. [806.00ms]
`;

const LOG_CLEAN_FAILURES = `(fail) suite with failing beforeAll > (unnamed) [0.18ms]
(fail) outer > inner & <x> > deep "quoted" fails [0.19ms]

 1 pass
 2 fail
 1 expect() calls
Ran 3 tests across 2 files. [495.00ms]
`;

describe("failingCases", () => {
  test("names every failing case with its file, line and failure type", () => {
    expect(failingCases(JUNIT_MIXED)).toEqual([
      { file: "pkg/b-assert.test.ts", line: 3, name: "fails an assertion", type: "AssertionError" },
      { file: "pkg/c-timeout.test.ts", line: 2, name: "times out", type: "TimeoutError" },
      { file: "pkg/d-unhandled.test.ts", line: 6, name: "next test", type: "Error" },
    ]);
  });

  test("prefixes the describe path, decodes entities, and keeps a hook failure with no line", () => {
    expect(failingCases(JUNIT_HOOKS)).toEqual([
      {
        file: "f-beforeall.test.ts",
        line: undefined,
        name: "suite with failing beforeAll > (unnamed)",
        type: "Error",
      },
      {
        file: "i-nested.test.ts",
        line: 2,
        name: 'outer > inner & <x> > deep "quoted" fails',
        type: "AssertionError",
      },
    ]);
  });

  test("is undefined for anything that is not a JUnit report", () => {
    expect(failingCases("")).toBeUndefined();
    expect(failingCases("bun: command not found")).toBeUndefined();
  });

  test("is an empty list for a report with no failures", () => {
    expect(
      failingCases(
        `<testsuites name="bun test" tests="1" failures="0"><testsuite name="a" file="a"><testcase name="x" file="a" line="1" /></testsuite></testsuites>`,
      ),
    ).toEqual([]);
  });
});

describe("parseBunSummary", () => {
  test("reads the counts and flags an unhandled error between tests", () => {
    expect(parseBunSummary(LOG_WITH_UNHANDLED)).toEqual({
      pass: 3,
      fail: 4,
      errors: 1,
      ran: 7,
      unhandled: true,
    });
  });

  test("a clean failing run has no error line and no unhandled block", () => {
    expect(parseBunSummary(LOG_CLEAN_FAILURES)).toEqual({
      pass: 1,
      fail: 2,
      errors: 0,
      ran: 3,
      unhandled: false,
    });
  });

  test("is undefined when the run never printed its summary (killed, crashed or hung)", () => {
    expect(parseBunSummary("(pass) a [1ms]\n(pass) b [2ms]\n")).toBeUndefined();
  });
});

describe("planRetry", () => {
  const cases = failingCases(JUNIT_HOOKS);
  const clean = parseBunSummary(LOG_CLEAN_FAILURES);

  test("re-runs only the failing files when every failure is attributed to one", () => {
    expect(planRetry(cases, clean)).toEqual({
      kind: "targeted",
      files: ["f-beforeall.test.ts", "i-nested.test.ts"],
    });
  });

  test("lists each failing file once, sorted", () => {
    const mixed = failingCases(JUNIT_MIXED);
    const summary: BunSummary = { pass: 3, fail: 3, errors: 0, ran: 6, unhandled: false };
    expect(planRetry(mixed, summary)).toEqual({
      kind: "targeted",
      files: ["pkg/b-assert.test.ts", "pkg/c-timeout.test.ts", "pkg/d-unhandled.test.ts"],
    });
  });

  test("an unhandled error between tests forces a full re-run — the JUnit omits that file", () => {
    const plan = planRetry(failingCases(JUNIT_MIXED), parseBunSummary(LOG_WITH_UNHANDLED));
    expect(plan.kind).toBe("full");
    expect(plan.kind === "full" ? plan.reason : "").toContain("outside any test");
  });

  test("a run with no summary forces a full re-run", () => {
    const plan = planRetry(cases, undefined);
    expect(plan).toEqual({
      kind: "full",
      reason: "the run printed no summary — killed by the time cap, crashed or hung",
    });
  });

  test("a missing JUnit report forces a full re-run", () => {
    expect(planRetry(undefined, clean)).toEqual({
      kind: "full",
      reason: "no JUnit report to attribute the failures",
    });
  });

  test("a fail count the JUnit cannot account for forces a full re-run", () => {
    const summary: BunSummary = { pass: 1, fail: 3, errors: 0, ran: 4, unhandled: false };
    const plan = planRetry(cases, summary);
    expect(plan.kind).toBe("full");
    expect(plan.kind === "full" ? plan.reason : "").toContain("3 failures but the JUnit names 2");
  });

  test("a failed exit with no failing test at all forces a full re-run", () => {
    const summary: BunSummary = { pass: 5, fail: 0, errors: 0, ran: 5, unhandled: false };
    expect(planRetry([], summary).kind).toBe("full");
  });
});

describe("retryArgv", () => {
  test("swaps the path list for the failing files and drops sharding and timings writes", () => {
    expect(
      retryArgv(
        [
          "bun",
          "test",
          "packages/gateway",
          "packages/cli",
          "scripts",
          "--timeout=60000",
          "--parallel",
          "--shard=2/2",
          "--timings=/tmp/t.json",
          "--update-timings",
        ],
        ["pkg/b.test.ts", "scripts/x.test.ts"],
      ),
    ).toEqual([
      "bun",
      "test",
      "./pkg/b.test.ts",
      "./scripts/x.test.ts",
      "--timeout=60000",
      "--parallel",
    ]);
  });

  test("keeps a flag's separate value attached to its flag", () => {
    expect(
      retryArgv(["bun", "test", "a", "--timeout", "60000", "--parallel"], ["a/x.test.ts"]),
    ).toEqual(["bun", "test", "./a/x.test.ts", "--timeout", "60000", "--parallel"]);
  });
});

describe("mergeJunit", () => {
  const retry = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="1" assertions="1" failures="0" skipped="0" time="0.2">
  <testsuite name="pkg\\c-timeout.test.ts" file="pkg\\c-timeout.test.ts" tests="1" assertions="1" failures="0" skipped="0" time="0.2" hostname="">
    <testcase name="times out" classname="" time="0.2" file="pkg\\c-timeout.test.ts" line="2" assertions="1" />
  </testsuite>
</testsuites>
`;

  test("replaces the retried files' suites and recomputes the totals", () => {
    const merged = mergeJunit(JUNIT_MIXED, retry);
    expect(failingCases(merged)).toEqual([
      { file: "pkg/b-assert.test.ts", line: 3, name: "fails an assertion", type: "AssertionError" },
      { file: "pkg/d-unhandled.test.ts", line: 6, name: "next test", type: "Error" },
    ]);
    expect(merged).toContain('tests="6"');
    expect(merged).toContain('failures="2"');
    expect(merged.match(/c-timeout\.test\.ts" file=/g)).toHaveLength(1);
  });
});

describe("annotationLines", () => {
  const flaky: FailingCase = {
    file: "pkg/x.test.ts",
    line: 4,
    name: "x, y: z",
    type: "TimeoutError",
  };

  test("a clean first attempt annotates nothing", () => {
    expect(
      annotationLines({
        label: "L",
        attempt1: { code: 0, cases: [] },
        plan: undefined,
        final: undefined,
      }),
    ).toEqual([]);
  });

  test("a masked failure leads with the retry warning, then names the flaky tests", () => {
    const lines = annotationLines({
      label: "windows-2025, 2/2",
      attempt1: { code: 1, cases: [flaky] },
      plan: { kind: "targeted", files: ["pkg/x.test.ts"] },
      final: { code: 0, cases: [] },
    });
    expect(lines[0]).toStartWith("::warning title=Retry masked a failure::windows-2025, 2/2:");
    // Property values escape ':' and ','; the message escapes only '%', CR and LF.
    expect(lines[1]).toBe(
      "::warning file=pkg/x.test.ts,line=4,title=Flaky test::x, y: z (TimeoutError)",
    );
  });

  test("never emits more than 10 warnings or 10 errors — GitHub drops the rest", () => {
    const many: FailingCase[] = Array.from({ length: 30 }, (_, i) => ({
      file: `f${String(i)}.test.ts`,
      line: 1,
      name: `t${String(i)}`,
      type: "Error",
    }));
    const lines = annotationLines({
      label: "L",
      attempt1: { code: 1, cases: many },
      plan: { kind: "targeted", files: many.map((c) => c.file) },
      final: { code: 1, cases: many.slice(0, 25) },
    });
    expect(lines.filter((l) => l.startsWith("::warning")).length).toBeLessThanOrEqual(10);
    expect(lines.filter((l) => l.startsWith("::error")).length).toBe(10);
  });

  test("a retry that left no report names no test flaky — nothing shows which tests it passed", () => {
    // Killed by the cap or crashed: no JUnit, so `final.cases` is undefined. Calling every
    // attempt-1 failure "Flaky test" would claim the retry passed them; the nightly flaky-tests
    // report counts exactly those annotations.
    const lines = annotationLines({
      label: "L",
      attempt1: { code: 1, cases: [flaky] },
      plan: { kind: "targeted", files: ["pkg/x.test.ts"] },
      final: { code: 124, cases: undefined },
    });
    expect(lines.some((l) => l.includes("title=Flaky test"))).toBe(false);
    expect(lines.some((l) => l.startsWith("::error title=Test run failed::"))).toBe(true);
  });

  test("a final failure with no named test still produces an error", () => {
    const lines = annotationLines({
      label: "L",
      attempt1: { code: 124, cases: undefined },
      plan: { kind: "full", reason: "the run printed no summary" },
      final: { code: 124, cases: undefined },
    });
    expect(lines.some((l) => l.startsWith("::error title=Test run failed::"))).toBe(true);
  });

  test("escapes newlines and percent signs in messages", () => {
    const lines = annotationLines({
      label: "L",
      attempt1: { code: 1, cases: [{ ...flaky, name: "100% done\nnext" }] },
      plan: { kind: "targeted", files: ["pkg/x.test.ts"] },
      final: { code: 1, cases: [{ ...flaky, name: "100% done\nnext" }] },
    });
    expect(lines.some((l) => l.endsWith("::100%25 done%0Anext (TimeoutError)"))).toBe(true);
  });
});

describe("killReason", () => {
  const limits: Limits = { capSeconds: 1500, silenceSeconds: 300 };

  test("nothing to kill while the attempt is inside both limits", () => {
    expect(killReason(1_499_000, 299_000, limits)).toBeUndefined();
  });

  test("silence kills long before the cap — the hung-worker case", () => {
    // config.test.ts on macOS: output stopped ~6.6 min in and the cap fired at 25. With a
    // 300 s silence limit the attempt ends at ~11.6 min instead.
    expect(killReason(6.6 * 60_000 + 300_000, 300_000, limits)).toBe("silence");
  });

  test("the cap still applies to an attempt that keeps printing", () => {
    expect(killReason(1_500_000, 1_000, limits)).toBe("cap");
  });

  test("an attempt over the cap and silent reports the cap", () => {
    expect(killReason(1_500_000, 400_000, limits)).toBe("cap");
  });

  test("without a silence limit, silence alone never kills", () => {
    expect(killReason(60_000, 3_600_000, { capSeconds: 1500, silenceSeconds: undefined })).toBe(
      undefined,
    );
  });
});

describe("main", () => {
  type Attempt = { code: number; output: string; junit?: string };

  function harness(attempts: Attempt[]) {
    const ran: string[][] = [];
    const limitsSeen: Limits[] = [];
    const files = new Map<string, string>();
    const emitted: string[] = [];
    const summary: string[] = [];
    const deps: Deps = {
      run: async (argv, limits) => {
        ran.push([...argv]);
        limitsSeen.push(limits);
        const a = attempts[ran.length - 1];
        if (a === undefined) throw new Error("unexpected attempt");
        const out = argv.find((x) => x.startsWith("--reporter-outfile="))?.split("=")[1];
        if (a.junit !== undefined && out !== undefined) files.set(out, a.junit);
        return { code: a.code, output: a.output };
      },
      readText: async (path) => files.get(path),
      writeText: async (path, text) => {
        files.set(path, text);
      },
      removeFile: async (path) => {
        files.delete(path);
      },
      appendSummary: async (md) => {
        summary.push(md);
      },
      emit: (line) => {
        emitted.push(line);
      },
    };
    return { deps, ran, limitsSeen, files, emitted, summary };
  }

  const CMD = [
    "--label=windows-2025, 2/2",
    "--cap-seconds=1500",
    "--report-dir=/rt",
    "--",
    "bun",
    "test",
    "packages/gateway",
    "scripts",
    "--timeout=60000",
    "--parallel",
    "--shard=2/2",
  ];

  test("a green first attempt runs once and exits 0", async () => {
    const h = harness([{ code: 0, output: " 5 pass\n 0 fail\nRan 5 tests across 1 file. [1s]\n" }]);
    expect(await main(CMD, h.deps)).toBe(0);
    expect(h.ran).toHaveLength(1);
    expect(h.ran[0]).toContain("--reporter-outfile=/rt/junit-attempt-1.xml");
    expect(h.emitted.filter((l) => l.startsWith("::warning") || l.startsWith("::error"))).toEqual(
      [],
    );
  });

  test("an attributable failure retries only the failing files, and a pass exits 0 with a warning", async () => {
    const h = harness([
      { code: 1, output: LOG_CLEAN_FAILURES, junit: JUNIT_HOOKS },
      { code: 0, output: " 3 pass\n 0 fail\nRan 3 tests across 2 files. [1s]\n" },
    ]);
    expect(await main(CMD, h.deps)).toBe(0);
    expect(h.ran[1]?.slice(0, 4)).toEqual([
      "bun",
      "test",
      "./f-beforeall.test.ts",
      "./i-nested.test.ts",
    ]);
    expect(h.ran[1]).not.toContain("--shard=2/2");
    expect(h.emitted.find((l) => l.startsWith("::warning"))).toStartWith(
      "::warning title=Retry masked a failure::",
    );
    expect(h.summary.join("")).toContain("needed a retry");
  });

  test("a killed first attempt re-runs the whole command unchanged", async () => {
    const h = harness([
      { code: 124, output: "(pass) a [1ms]\n" },
      { code: 0, output: " 9 pass\n 0 fail\nRan 9 tests across 3 files. [1s]\n" },
    ]);
    expect(await main(CMD, h.deps)).toBe(0);
    const strip = (argv: string[] | undefined) =>
      (argv ?? []).filter((a) => !a.startsWith("--reporter"));
    expect(strip(h.ran[1])).toEqual(strip(h.ran[0]));
  });

  test("two failing attempts exit with the second attempt's code and name its failures", async () => {
    const h = harness([
      { code: 1, output: LOG_CLEAN_FAILURES, junit: JUNIT_HOOKS },
      { code: 1, output: LOG_CLEAN_FAILURES, junit: JUNIT_HOOKS },
    ]);
    expect(await main(CMD, h.deps)).toBe(1);
    expect(h.emitted.filter((l) => l.startsWith("::error file="))).toHaveLength(2);
  });

  test("the test output is fenced off from workflow-command processing", async () => {
    const h = harness([{ code: 0, output: "" }]);
    await main(CMD, h.deps);
    const stop = h.emitted.find((l) => l.startsWith("::stop-commands::"));
    expect(stop).toBeDefined();
    const token = stop?.slice("::stop-commands::".length) ?? "";
    expect(token.length).toBeGreaterThanOrEqual(16);
    expect(h.emitted).toContain(`::${token}::`);
  });

  test("a stale report from an earlier attempt is removed before each attempt runs", async () => {
    const h = harness([
      { code: 124, output: "" },
      { code: 124, output: "" },
    ]);
    h.files.set("/rt/junit-attempt-1.xml", JUNIT_HOOKS);
    expect(await main(CMD, h.deps)).toBe(124);
    // Had the stale file survived, attempt 1 would have looked attributable and been retried
    // as a targeted run of the old report's files.
    expect(h.ran[1]).toContain("--shard=2/2");
  });

  test("--final-junit receives the merged report after a targeted retry", async () => {
    const h = harness([
      { code: 1, output: LOG_CLEAN_FAILURES, junit: JUNIT_HOOKS },
      {
        code: 0,
        output: " 2 pass\n 0 fail\nRan 2 tests across 2 files. [1s]\n",
        junit: `<testsuites name="bun test" tests="2" failures="0"><testsuite name="f-beforeall.test.ts" file="f-beforeall.test.ts" tests="1" failures="0" time="0.1"><testcase name="t" file="f-beforeall.test.ts" line="1" /></testsuite><testsuite name="i-nested.test.ts" file="i-nested.test.ts" tests="1" failures="0" time="0.1"><testcase name="t" file="i-nested.test.ts" line="1" /></testsuite></testsuites>`,
      },
    ]);
    expect(
      await main(
        [...CMD.slice(0, 3), "--final-junit=/out/junit-unit.xml", ...CMD.slice(3)],
        h.deps,
      ),
    ).toBe(0);
    expect(failingCases(h.files.get("/out/junit-unit.xml") ?? "")).toEqual([]);
  });

  test("hands both limits to every attempt, and no silence limit when none was given", async () => {
    const h = harness([
      { code: 124, output: "" },
      { code: 0, output: " 1 pass\n 0 fail\nRan 1 test across 1 file. [1s]\n" },
    ]);
    const withSilence = [...CMD.slice(0, 2), "--silence-seconds=300", ...CMD.slice(2)];
    expect(await main(withSilence, h.deps)).toBe(0);
    expect(h.limitsSeen).toEqual([
      { capSeconds: 1500, silenceSeconds: 300 },
      { capSeconds: 1500, silenceSeconds: 300 },
    ]);

    const plain = harness([{ code: 0, output: "" }]);
    await main(CMD, plain.deps);
    expect(plain.limitsSeen).toEqual([{ capSeconds: 1500, silenceSeconds: undefined }]);
  });

  test("refuses a silence limit it cannot use instead of running without one", async () => {
    for (const bad of ["--silence-seconds=0", "--silence-seconds=-5", "--silence-seconds=soon"]) {
      const h = harness([]);
      expect(await main([...CMD.slice(0, 2), bad, ...CMD.slice(2)], h.deps)).toBe(2);
      expect(h.ran).toHaveLength(0);
    }
  });

  test("refuses a command that is not `bun test`, or that sets its own reporter", async () => {
    const h = harness([]);
    expect(
      await main(
        ["--label=L", "--cap-seconds=10", "--report-dir=/rt", "--", "npm", "test"],
        h.deps,
      ),
    ).toBe(2);
    expect(
      await main(
        [
          "--label=L",
          "--cap-seconds=10",
          "--report-dir=/rt",
          "--",
          "bun",
          "test",
          "a",
          "--reporter=junit",
        ],
        h.deps,
      ),
    ).toBe(2);
    expect(h.ran).toHaveLength(0);
  });
});
