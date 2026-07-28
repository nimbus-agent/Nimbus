import { describe, expect, test } from "bun:test";

import { assessMainHealth, type PushRun } from "./main-health.ts";

const NOW = Date.parse("2026-07-28T18:00:00Z");
const HOUR = 3_600_000;

const run = (conclusion: string | null, hoursAgo: number, sha = "abc1234"): PushRun => ({
  conclusion,
  createdAt: new Date(NOW - hoursAgo * HOUR).toISOString(),
  headSha: sha,
});

describe("assessMainHealth", () => {
  test("a green head is not red", () => {
    const h = assessMainHealth([run("success", 1), run("success", 3)], NOW);
    expect(h.red).toBe(false);
    expect(h.consecutiveFailures).toBe(0);
    expect(h.redSinceIso).toBeNull();
  });

  test("a failing head is red and counts the streak", () => {
    const h = assessMainHealth(
      [run("failure", 1, "aaa"), run("failure", 3, "bbb"), run("success", 5, "ccc")],
      NOW,
    );
    expect(h.red).toBe(true);
    expect(h.consecutiveFailures).toBe(2);
    expect(h.redForHours).toBe(3); // since the OLDEST run in the failing streak
  });

  // The real incident: main was red for 4.75h across six consecutive pushes and
  // nothing noticed, because the collector only ever fetched successful runs.
  test("reports a long multi-push outage", () => {
    const runs = [0.25, 1, 2, 3, 4, 4.75].map((h, i) => run("failure", h, `sha${i}`));
    const h = assessMainHealth(runs, NOW);
    expect(h.red).toBe(true);
    expect(h.consecutiveFailures).toBe(6);
    expect(h.redForHours).toBeCloseTo(4.75, 1);
  });

  test("in-progress runs are ignored, not treated as failures", () => {
    // conclusion === null means still running. Counting it red would make the
    // gate flap every time a push is mid-flight.
    const h = assessMainHealth([run(null, 0.1), run("success", 2)], NOW);
    expect(h.red).toBe(false);
    expect(h.consecutiveFailures).toBe(0);
  });

  test("a cancelled run is not a failure", () => {
    // Cancellations are usually concurrency evictions, not breakage. Treating
    // them as red would manufacture outages from ordinary CI behaviour.
    const h = assessMainHealth([run("cancelled", 1), run("success", 2)], NOW);
    expect(h.red).toBe(false);
  });

  test("a cancelled run does not break a real failing streak either", () => {
    const h = assessMainHealth(
      [run("failure", 1), run("cancelled", 2), run("failure", 3), run("success", 4)],
      NOW,
    );
    expect(h.red).toBe(true);
    expect(h.consecutiveFailures).toBe(2); // the two failures; the cancel is skipped
  });

  test("no completed runs yields unknown, not green", () => {
    // Absence of evidence must not read as health — the whole point of the gate.
    const h = assessMainHealth([run(null, 0.1)], NOW);
    expect(h.red).toBe(false);
    expect(h.known).toBe(false);
  });

  test("an empty list is unknown", () => {
    const h = assessMainHealth([], NOW);
    expect(h.known).toBe(false);
    expect(h.red).toBe(false);
  });

  test("timed_out and startup_failure count as failures", () => {
    for (const c of ["timed_out", "startup_failure", "action_required"]) {
      expect(assessMainHealth([run(c, 1), run("success", 2)], NOW).red).toBe(true);
    }
  });
});
