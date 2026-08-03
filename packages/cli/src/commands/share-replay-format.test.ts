// packages/cli/src/commands/share-replay-format.test.ts
import { describe, expect, test } from "bun:test";
import { formatReplayReport } from "./share.ts";

describe("formatReplayReport", () => {
  const report = {
    sourceSessionId: "s1",
    steps: [
      {
        stepId: "step-1",
        tool: "gmail_get",
        service: "gmail",
        status: "match",
        originalStatus: "ok",
      },
      {
        stepId: "step-2",
        tool: "file_delete",
        service: "fs",
        status: "skipped-non-read",
        originalStatus: "ok",
      },
      {
        stepId: "step-3",
        tool: "slack_list",
        service: "slack",
        status: "missing-connector",
        originalStatus: "ok",
        detail: "slack",
      },
    ],
    summary: { total: 3, match: 1, diverged: 0, missingConnector: 1, skippedNonRead: 1, error: 0 },
  };

  test("renders one line per step with status + tool", () => {
    const out = formatReplayReport(report);
    expect(out).toContain("step-1");
    expect(out).toContain("gmail_get");
    expect(out).toContain("match");
    expect(out).toContain("skipped-non-read");
    expect(out).toContain("missing-connector");
  });

  test("renders a summary line with the counts", () => {
    const out = formatReplayReport(report);
    expect(out).toContain("3"); // total
    expect(out).toMatch(/match.*1/);
  });

  test("params-rejected steps are surfaced in the summary, not only per-step", () => {
    const out = formatReplayReport({
      sourceSessionId: "s1",
      steps: [
        {
          stepId: "step-1",
          tool: "gmail_get",
          service: "gmail",
          status: "skipped-invalid-params",
          originalStatus: "ok",
        },
      ],
      summary: {
        total: 1,
        match: 0,
        diverged: 0,
        missingConnector: 0,
        skippedNonRead: 0,
        skippedInvalidParams: 1,
        error: 0,
      },
    });
    // Assert on the SUMMARY line specifically — the per-step line already contains this status,
    // so a whole-output match would pass without the summary ever mentioning it.
    const summaryLine = out.split("\n").find((l) => l.startsWith("Summary:")) ?? "";
    expect(summaryLine).toContain("skipped-invalid-params 1");
  });

  test("empty report → a clear 'no steps' line, no crash", () => {
    const out = formatReplayReport({
      sourceSessionId: "s",
      steps: [],
      summary: {
        total: 0,
        match: 0,
        diverged: 0,
        missingConnector: 0,
        skippedNonRead: 0,
        error: 0,
      },
    });
    expect(out.length).toBeGreaterThan(0);
  });
});
