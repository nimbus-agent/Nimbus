import { describe, expect, test } from "bun:test";

import {
  type Annotation,
  aggregateFlakyTests,
  applyIssueAction,
  collectLegs,
  createGh,
  type FlakyRow,
  flakyTestsForLeg,
  type Gh,
  ISSUE_LABEL,
  ISSUE_TITLE,
  type LegResult,
  legLabel,
  main,
  parseAnnotations,
  parseArgs,
  parseCheckRuns,
  parseFlakyAnnotation,
  parseWorkflowRuns,
  planIssueAction,
  type ReportContext,
  renderCloseComment,
  renderIssueBody,
  type SpawnResult,
  selectRuns,
  TOP_ROWS,
} from "./flaky-tests-report.ts";

// ── Fixtures, in the shape GitHub's annotations endpoint returns ───────────────────────────────

interface RawAnnotation {
  path: string;
  start_line: number;
  annotation_level: string;
  title: string;
  message: string;
}

function raw(
  level: string,
  title: string,
  message: string,
  path = ".github",
  line = 1200,
): RawAnnotation {
  return { path, start_line: line, annotation_level: level, title, message };
}

function ann(...rows: RawAnnotation[]): Annotation[] {
  return parseAnnotations([rows]);
}

/** test-with-retry.ts: `::warning file=…,line=…,title=Flaky test::<name> (<type>)`. */
const STRUCTURED = raw(
  "warning",
  "Flaky test",
  "toolgen.revoke > a saved tool does NOT come back (TimeoutError)",
  "packages/gateway/test/integration/toolgen/toolgen-revoke.test.ts",
  88,
);
/** The pre-#1676 shell loop: `::warning title=Flaky test::(fail) <name> [<ms>ms]`, no file. */
const LEGACY = raw(
  "warning",
  "Flaky test",
  "(fail) install.ps1 installs from a served release [60001.66ms]",
  ".github",
  19021,
);
const MASKED = raw(
  "warning",
  "Retry masked a failure",
  "windows-2025, 2/2: attempt 1 failed 1 test in 1 file; a re-run of only those 1 file passed.",
);
const NOT_HELPED = raw(
  "warning",
  "Retry did not help",
  "macos-15: attempt 1 failed 2 tests in 2 files; a full re-run failed too (exit 1).",
);
const TEST_FAILED = raw(
  "failure",
  "Test failed",
  "still broken > every time (AssertionError)",
  "packages/cli/src/x.test.ts",
  4,
);
const RUN_FAILED = raw(
  "failure",
  "Test run failed",
  "macos-15: exit 124 with no failing test named — a timeout, crash or hang; see the log above.",
);
// Noise every legacy leg carries: the suite's own output printed workflow commands.
const NOISE = [
  raw(
    "warning",
    "",
    "@nimbus-dev/connectors is pinned at 0.1.1; 0.1.4 is published",
    "packages/gateway/package.json",
    0,
  ),
  raw(
    "warning",
    "Scheduled credential work: PACKAGE_MANAGER_PAT",
    "PACKAGE_MANAGER_PAT — indeterminate",
  ),
  raw(
    "failure",
    "error: expect(received).toBe(expected)",
    "Expected: 1\nReceived: 2",
    "packages\\gateway\\x.test.ts",
    531,
  ),
  raw("notice", "bun install (Windows)", "7 s"),
];

// ── parseAnnotations ────────────────────────────────────────────────────────────────────────────

describe("parseAnnotations", () => {
  test("flattens --slurp pages and maps GitHub's fields", () => {
    const out = parseAnnotations([[STRUCTURED], [LEGACY]]);
    expect(out).toEqual([
      {
        path: "packages/gateway/test/integration/toolgen/toolgen-revoke.test.ts",
        line: 88,
        level: "warning",
        title: "Flaky test",
        message: "toolgen.revoke > a saved tool does NOT come back (TimeoutError)",
      },
      {
        path: ".github",
        line: 19021,
        level: "warning",
        title: "Flaky test",
        message: "(fail) install.ps1 installs from a served release [60001.66ms]",
      },
    ]);
  });

  test("a line of 0 means the command named no line; a null title is an empty one", () => {
    const [a] = parseAnnotations([
      [{ path: "a.ts", start_line: 0, annotation_level: "warning", title: null, message: "m" }],
    ]);
    expect(a?.line).toBeUndefined();
    expect(a?.title).toBe("");
  });

  test("skips entries that are not annotation objects", () => {
    expect(parseAnnotations([[null, 3, { path: "a" }], "x"])).toEqual([]);
    expect(parseAnnotations({ not: "pages" })).toEqual([]);
  });
});

// ── parseFlakyAnnotation ────────────────────────────────────────────────────────────────────────

describe("parseFlakyAnnotation", () => {
  test("reads a test-with-retry.ts annotation: file, line, name and failure type", () => {
    const [a] = ann(STRUCTURED);
    expect(a && parseFlakyAnnotation(a)).toEqual({
      format: "structured",
      file: "packages/gateway/test/integration/toolgen/toolgen-revoke.test.ts",
      line: 88,
      name: "toolgen.revoke > a saved tool does NOT come back",
      failureType: "TimeoutError",
    });
  });

  test("only the LAST parenthesised group is the type; the name keeps its own parentheses", () => {
    const [a] = ann(
      raw(
        "warning",
        "Flaky test",
        "startAuditShipper > a failing post (returns false) keeps the cursor (AssertionError)",
        "packages/gateway/src/audit/audit-shipper.test.ts",
        192,
      ),
    );
    const obs = a && parseFlakyAnnotation(a);
    expect(obs?.name).toBe("startAuditShipper > a failing post (returns false) keeps the cursor");
    expect(obs?.failureType).toBe("AssertionError");
  });

  test("reads a legacy annotation: drops `(fail) ` and the duration, and names no file", () => {
    const [a] = ann(LEGACY);
    expect(a && parseFlakyAnnotation(a)).toEqual({
      format: "legacy",
      file: undefined,
      line: undefined,
      name: "install.ps1 installs from a served release",
      failureType: undefined,
    });
  });

  test("a legacy name keeps its parentheses and dashes; only the trailing [ms] goes", () => {
    const [a] = ann(
      raw(
        "warning",
        "Flaky test",
        "(fail) startAuditShipper > a failing post (returns false) does NOT advance — rows retried [115.95ms]",
      ),
    );
    expect(a && parseFlakyAnnotation(a)?.name).toBe(
      "startAuditShipper > a failing post (returns false) does NOT advance — rows retried",
    );
  });

  test("a structured annotation that names no file reports none (GitHub's `.github` placeholder)", () => {
    const [a] = ann(raw("warning", "Flaky test", "loose > test (Error)", ".github", 7));
    const obs = a && parseFlakyAnnotation(a);
    expect(obs?.format).toBe("structured");
    expect(obs?.file).toBeUndefined();
  });

  test("normalises Windows separators and collapses a multi-line name", () => {
    const [a] = ann(
      raw("warning", "Flaky test", "100% done\nnext (TimeoutError)", "packages\\cli\\a.test.ts", 3),
    );
    const obs = a && parseFlakyAnnotation(a);
    expect(obs?.file).toBe("packages/cli/a.test.ts");
    expect(obs?.name).toBe("100% done next");
  });

  test("a structured message with no type suffix keeps the whole message as the name", () => {
    const [a] = ann(raw("warning", "Flaky test", "just a name", "a.test.ts", 1));
    const obs = a && parseFlakyAnnotation(a);
    expect(obs?.name).toBe("just a name");
    expect(obs?.failureType).toBeUndefined();
  });

  test("ignores every annotation that is not a flaky-test WARNING", () => {
    const others = ann(
      MASKED,
      NOT_HELPED,
      TEST_FAILED,
      RUN_FAILED,
      ...NOISE,
      raw("failure", "Flaky test", "a > b (Error)", "a.test.ts", 1),
      raw("warning", "Flaky test", "   ", "a.test.ts", 1),
    );
    expect(others.map(parseFlakyAnnotation).filter((o) => o !== undefined)).toEqual([]);
  });
});

// ── flakyTestsForLeg ────────────────────────────────────────────────────────────────────────────

describe("flakyTestsForLeg", () => {
  test("a retry that passed counts each flaky test it names", () => {
    const flaky2 = raw("warning", "Flaky test", "b > c (Error)", "packages/cli/b.test.ts", 9);
    const r = flakyTestsForLeg(ann(MASKED, STRUCTURED, flaky2, ...NOISE), "success");
    expect(r.retried).toBe(true);
    expect(r.masked).toBe(true);
    expect(r.unverified).toBe(0);
    expect(r.tests.map((t) => t.name)).toEqual([
      "toolgen.revoke > a saved tool does NOT come back",
      "b > c",
    ]);
  });

  test("legacy: a green leg counts its flaky tests even when the cap dropped the masked warning", () => {
    // The real shape of job 117125931902: four noise warnings, then the same `(fail)` line
    // twice (Bun prints it inline and again in its end-of-run recap) — and no
    // `Retry masked a failure`, because it would have been the step's eleventh warning.
    const dup = { ...LEGACY, start_line: 19026 };
    const r = flakyTestsForLeg(ann(...NOISE, LEGACY, dup), "success");
    expect(r.retried).toBe(true);
    expect(r.masked).toBe(true);
    expect(r.tests).toHaveLength(1);
  });

  test("legacy: a leg whose retry ALSO failed counts nothing — the old loop could not say which recovered", () => {
    const other = raw("warning", "Flaky test", "(fail) a > b [3.00ms]");
    const r = flakyTestsForLeg(ann(...NOISE, LEGACY, other, LEGACY), "failure");
    expect(r.retried).toBe(true);
    expect(r.masked).toBe(false);
    expect(r.tests).toEqual([]);
    expect(r.unverified).toBe(2);
  });

  test("structured: a retry that did not help still counts the tests it recovered", () => {
    const r = flakyTestsForLeg(ann(NOT_HELPED, STRUCTURED, TEST_FAILED), "failure");
    expect(r.masked).toBe(false);
    expect(r.tests.map((t) => t.name)).toEqual([
      "toolgen.revoke > a saved tool does NOT come back",
    ]);
  });

  test("structured: a retry that failed without naming anything is inconclusive and counts nothing", () => {
    // test-with-retry.ts labels every attempt-1 failure flaky when the retry left no JUnit
    // (killed by the cap, crashed) — the retry never said those tests passed.
    const r = flakyTestsForLeg(ann(NOT_HELPED, STRUCTURED, RUN_FAILED), "failure");
    expect(r.tests).toEqual([]);
    expect(r.unverified).toBe(1);
  });

  test("a leg with no retry annotations did not retry", () => {
    const r = flakyTestsForLeg(ann(...NOISE), "success");
    expect(r).toEqual({ retried: false, masked: false, tests: [], unverified: 0 });
  });

  test("a legacy retry that named no test still counts as a masked retry", () => {
    const r = flakyTestsForLeg(
      ann(raw("warning", "Attempt 1 failed with no (fail) line", "exit 124")),
      "success",
    );
    expect(r.retried).toBe(true);
    expect(r.masked).toBe(true);
    expect(r.tests).toEqual([]);
  });
});

// ── legLabel ────────────────────────────────────────────────────────────────────────────────────

describe("legLabel", () => {
  test("names the PR cross-platform legs by their matrix label", () => {
    expect(legLabel("PR quality — Cross-platform (windows-2025, 2/2)")).toBe("windows-2025, 2/2");
    expect(legLabel("PR quality — Cross-platform (macos-15)")).toBe("macos-15");
  });

  test("names the push Unit + Coverage legs on macOS and Windows", () => {
    expect(legLabel("CI — TS/Bun (macos-15) / Unit + Coverage — macos-15")).toBe("macos-15 (push)");
    expect(legLabel("CI — TS/Bun (windows-2025) / Unit + Coverage — windows-2025")).toBe(
      "windows-2025 (push)",
    );
  });

  test("ignores every other check run, including the never-retrying Linux leg", () => {
    for (const name of [
      "CI — TS/Bun (ubuntu-24.04) / Unit + Coverage — ubuntu-24.04",
      "PR quality — TS/Bun (ubuntu-24.04) / Unit + Coverage — ubuntu-24.04",
      // The name a SKIPPED matrix job reports: GitHub never expands it.
      `PR quality — Cross-platform (\${{ matrix.label }})`,
      "CI — TS/Bun (windows-2025) / Coverage — Vault (windows-2025)",
      "E2E Desktop — macos-15",
      "PR quality — required gates",
    ]) {
      expect(legLabel(name)).toBeUndefined();
    }
  });
});

// ── Runs and check runs ────────────────────────────────────────────────────────────────────────

function runJson(
  id: number,
  event: string,
  conclusion: string | null,
  created: string,
  status = "completed",
) {
  return {
    id,
    event,
    status,
    conclusion,
    check_suite_id: id * 10,
    created_at: created,
    html_url: `https://github.com/o/r/actions/runs/${String(id)}`,
  };
}

describe("parseWorkflowRuns + selectRuns", () => {
  const pages = [
    {
      total_count: 6,
      workflow_runs: [
        runJson(1, "pull_request", "success", "2026-10-16T10:00:00Z"),
        runJson(2, "push", "failure", "2026-10-15T10:00:00Z"),
        runJson(3, "pull_request", "cancelled", "2026-10-15T09:00:00Z"),
      ],
    },
    {
      total_count: 6,
      workflow_runs: [
        runJson(4, "pull_request", null, "2026-10-16T11:00:00Z", "in_progress"),
        runJson(5, "workflow_dispatch", "success", "2026-10-15T08:00:00Z"),
        runJson(6, "push", "success", "2026-10-01T08:00:00Z"),
        { id: "not-a-run" },
      ],
    },
  ];

  test("reads every page and drops malformed entries", () => {
    expect(parseWorkflowRuns(pages).map((r) => r.id)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("keeps finished push/pull_request runs in the window; counts what it skipped", () => {
    const { kept, skipped } = selectRuns(parseWorkflowRuns(pages), "2026-10-10T00:00:00Z");
    expect(kept.map((r) => r.id)).toEqual([1, 2]);
    // cancelled (3), unfinished (4), another event (5), older than the window (6)
    expect(skipped).toBe(4);
  });
});

describe("parseCheckRuns", () => {
  test("reads name, conclusion, URL and annotation count from every page", () => {
    const out = parseCheckRuns([
      {
        total_count: 2,
        check_runs: [
          {
            id: 11,
            name: "PR quality — Cross-platform (macos-15)",
            status: "completed",
            conclusion: "success",
            html_url: "https://github.com/o/r/actions/runs/1/job/11",
            output: { annotations_count: 3 },
          },
          { id: 12, name: "broken" },
        ],
      },
    ]);
    expect(out).toEqual([
      {
        id: 11,
        name: "PR quality — Cross-platform (macos-15)",
        conclusion: "success",
        url: "https://github.com/o/r/actions/runs/1/job/11",
        annotationsCount: 3,
      },
    ]);
  });
});

// ── aggregateFlakyTests ────────────────────────────────────────────────────────────────────────

function obs(name: string, file?: string, failureType?: string) {
  return {
    format: file === undefined ? ("legacy" as const) : ("structured" as const),
    file,
    line: file === undefined ? undefined : 10,
    name,
    failureType,
  };
}

let jobSeq = 0;
function leg(
  at: string,
  tests: ReturnType<typeof obs>[],
  opts: { leg?: string; event?: "pull_request" | "push" } = {},
): LegResult {
  jobSeq += 1;
  return {
    url: `https://github.com/o/r/actions/runs/1/job/${String(jobSeq)}`,
    leg: opts.leg ?? "windows-2025, 2/2",
    event: opts.event ?? "pull_request",
    runCreatedAt: at,
    retried: true,
    masked: true,
    unverified: 0,
    tests,
  };
}

describe("aggregateFlakyTests", () => {
  const A = obs("a > times out", "pkg/a.test.ts", "TimeoutError");
  const B = obs("b > flips", "pkg/b.test.ts", "AssertionError");

  test("one row per test: leg runs, the PR/push split, legs, and first/last seen", () => {
    const rows = aggregateFlakyTests([
      leg("2026-10-12T10:00:00Z", [A]),
      leg("2026-10-16T10:00:00Z", [A, B], { leg: "windows-2025 (push)", event: "push" }),
      leg("2026-10-14T10:00:00Z", [A], { leg: "macos-15" }),
    ]);
    const [a, b] = rows;
    expect(a).toMatchObject({
      name: "a > times out",
      file: "pkg/a.test.ts",
      jobs: 3,
      pullRequestJobs: 2,
      pushJobs: 1,
      firstSeen: "2026-10-12T10:00:00Z",
      lastSeen: "2026-10-16T10:00:00Z",
      failureTypes: ["TimeoutError"],
    });
    expect(a?.legs).toEqual([
      { leg: "macos-15", jobs: 1 },
      { leg: "windows-2025 (push)", jobs: 1 },
      { leg: "windows-2025, 2/2", jobs: 1 },
    ]);
    expect(b?.jobs).toBe(1);
  });

  test("sorts by leg runs, then by last seen, newest first", () => {
    const C = obs("c > newer", "pkg/c.test.ts");
    const rows = aggregateFlakyTests([
      leg("2026-10-11T00:00:00Z", [A]),
      leg("2026-10-12T00:00:00Z", [A]),
      leg("2026-10-13T00:00:00Z", [B]),
      leg("2026-10-15T00:00:00Z", [C]),
    ]);
    expect(rows.map((r) => r.name)).toEqual(["a > times out", "c > newer", "b > flips"]);
  });

  test("keeps the three newest example jobs", () => {
    const legs = [11, 12, 13, 14].map((d) => leg(`2026-10-${String(d)}T00:00:00Z`, [A]));
    const [row] = aggregateFlakyTests(legs);
    expect(row?.examples.map((e) => e.at)).toEqual([
      "2026-10-14T00:00:00Z",
      "2026-10-13T00:00:00Z",
      "2026-10-12T00:00:00Z",
    ]);
    expect(row?.examples[0]?.url).toBe(legs[3]?.url);
  });

  test("folds a legacy (no-file) row into the one structured row with the same name", () => {
    const legacyA = obs("a > times out");
    const rows = aggregateFlakyTests([
      leg("2026-10-11T00:00:00Z", [legacyA]),
      leg("2026-10-15T00:00:00Z", [A]),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ file: "pkg/a.test.ts", jobs: 2 });
    expect(rows[0]?.firstSeen).toBe("2026-10-11T00:00:00Z");
  });

  test("keeps a legacy row separate when two files have a test of that name", () => {
    const dupName = obs("shared > name", "pkg/one.test.ts");
    const dupName2 = obs("shared > name", "pkg/two.test.ts");
    const rows = aggregateFlakyTests([
      leg("2026-10-11T00:00:00Z", [obs("shared > name")]),
      leg("2026-10-12T00:00:00Z", [dupName]),
      leg("2026-10-13T00:00:00Z", [dupName2]),
    ]);
    expect(rows).toHaveLength(3);
    expect(rows.some((r) => r.file === undefined)).toBe(true);
  });

  test("a leg run counts a test once even if it was listed twice", () => {
    const [row] = aggregateFlakyTests([leg("2026-10-11T00:00:00Z", [A, A])]);
    expect(row?.jobs).toBe(1);
  });
});

// ── renderIssueBody ────────────────────────────────────────────────────────────────────────────

const CTX: ReportContext = {
  repo: "nimbus-agent/Nimbus",
  days: 7,
  since: "2026-10-10T05:41:00Z",
  until: "2026-10-17T05:41:00Z",
  runs: { pullRequest: 67, push: 32, skipped: 30 },
  legsRan: 260,
  legsRead: 250,
  legsRetried: 41,
  legsMasked: 33,
  legsFlaky: 3,
  unverified: 3,
  apiCalls: 312,
  runUrl: "https://github.com/nimbus-agent/Nimbus/actions/runs/99",
};

function row(name: string, overrides: Partial<FlakyRow> = {}): FlakyRow {
  return {
    file: "packages/gateway/test/a.test.ts",
    line: 42,
    name,
    failureTypes: ["TimeoutError"],
    jobs: 3,
    pullRequestJobs: 2,
    pushJobs: 1,
    legs: [
      { leg: "windows-2025, 2/2", jobs: 2 },
      { leg: "macos-15", jobs: 1 },
    ],
    firstSeen: "2026-10-11T08:00:00Z",
    lastSeen: "2026-10-16T09:30:00Z",
    examples: [
      {
        url: "https://github.com/nimbus-agent/Nimbus/actions/runs/1/job/2",
        at: "2026-10-16T09:30:00Z",
      },
    ],
    ...overrides,
  };
}

describe("renderIssueBody", () => {
  test("renders one table row per test, the file linked to its line and the name in a code span", () => {
    const body = renderIssueBody([row("toolgen.revoke > a saved tool does NOT come back")], CTX);
    expect(body).toContain(
      "| 1 | `toolgen.revoke > a saved tool does NOT come back`<br>`TimeoutError` | [`packages/gateway/test/a.test.ts:42`](https://github.com/nimbus-agent/Nimbus/blob/main/packages/gateway/test/a.test.ts#L42) | 3 | 2 / 1 | `windows-2025, 2/2` ×2<br>`macos-15` ×1 | 2026-10-16 | 2026-10-11 | [10-16](https://github.com/nimbus-agent/Nimbus/actions/runs/1/job/2) |",
    );
    expect(body).toContain("**1 flaky test** across 3 leg runs.");
  });

  test("a test with no known file shows a dash, not a broken link", () => {
    const body = renderIssueBody(
      [row("legacy > test", { file: undefined, line: undefined, failureTypes: [] })],
      CTX,
    );
    expect(body).toContain("| 1 | `legacy > test` | — | 3 |");
  });

  test("escapes pipes and backticks so a test name cannot break the table", () => {
    const body = renderIssueBody([row("a | b `c`")], CTX);
    // GFM strips ONE space from each end of a code span, so the padding must be on both sides.
    expect(body).toContain("| 1 | `` a \\| b `c` ``<br>");
  });

  test("shows the top 40 rows and says how many more there are", () => {
    const rows = Array.from({ length: TOP_ROWS + 5 }, (_, i) => row(`t${String(i)}`));
    const body = renderIssueBody(rows, CTX);
    expect(body).toContain(`| ${String(TOP_ROWS)} | \`t${String(TOP_ROWS - 1)}\``);
    expect(body).not.toContain(`\`t${String(TOP_ROWS)}\``);
    expect(body).toContain("Showing the top 40; 5 more are not listed.");
  });

  test("stays under GitHub's 65,536-character issue-body limit", () => {
    const rows = Array.from({ length: TOP_ROWS }, (_, i) => row(`${"x".repeat(3000)}${String(i)}`));
    const body = renderIssueBody(rows, CTX);
    expect(body.length).toBeLessThanOrEqual(65_536);
    expect(body).toContain("more are not listed");
  });

  test("the footer states the window, the scan, the counting rule, the cap and the run", () => {
    const body = renderIssueBody([row("x")], CTX);
    expect(body).toContain("2026-10-10 05:41 → 2026-10-17 05:41 UTC (7 days)");
    expect(body).toContain(
      "99 `CI` runs (67 pull_request, 32 push); 30 cancelled or unfinished runs skipped",
    );
    expect(body).toContain("260 macOS/Windows test legs ran");
    expect(body).toContain("41 retried, and 33 were green only because of the retry");
    expect(body).toContain("3 such annotations were not counted");
    expect(body).toContain("at most 10 warning annotations per step");
    expect(body).toContain(
      "[workflow run](https://github.com/nimbus-agent/Nimbus/actions/runs/99)",
    );
    expect(body).toContain("312 GitHub API requests");
  });

  test("a local dry run says so instead of linking a run", () => {
    const body = renderIssueBody([], { ...CTX, runUrl: undefined });
    expect(body).toContain("a local dry run");
  });

  test("says plainly when nothing was flaky", () => {
    const body = renderIssueBody([], CTX);
    expect(body).toContain("No test failed on a first attempt and passed on its retry");
    expect(body).not.toContain("| # |");
  });
});

describe("renderCloseComment", () => {
  test("names the window, the scan and the run", () => {
    const c = renderCloseComment(CTX);
    expect(c).toContain("last 7 days");
    expect(c).toContain("99 runs, 260 legs");
    expect(c).toContain("https://github.com/nimbus-agent/Nimbus/actions/runs/99");
  });
});

// ── planIssueAction ────────────────────────────────────────────────────────────────────────────

describe("planIssueAction", () => {
  const exact = { number: 12, title: ISSUE_TITLE };
  const similar = { number: 5, title: `${ISSUE_TITLE} (old)` };

  test("flaky rows and no open issue → create", () => {
    expect(planIssueAction([similar], true)).toEqual({ kind: "create" });
  });

  test("flaky rows and an open issue with exactly that title → edit it", () => {
    expect(planIssueAction([similar, exact], true)).toEqual({ kind: "edit", number: 12 });
  });

  test("nothing flaky and an open issue → close it; nothing open → do nothing", () => {
    expect(planIssueAction([exact], false)).toEqual({ kind: "close", number: 12 });
    expect(planIssueAction([similar], false)).toEqual({ kind: "none" });
  });

  test("two open issues with the title → the oldest one is kept up to date", () => {
    expect(planIssueAction([exact, { number: 7, title: ISSUE_TITLE }], true)).toEqual({
      kind: "edit",
      number: 7,
    });
  });
});

// ── parseArgs ───────────────────────────────────────────────────────────────────────────────────

describe("parseArgs", () => {
  test("defaults to a 7-day dry run", () => {
    expect(parseArgs([])).toEqual({ days: 7, writeIssue: false });
  });

  test("reads --days in both spellings and --write-issue", () => {
    expect(parseArgs(["--days", "3"])).toEqual({ days: 3, writeIssue: false });
    expect(parseArgs(["--days=14", "--write-issue"])).toEqual({ days: 14, writeIssue: true });
  });

  test("rejects a bad window or an unknown flag with a message", () => {
    for (const argv of [
      ["--days", "0"],
      ["--days", "x"],
      ["--days", "31"],
      ["--days"],
      ["--nope"],
    ]) {
      expect(typeof parseArgs(argv)).toBe("string");
    }
  });
});

// ── createGh ────────────────────────────────────────────────────────────────────────────────────

function fakeSpawn(results: SpawnResult[]) {
  const calls: { args: readonly string[]; stdin: string | undefined }[] = [];
  const spawn = async (args: readonly string[], stdin: string | undefined) => {
    calls.push({ args, stdin });
    const next = results.shift();
    if (next === undefined) throw new Error("unexpected gh call");
    return next;
  };
  return { spawn, calls };
}

const noSleep = async () => {};

describe("createGh", () => {
  test("pages() runs `gh api --paginate --slurp` and counts one request per page", async () => {
    const { spawn, calls } = fakeSpawn([{ code: 0, stdout: "[[1],[2]]", stderr: "" }]);
    const gh = createGh(spawn, noSleep);
    expect(await gh.pages("repos/o/r/x?per_page=100")).toEqual([[1], [2]]);
    expect(calls[0]?.args).toEqual(["api", "--paginate", "--slurp", "repos/o/r/x?per_page=100"]);
    expect(gh.calls()).toBe(2);
  });

  test("retries a server error once", async () => {
    const { spawn } = fakeSpawn([
      { code: 1, stdout: "", stderr: "gh: Server Error (HTTP 502)" },
      { code: 0, stdout: "[[]]", stderr: "" },
    ]);
    const gh = createGh(spawn, noSleep);
    expect(await gh.pages("p")).toEqual([[]]);
    expect(gh.calls()).toBe(2);
  });

  test("does not retry a client error, and the error says what failed", async () => {
    const { spawn, calls } = fakeSpawn([
      { code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" },
    ]);
    const gh = createGh(spawn, noSleep);
    await expect(gh.pages("repos/o/r/missing")).rejects.toThrow(/repos\/o\/r\/missing.*HTTP 404/);
    expect(calls).toHaveLength(1);
  });

  test("rejects output that is not an array of pages", async () => {
    const { spawn } = fakeSpawn([{ code: 0, stdout: "not json", stderr: "" }]);
    await expect(createGh(spawn, noSleep).pages("p")).rejects.toThrow(/non-JSON/);
  });

  test("run() passes stdin through and counts one request", async () => {
    const { spawn, calls } = fakeSpawn([{ code: 0, stdout: "ok\n", stderr: "" }]);
    const gh = createGh(spawn, noSleep);
    expect(await gh.run(["issue", "edit", "1", "--body-file", "-"], "BODY")).toBe("ok\n");
    expect(calls[0]?.stdin).toBe("BODY");
    expect(gh.calls()).toBe(1);
  });
});

// ── collectLegs (a fake gh serving canned pages) ───────────────────────────────────────────────

function fakeGh(byPath: Record<string, unknown[]>): Gh & { requested: string[] } {
  const requested: string[] = [];
  let calls = 0;
  return {
    requested,
    pages: async (path) => {
      requested.push(path);
      const pages = byPath[path];
      if (pages === undefined) throw new Error(`no fixture for ${path}`);
      calls += pages.length;
      return pages;
    },
    run: async () => {
      calls += 1;
      return "";
    },
    calls: () => calls,
  };
}

function checkRun(id: number, name: string, conclusion: string | null, annotationsCount: number) {
  return {
    id,
    name,
    status: conclusion === null ? "in_progress" : "completed",
    conclusion,
    html_url: `https://github.com/o/r/actions/runs/1/job/${String(id)}`,
    output: { annotations_count: annotationsCount },
  };
}

describe("collectLegs", () => {
  const SINCE = "2026-10-10T00:00:00Z";
  const runsPath = `repos/o/r/actions/workflows/ci.yml/runs?created=${encodeURIComponent(`>=${SINCE}`)}&per_page=100&exclude_pull_requests=true`;
  const gh = fakeGh({
    [runsPath]: [
      {
        workflow_runs: [
          runJson(1, "pull_request", "success", "2026-10-16T10:00:00Z"),
          runJson(2, "push", "failure", "2026-10-15T10:00:00Z"),
          runJson(3, "pull_request", "cancelled", "2026-10-15T09:00:00Z"),
        ],
      },
    ],
    "repos/o/r/check-suites/10/check-runs?per_page=100&filter=all": [
      {
        check_runs: [
          checkRun(101, "PR quality — Cross-platform (windows-2025, 2/2)", "success", 6),
          checkRun(102, "PR quality — Cross-platform (macos-15)", "success", 0),
          checkRun(103, "PR quality — Cross-platform (windows-2025, 1/2)", "skipped", 0),
          checkRun(
            104,
            "PR quality — TS/Bun (ubuntu-24.04) / Unit + Coverage — ubuntu-24.04",
            "success",
            16,
          ),
        ],
      },
    ],
    "repos/o/r/check-suites/20/check-runs?per_page=100&filter=all": [
      {
        check_runs: [
          checkRun(
            201,
            "CI — TS/Bun (windows-2025) / Unit + Coverage — windows-2025",
            "failure",
            9,
          ),
          checkRun(202, "CI — TS/Bun (macos-15) / Unit + Coverage — macos-15", null, 0),
        ],
      },
    ],
    "repos/o/r/check-runs/101/annotations?per_page=100": [[MASKED, STRUCTURED, ...NOISE]],
    "repos/o/r/check-runs/201/annotations?per_page=100": [[...NOISE, LEGACY, LEGACY]],
  });

  test("lists runs, then legs, then reads annotations only where a retry could be", async () => {
    const out = await collectLegs(gh, "o/r", SINCE);
    expect(out.runs).toEqual({ pullRequest: 1, push: 1, skipped: 1 });
    // 101 and 102 and 201 ran; 103 was skipped and 202 has not finished.
    expect(out.legsRan).toBe(3);
    // 102 had no annotations, 104 is not a retrying leg: neither was read.
    expect(gh.requested.filter((p) => p.includes("/annotations"))).toEqual([
      "repos/o/r/check-runs/101/annotations?per_page=100",
      "repos/o/r/check-runs/201/annotations?per_page=100",
    ]);
    const byUrl = new Map(out.legs.map((l) => [l.url, l]));
    const pr = byUrl.get("https://github.com/o/r/actions/runs/1/job/101");
    expect(pr).toMatchObject({ leg: "windows-2025, 2/2", event: "pull_request", masked: true });
    expect(pr?.tests.map((t) => t.name)).toEqual([
      "toolgen.revoke > a saved tool does NOT come back",
    ]);
    const push = byUrl.get("https://github.com/o/r/actions/runs/1/job/201");
    expect(push).toMatchObject({
      leg: "windows-2025 (push)",
      event: "push",
      masked: false,
      unverified: 1,
    });
    expect(push?.runCreatedAt).toBe("2026-10-15T10:00:00Z");
    expect(gh.calls()).toBe(5);
  });
});

// ── applyIssueAction ───────────────────────────────────────────────────────────────────────────

function recordingGh(): Gh & { ran: { args: readonly string[]; stdin: string | undefined }[] } {
  const ran: { args: readonly string[]; stdin: string | undefined }[] = [];
  return {
    ran,
    pages: async () => [],
    run: async (args, stdin) => {
      ran.push({ args, stdin });
      return "https://github.com/o/r/issues/9\n";
    },
    calls: () => ran.length,
  };
}

describe("applyIssueAction", () => {
  test("create: makes sure the label exists, then opens the issue with the body on stdin", async () => {
    const gh = recordingGh();
    await applyIssueAction(gh, "o/r", { kind: "create" }, "BODY", "unused");
    expect(gh.ran[0]?.args.slice(0, 3)).toEqual(["label", "create", ISSUE_LABEL]);
    expect(gh.ran[0]?.args).toContain("--force");
    expect(gh.ran[1]?.args).toEqual([
      "issue",
      "create",
      "--repo",
      "o/r",
      "--title",
      ISSUE_TITLE,
      "--label",
      ISSUE_LABEL,
      "--body-file",
      "-",
    ]);
    expect(gh.ran[1]?.stdin).toBe("BODY");
  });

  test("edit: replaces the body of the open issue", async () => {
    const gh = recordingGh();
    await applyIssueAction(gh, "o/r", { kind: "edit", number: 12 }, "BODY", "unused");
    expect(gh.ran[1]?.args).toEqual([
      "issue",
      "edit",
      "12",
      "--repo",
      "o/r",
      "--add-label",
      ISSUE_LABEL,
      "--body-file",
      "-",
    ]);
    expect(gh.ran[1]?.stdin).toBe("BODY");
  });

  test("close: closes the issue with a comment and creates no label", async () => {
    const gh = recordingGh();
    await applyIssueAction(gh, "o/r", { kind: "close", number: 12 }, "unused", "GONE");
    expect(gh.ran).toEqual([
      { args: ["issue", "close", "12", "--repo", "o/r", "--comment", "GONE"], stdin: undefined },
    ]);
  });

  test("none: touches nothing", async () => {
    const gh = recordingGh();
    await applyIssueAction(gh, "o/r", { kind: "none" }, "unused", "unused");
    expect(gh.ran).toEqual([]);
  });
});

// ── main ───────────────────────────────────────────────────────────────────────────────────────

describe("main", () => {
  const NOW = new Date("2026-10-17T05:41:00Z");
  const SINCE = "2026-10-10T05:41:00Z";
  const runsPath = `repos/o/r/actions/workflows/ci.yml/runs?created=${encodeURIComponent(`>=${SINCE}`)}&per_page=100&exclude_pull_requests=true`;

  function harness(issues: { number: number; title: string }[]) {
    const out: string[] = [];
    const summaries: string[] = [];
    const ran: { args: readonly string[]; stdin: string | undefined }[] = [];
    const base = fakeGh({
      [runsPath]: [
        { workflow_runs: [runJson(1, "pull_request", "success", "2026-10-16T10:00:00Z")] },
      ],
      "repos/o/r/check-suites/10/check-runs?per_page=100&filter=all": [
        { check_runs: [checkRun(101, "PR quality — Cross-platform (macos-15)", "success", 2)] },
      ],
      "repos/o/r/check-runs/101/annotations?per_page=100": [[MASKED, STRUCTURED]],
    });
    const gh: Gh = {
      pages: base.pages,
      calls: base.calls,
      run: async (args, stdin) => {
        ran.push({ args, stdin });
        return args[1] === "list" ? JSON.stringify(issues) : "";
      },
    };
    const deps = {
      gh,
      env: {
        REPO: "o/r",
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_REPOSITORY: "o/r",
        GITHUB_RUN_ID: "77",
      },
      now: NOW,
      print: (s: string) => out.push(s),
      appendSummary: async (s: string) => {
        summaries.push(s);
      },
    };
    return { deps, out, ran, summaries };
  }

  test("a dry run prints the body and writes nothing", async () => {
    const h = harness([]);
    expect(await main(["--days", "7"], h.deps)).toBe(0);
    const text = h.out.join("\n");
    expect(text).toContain("`toolgen.revoke > a saved tool does NOT come back`");
    expect(text).toContain("https://github.com/o/r/actions/runs/77");
    expect(text).toMatch(/3 GitHub API requests/);
    expect(h.ran).toEqual([]);
    expect(h.summaries).toHaveLength(1);
  });

  test("--write-issue edits the open issue in place", async () => {
    const h = harness([{ number: 4, title: ISSUE_TITLE }]);
    expect(await main(["--write-issue"], h.deps)).toBe(0);
    expect(h.ran.map((r) => r.args.slice(0, 2).join(" "))).toEqual([
      "issue list",
      "label create",
      "issue edit",
    ]);
    expect(h.ran[2]?.stdin).toContain("toolgen.revoke");
  });

  test("a usage error exits 2 without calling GitHub", async () => {
    const h = harness([]);
    expect(await main(["--days", "0"], h.deps)).toBe(2);
    expect(h.deps.gh.calls()).toBe(0);
  });

  test("an API failure exits 1 and never touches the issue", async () => {
    const h = harness([]);
    const failing: Gh = { ...h.deps.gh, pages: async () => Promise.reject(new Error("HTTP 502")) };
    expect(await main(["--write-issue"], { ...h.deps, gh: failing })).toBe(1);
    expect(h.ran).toEqual([]);
    expect(h.out.join("\n")).toContain("::error");
  });
});
