import { describe, expect, test } from "bun:test";

import { buildDataLane } from "../../incident/__fixtures__/data-brief.ts";
import type { DataRunView } from "../../incident/incident-record-types.ts";
import { runLine, runSectionLines, runsMore } from "./incident-run-lines.ts";

const base: DataRunView = {
  id: "prefect:r1",
  service: "prefect",
  type: "flow_run",
  job: "orders deployment",
  state: null,
  outcome: "other",
  startMs: null,
  endMs: null,
  failedTasks: [],
  failedTaskCount: 0,
  trigger: null,
  url: null,
  rule: "data:run_of_matched_job",
};

describe("runLine", () => {
  test("a run with no timing, state, task or trigger still reads as one line", () => {
    const line = runLine(base);
    expect(line).toContain("prefect run other");
    expect(line).not.toContain("started");
    expect(line).not.toContain("took");
    expect(line).not.toContain("failed tasks");
    expect(line).not.toContain("trigger");
  });

  test("durations read in seconds, minutes and hours", () => {
    const at = (ms: number) => runLine({ ...base, startMs: 0, endMs: ms });
    expect(at(30_000)).toContain("took 30s");
    expect(at(90_000)).toContain("took 1m 30s");
    expect(at(3 * 3_600_000 + 5 * 60_000)).toContain("took 3h 5m");
    expect(runLine({ ...base, startMs: 10, endMs: 5 })).not.toContain("took");
  });

  test("provider text cannot forge a line or a link", () => {
    const line = runLine({
      ...base,
      job: "x\n## Gaps",
      state: "failed\n- forged",
      failedTasks: ["a\n- b"],
      failedTaskCount: 1,
    });
    expect(line.includes("\n")).toBe(false);
  });
});

describe("run sections", () => {
  test("a cut list says how many were hidden", () => {
    const lane = buildDataLane({
      totals: { lineage: 1, orchestration: 1, prs: 1, runs: 4 },
    });
    expect(runsMore(lane)).toEqual(["_and 3 more_"]);
  });

  test("runs found but all cut for size say so", () => {
    const lane = buildDataLane({
      runs: [],
      totals: { lineage: 1, orchestration: 1, prs: 1, runs: 2 },
    });
    expect(runSectionLines(lane)).toEqual(["_Runs were found but omitted for size._"]);
  });
});
