import { describe, expect, test } from "bun:test";
import { FLEET_ELIGIBILITY } from "../ipc/agents-rpc.ts";
import type { EligibleAgentMethod } from "./fleet-digest-types.ts";

describe("EligibleAgentMethod is derived, not restated", () => {
  test("an eligible method is assignable and an excluded one is not", () => {
    const ok: EligibleAgentMethod = "agents.ghost";
    // @ts-expect-error preflight is excluded_side_effects, so it must not be assignable.
    const bad: EligibleAgentMethod = "agents.preflight";
    expect(ok).toBe("agents.ghost");
    // `bad`'s declared type stays `EligibleAgentMethod` even though the assignment above was
    // rejected (that's the point of the ts-expect-error), so comparing it to a literal outside
    // that union needs `expect<string>` — a plain `expect(bad)` would fail typecheck on THIS
    // line instead, for an unrelated reason, and mask the assertion above.
    expect<string>(bad).toBe("agents.preflight");
  });

  test("the derived set matches FLEET_ELIGIBILITY at runtime too", () => {
    const eligible = Object.entries(FLEET_ELIGIBILITY)
      .filter(([, v]) => v === "eligible")
      .map(([k]) => k);
    expect(eligible).toHaveLength(13);
    expect(eligible).toContain("agents.ghost");
    expect(eligible).toContain("agents.changelog");
    expect(eligible).toContain("agents.standup");
    expect(eligible).not.toContain("agents.negotiate");
  });
});
