import { describe, expect, test } from "bun:test";
import type { NimbusFleetJobToml } from "../config/fleet-toml.ts";
import { FleetConfigError } from "../config/fleet-toml.ts";
import { FLEET_ELIGIBILITY } from "../ipc/agents-rpc.ts";
import {
  FLEET_SWEEP_SUPPORT,
  sweepParamFor,
  validateFleetSweepJobs,
} from "./fleet-sweep-support.ts";

function job(
  over: Partial<NimbusFleetJobToml> & Pick<NimbusFleetJobToml, "agent">,
): NimbusFleetJobToml {
  return {
    name: "j",
    intervalSeconds: 60,
    params: {},
    digestMinDelta: 1,
    sweep: { kind: "paths", maxSubjects: 10, pathPrefix: null },
    ...over,
  };
}

describe("FLEET_SWEEP_SUPPORT", () => {
  test("covers EXACTLY the fleet-eligible agents — derived from FLEET_ELIGIBILITY, not a hand list", () => {
    const eligible = Object.entries(FLEET_ELIGIBILITY)
      .filter(([, v]) => v === "eligible")
      .map(([k]) => k)
      .sort();
    expect(Object.keys(FLEET_SWEEP_SUPPORT).sort()).toEqual(eligible);
  });

  test("every entry is either sweepable with no reason, or not sweepable with a reason", () => {
    for (const [method, s] of Object.entries(FLEET_SWEEP_SUPPORT)) {
      const kinds = Object.keys(s.accepts);
      if (kinds.length > 0) expect(s.reason, method).toBeNull();
      else expect(typeof s.reason === "string" && s.reason.length > 0, method).toBe(true);
    }
  });

  test("the verified bindings (spec § 5.2)", () => {
    expect(sweepParamFor("ownership", "paths")).toBe("path");
    expect(sweepParamFor("ownership", "services")).toBe("service");
    expect(sweepParamFor("oncall", "services")).toBe("service");
    expect(sweepParamFor("changelog", "services")).toBe("service");
    expect(sweepParamFor("ghost", "symbols")).toBe("file");
    expect(sweepParamFor("conflicts", "symbols")).toBe("file");
    expect(sweepParamFor("glossary", "terms")).toBe("term");
    expect(sweepParamFor("janitor", "paths")).toBeNull();
    expect(sweepParamFor("ghost", "paths")).toBeNull();
    expect(sweepParamFor("negotiate", "services")).toBeNull();
  });
});

describe("validateFleetSweepJobs", () => {
  test("accepts config-named jobs and valid sweeps", () => {
    expect(() =>
      validateFleetSweepJobs([job({ agent: "catchup", sweep: null }), job({ agent: "ownership" })]),
    ).not.toThrow();
  });

  test("rule 1: a kind the agent does not accept is refused, with the map's reason", () => {
    expect(() => validateFleetSweepJobs([job({ agent: "janitor" })])).toThrow(FleetConfigError);
    expect(() => validateFleetSweepJobs([job({ agent: "janitor" })])).toThrow(
      /no resource inventory/,
    );
    expect(() =>
      validateFleetSweepJobs([
        job({ agent: "ghost", sweep: { kind: "paths", maxSubjects: 5, pathPrefix: null } }),
      ]),
    ).toThrow(/cannot sweep "paths"/);
  });

  test("rule 2: the job also setting the swept parameter is refused", () => {
    expect(() =>
      validateFleetSweepJobs([job({ agent: "ownership", params: { path: "src" } })]),
    ).toThrow(/sets path and sweep = "paths"/);
  });

  test.each([["namespace"], ["namespaces"]])(
    "rule 6: sweep with %s is refused — a sweep stays local",
    (key) => {
      expect(() =>
        validateFleetSweepJobs([
          job({
            agent: "ghost",
            params: { [key]: "team-a" },
            sweep: { kind: "symbols", maxSubjects: 5, pathPrefix: null },
          }),
        ]),
      ).toThrow(/a sweep stays local/);
    },
  );
});
