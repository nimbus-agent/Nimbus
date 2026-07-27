import { describe, expect, test } from "bun:test";

import { parseJobObservations, parseRunMeta, selectRuns } from "./collect.ts";

describe("parseRunMeta", () => {
  test("reads id, workflow name and run_started_at", () => {
    const m = parseRunMeta(
      '{"workflow_runs":[{"id":1,"name":"CI","run_started_at":"2026-07-27T10:00:00Z"}]}',
    );
    expect(m).toEqual([{ id: "1", name: "CI", runStartedAt: "2026-07-27T10:00:00Z" }]);
  });
  test("empty on malformed JSON — an unreadable list is never a finding", () => {
    expect(parseRunMeta("{nope")).toEqual([]);
  });
  test("skips entries missing any required field", () => {
    expect(parseRunMeta('{"workflow_runs":[{"id":"x","name":"CI","run_started_at":"t"}]}')).toEqual(
      [],
    );
  });
});

describe("selectRuns", () => {
  const run = (name: string, i: number) => ({ id: `${name}-${i}`, name, runStartedAt: "t" });

  test("caps per WORKFLOW, so a busy workflow cannot starve a quiet one", () => {
    // The whole reason this exists: a flat per-repo cap gave CI only 4 of 30
    // runs, which made every ratchet threshold above 5 unreachable.
    const runs = [
      ...Array.from({ length: 40 }, (_, i) => run("Scorecard", i)),
      ...Array.from({ length: 40 }, (_, i) => run("CI", i)),
    ];
    const sel = selectRuns(runs);
    expect(sel.filter((r) => r.name === "CI")).toHaveLength(12);
    expect(sel.filter((r) => r.name === "Scorecard")).toHaveLength(12);
  });

  test("keeps every run of a workflow that has fewer than the cap", () => {
    expect(selectRuns([run("CI", 1), run("CI", 2)])).toHaveLength(2);
  });

  test("preserves API order (newest first) within a workflow", () => {
    const sel = selectRuns(Array.from({ length: 20 }, (_, i) => run("CI", i)));
    expect(sel[0]?.id).toBe("CI-0");
  });
});

describe("parseJobObservations", () => {
  const t0 = "2026-07-27T10:00:00Z";
  const job = (over: Record<string, unknown> = {}) => ({
    name: "Unit + Coverage",
    conclusion: "success",
    created_at: "2026-07-27T10:00:00Z",
    started_at: "2026-07-27T10:02:00Z",
    completed_at: "2026-07-27T10:12:00Z",
    ...over,
  });
  const payload = (jobs: unknown[]) => JSON.stringify({ jobs });

  test("exec is completed minus started", () => {
    const [o] = parseJobObservations(payload([job()]), "Nimbus", "CI", t0);
    expect(o?.exec).toBe(10);
  });

  test("queue is started minus CREATED — DAG-free contention", () => {
    const [o] = parseJobObservations(payload([job()]), "Nimbus", "CI", t0);
    expect(o?.queue).toBe(2);
  });

  test("dagWait is created minus run start, so a needs-blocked job is not charged as queue", () => {
    // A job gated by `needs` is CREATED only once its dependencies finish, so
    // charging created-minus-run-start to queue would bill it for their work.
    const [o] = parseJobObservations(
      payload([
        job({
          created_at: "2026-07-27T10:20:00Z",
          started_at: "2026-07-27T10:21:00Z",
          completed_at: "2026-07-27T10:26:00Z",
        }),
      ]),
      "Nimbus",
      "CI",
      t0,
    );
    expect(o?.dagWait).toBe(20);
    expect(o?.queue).toBe(1);
    expect(o?.exec).toBe(5);
  });

  test("a root job has zero dagWait", () => {
    const [o] = parseJobObservations(payload([job()]), "Nimbus", "CI", t0);
    expect(o?.dagWait).toBe(0);
  });

  test("skips jobs that did not succeed — a failed job's duration is meaningless", () => {
    expect(
      parseJobObservations(payload([job({ conclusion: "failure" })]), "Nimbus", "CI", t0),
    ).toEqual([]);
  });

  test("skips jobs with a missing timestamp rather than emitting NaN", () => {
    expect(
      parseJobObservations(payload([job({ completed_at: null })]), "Nimbus", "CI", t0),
    ).toEqual([]);
  });

  test("empty on malformed JSON", () => {
    expect(parseJobObservations("{nope", "Nimbus", "CI", t0)).toEqual([]);
  });

  test("carries repo and workflow through onto every observation", () => {
    const [o] = parseJobObservations(payload([job()]), "nimbus-sdk", "Release", t0);
    expect(o?.repo).toBe("nimbus-sdk");
    expect(o?.workflow).toBe("Release");
  });
});
