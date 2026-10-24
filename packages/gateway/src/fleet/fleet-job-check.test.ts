import { describe, expect, test } from "bun:test";
import type { NimbusFleetJobToml } from "../config/fleet-toml.ts";
import { checkFleetJob } from "./fleet-job-check.ts";

function job(over: Partial<NimbusFleetJobToml> = {}): NimbusFleetJobToml {
  return {
    name: "j",
    agent: "ownership",
    intervalSeconds: 60,
    params: {},
    digestMinDelta: 1,
    sweep: null,
    ...over,
  };
}

describe("checkFleetJob", () => {
  test("an ineligible agent is a reason", () => {
    expect(checkFleetJob(job({ agent: "preflight" }))).toBe(
      `[[fleet.job]] j agent "preflight" is not fleet-eligible`,
    );
  });

  test("a sweep the agent cannot do is a reason", () => {
    expect(
      checkFleetJob(
        job({ agent: "janitor", sweep: { kind: "paths", maxSubjects: 10, pathPrefix: null } }),
      ),
    ).toBe(
      `[[fleet.job]] j agent "janitor" cannot sweep "paths": janitor's resourceRef is free text ` +
        "probed for mentions; the index holds no resource inventory, so a list would be invented " +
        "rather than enumerated",
    );
  });

  test("a valid job passes", () => {
    expect(checkFleetJob(job())).toBeUndefined();
    expect(
      checkFleetJob(job({ sweep: { kind: "paths", maxSubjects: 10, pathPrefix: null } })),
    ).toBeUndefined();
  });
});
