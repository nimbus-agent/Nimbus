import { describe, expect, test } from "bun:test";

import { fileTimings, renderSummary, reportedTotalSeconds } from "./junit-slowest-files.ts";

// The shape Bun 1.3/1.4 emits: one top-level <testsuite> per file, one nested per `describe`.
const XML = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="4" assertions="4" failures="0" skipped="0" time="12.5">
  <testsuite name="a.test.ts" file="a.test.ts" tests="3" assertions="3" failures="0" skipped="0" time="2.25" hostname="vm">
    <testsuite name="outer" file="a.test.ts" line="3" tests="3" time="2.2">
      <testsuite name="inner" file="a.test.ts" line="4" tests="1" time="9.9">
        <testcase name="x" classname="inner" time="0.1" file="a.test.ts" line="5" assertions="1" />
      </testsuite>
      <testcase name="y" classname="outer" time="0.1" file="a.test.ts" line="8" assertions="1" />
    </testsuite>
  </testsuite>
  <testsuite name="b.test.ts" file="b.test.ts" tests="1" assertions="1" failures="0" skipped="0" time="7.5" hostname="vm">
    <testcase name="z" classname="b" time="7.5" file="b.test.ts" line="1" assertions="1" />
  </testsuite>
  <testsuite name="empty.test.ts" file="empty.test.ts" tests="0" time="0" />
</testsuites>
`;

describe("fileTimings", () => {
  test("reads only the per-file (top-level) suites, never the nested describe suites", () => {
    // The nested `inner` suite claims 9.9 s; counting it would rank a.test.ts first.
    expect(fileTimings(XML)).toEqual([
      { file: "a.test.ts", seconds: 2.25, tests: 3 },
      { file: "b.test.ts", seconds: 7.5, tests: 1 },
      { file: "empty.test.ts", seconds: 0, tests: 0 },
    ]);
  });

  test("an empty or report-less document yields no timings", () => {
    expect(fileTimings("")).toEqual([]);
    expect(fileTimings('<testsuites time="1"></testsuites>')).toEqual([]);
  });
});

describe("reportedTotalSeconds", () => {
  test("reads the root time attribute", () => {
    expect(reportedTotalSeconds(XML)).toBe(12.5);
  });

  test("is undefined without a root element", () => {
    expect(reportedTotalSeconds("<testsuite time='1'/>")).toBeUndefined();
  });
});

describe("renderSummary", () => {
  test("ranks slowest first and honours --top", () => {
    const md = renderSummary(fileTimings(XML), { top: 1, title: "T", totalSeconds: 12.5 });
    expect(md).toContain("### T");
    expect(md).toContain("3 files · per-file sum 10 s · run total reported by Bun: 13 s");
    expect(md).toContain("| 1 | `b.test.ts` | 7.5 | 76.9% | 1 |");
    expect(md).not.toContain("`a.test.ts`");
  });

  test("does not divide by zero on an all-zero report", () => {
    const md = renderSummary([{ file: "z.test.ts", seconds: 0, tests: 0 }], { top: 5, title: "T" });
    expect(md).toContain("| 1 | `z.test.ts` | 0.0 | — | 0 |");
  });
});
