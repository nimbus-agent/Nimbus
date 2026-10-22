import { describe, expect, test } from "bun:test";
import { FLEET_ELIGIBILITY } from "../ipc/agents-rpc.ts";
import { checkPackFleetJobs } from "./pack-job-check.ts";

function job(name: string, lines: readonly string[]): string {
  return ["[[fleet.job]]", `name = "${name}"`, ...lines, ""].join("\n");
}

const ineligibleAgent = ((): string => {
  const hit = Object.entries(FLEET_ELIGIBILITY).find(([, v]) => v !== "eligible");
  if (hit === undefined) throw new Error("no ineligible agent in FLEET_ELIGIBILITY");
  return hit[0].replace(/^agents\./, "");
})();

describe("checkPackFleetJobs", () => {
  test("accepts an eligible job", () => {
    const text = job("daily", ['agent = "standup"', "interval_seconds = 86400"]);
    expect(checkPackFleetJobs(text)).toEqual([]);
  });

  test("refuses an ineligible or unknown agent", () => {
    for (const agent of ["nope", ineligibleAgent]) {
      const problems = checkPackFleetJobs(
        job("j1", [`agent = "${agent}"`, "interval_seconds = 60"]),
      );
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain("j1");
      expect(problems[0]).toContain("is not fleet-eligible");
    }
  });

  test("refuses federation params, with or without sweep", () => {
    for (const fed of ['namespace = "x"', 'namespaces = "a,b"']) {
      for (const sweep of [[], ['sweep = "paths"', "max_subjects = 5"]]) {
        const problems = checkPackFleetJobs(
          job("fed", ['agent = "ownership"', "interval_seconds = 60", fed, ...sweep]),
        );
        expect(problems).toHaveLength(1);
        expect(problems[0]).toContain("namespace/namespaces are not allowed in a pack job");
      }
    }
  });

  test("refuses what the fleet parser refuses", () => {
    const cases: readonly string[] = [
      job("a", ["interval_seconds = 60"]),
      job("b", ['agent = "standup"', "interval_seconds = 0"]),
      job("c", ['agent = "standup"', "interval_seconds = 60", "max_subjects = 5"]),
      job("d", ['agent = "standup"', "interval_seconds = 60"]) +
        job("d", ['agent = "standup"', "interval_seconds = 60"]),
    ];
    const expected = ["requires agent", "interval_seconds > 0", "without sweep", "duplicate name"];
    cases.forEach((text, i) => {
      const problems = checkPackFleetJobs(text);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(expected[i] as string);
    });
  });

  test("refuses an unsupported sweep", () => {
    const problems = checkPackFleetJobs(
      job("s", [
        'agent = "standup"',
        "interval_seconds = 60",
        'sweep = "services"',
        "max_subjects = 5",
      ]),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('cannot sweep "services"');
  });

  test("one cause, one problem", () => {
    const inel = checkPackFleetJobs(
      job("i", [
        `agent = "${ineligibleAgent}"`,
        "interval_seconds = 60",
        'sweep = "services"',
        "max_subjects = 5",
      ]),
    );
    expect(inel).toHaveLength(1);
    expect(inel[0]).toContain("is not fleet-eligible");
    const fed = checkPackFleetJobs(
      job("f", [
        'agent = "ownership"',
        "interval_seconds = 60",
        'sweep = "paths"',
        "max_subjects = 5",
        'namespace = "x"',
      ]),
    );
    expect(fed).toHaveLength(1);
    expect(fed[0]).toContain("namespace/namespaces are not allowed in a pack job");
    expect(fed[0]).not.toContain("a sweep stays local");
  });

  test("collects problems across jobs", () => {
    const bad = [
      'agent = "standup"',
      "interval_seconds = 60",
      'sweep = "services"',
      "max_subjects = 5",
    ];
    const problems = checkPackFleetJobs(job("one", bad) + job("two", bad));
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("one");
    expect(problems[1]).toContain("two");
  });
});
