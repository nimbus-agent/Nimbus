import { describe, expect, test } from "bun:test";

import type { CostRates } from "./cost-rate-price.ts";
import { gitlabJobLines } from "./gitlab-job-lines.ts";

const RATES: CostRates = {
  ratePerMinute: 0.01,
  currency: "USD",
  runnerRates: [["big-linux", 0.05]],
};

/** A documentation-shaped job (`GET /projects/:id/jobs`). */
const job = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 1,
  status: "success",
  duration: 120,
  queued_duration: 3.5,
  finished_at: "2026-11-02T10:00:00.000Z",
  runner: { id: 7, description: "big-linux", runner_type: "instance_type", is_shared: true },
  ...over,
});

describe("gitlabJobLines", () => {
  test("jobs sum per day, project and runner; the listed runner's rate applies", () => {
    const r = gitlabJobLines(
      "acme",
      "2026-11",
      [
        {
          projectId: "acme/web",
          projectFullPath: "acme/web",
          jobs: [job(), job({ id: 2, duration: 60 })],
        },
        { projectId: "acme/api", projectFullPath: "acme/api", jobs: [job({ id: 3 })] },
      ],
      RATES,
    );
    expect(r.jobs).toBe(3);
    const web = r.lines.find((l) => l.subAccountId === "acme/web");
    expect(web).toMatchObject({
      chargeDay: "2026-11-02",
      resourceId: "7",
      resourceName: "big-linux",
      consumedQuantity: 3,
      consumedUnit: "minute",
      billedCost: 0.15,
      priced: true,
      tags: {
        rate_key: "runner:big-linux",
        gitlab_deployment: "self-managed",
        runner_type: "instance_type",
      },
    });
    expect(r.lines).toHaveLength(2);
  });

  test("an unlisted runner uses the default rate; no rate at all is unpriced", () => {
    const small = job({ runner: { id: 8, description: "small", runner_type: "project_type" } });
    const [l] = gitlabJobLines(
      "acme",
      "2026-11",
      [{ projectId: "p", projectFullPath: "p", jobs: [small] }],
      RATES,
    ).lines;
    expect(l).toMatchObject({ billedCost: 0.02, tags: { rate_key: "runner:small" } });
    const [u] = gitlabJobLines(
      "acme",
      "2026-11",
      [{ projectId: "p", projectFullPath: "p", jobs: [small] }],
      {
        ...RATES,
        ratePerMinute: null,
      },
    ).lines;
    expect(u).toMatchObject({
      billedCost: 0,
      effectiveCost: null,
      priced: false,
      consumedQuantity: 2,
    });
  });

  test("each drop reason is counted, never thrown", () => {
    const r = gitlabJobLines(
      "acme",
      "2026-11",
      [
        {
          projectId: "p",
          projectFullPath: "p",
          jobs: [
            job({ runner: null }),
            job({ finished_at: null }),
            job({ finished_at: "2026-11-02T10:00:00" }),
            job({ duration: -1 }),
            job({ duration: "120" }),
            job({ finished_at: "2026-10-31T23:59:59Z" }),
            job({ finished_at: "2026-11-09T00:00:00Z" }),
            "not a job",
          ],
        },
      ],
      RATES,
      "2026-11-08",
    );
    expect(r.lines).toEqual([]);
    expect(r.dropped).toEqual({ no_runner: 1, unfinished: 2, bad_duration: 3, outside_month: 2 });
  });

  test("the UTC day of finished_at decides the line's day", () => {
    const late = job({ finished_at: "2026-11-02T23:30:00-02:00" });
    const [l] = gitlabJobLines(
      "acme",
      "2026-11",
      [{ projectId: "p", projectFullPath: "p", jobs: [late] }],
      RATES,
    ).lines;
    expect(l?.chargeDay).toBe("2026-11-03");
  });
});
