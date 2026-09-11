// packages/gateway/src/ipc/agents-rpc-fleet-eligibility.test.ts
import { describe, expect, test } from "bun:test";
import { FLEET_ELIGIBILITY, resolveFleetAgentMethod } from "./agents-rpc.ts";

describe("fleet eligibility", () => {
  test("agents with owner-machine side effects are excluded", () => {
    // preflight queues HITL consent prompts; premortem writes paused watcher rows.
    expect(FLEET_ELIGIBILITY["agents.preflight"]).toBe("excluded_side_effects");
    expect(FLEET_ELIGIBILITY["agents.premortem"]).toBe("excluded_side_effects");
  });

  test("whyPeek is excluded on SHAPE — it is synchronous and never notifies", () => {
    expect(FLEET_ELIGIBILITY["agents.whyPeek"]).toBe("excluded_shape");
  });

  test("negotiate is deferred to PR 2, an explicit value rather than an absence", () => {
    expect(FLEET_ELIGIBILITY["agents.negotiate"]).toBe("deferred");
  });

  test("the pure-read agents are eligible", () => {
    for (const m of [
      "agents.catchup",
      "agents.changelog",
      "agents.huddle",
      "agents.glossary",
      "agents.decisions",
      "agents.ownership",
      "agents.why",
      "agents.ghost",
      "agents.conflicts",
      "agents.impact",
      "agents.expert",
      "agents.janitor",
    ] as const) {
      expect(FLEET_ELIGIBILITY[m]).toBe("eligible");
    }
  });

  test("resolveFleetAgentMethod returns null for every non-eligible classification", () => {
    expect(resolveFleetAgentMethod("catchup")).toBe("agents.catchup");
    expect(resolveFleetAgentMethod("preflight")).toBeNull();
    expect(resolveFleetAgentMethod("premortem")).toBeNull();
    expect(resolveFleetAgentMethod("whyPeek")).toBeNull();
    expect(resolveFleetAgentMethod("negotiate")).toBeNull();
    expect(resolveFleetAgentMethod("nope")).toBeNull();
    // Prototype keys are caller-supplied strings, not methods.
    expect(resolveFleetAgentMethod("constructor")).toBeNull();
  });
});
