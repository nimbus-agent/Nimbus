import { describe, expect, test } from "bun:test";
import { isAgentOrigin, isModelOrigin, isOutsideOrigin } from "./outside-origin.ts";
import type { AgentProposer, PlannedAction } from "./types.ts";

const proposer: AgentProposer = {
  door: "agent",
  captureId: "cap_x",
  label: "client",
  labelSource: "declared",
  summary: "s",
  createdAt: 1,
  expiresAt: 2,
};

describe("isOutsideOrigin / isAgentOrigin (AD1)", () => {
  test("only the origin decides, and only the two outside origins count", () => {
    expect(isOutsideOrigin({})).toBe(false);
    expect(isOutsideOrigin({ origin: "model" })).toBe(true);
    expect(isOutsideOrigin({ origin: "agent" })).toBe(true);
    expect(isAgentOrigin({})).toBe(false);
    expect(isAgentOrigin({ origin: "model" })).toBe(false);
    expect(isAgentOrigin({ origin: "agent" })).toBe(true);
    expect(isModelOrigin({})).toBe(false);
    expect(isModelOrigin({ origin: "model" })).toBe(true);
    expect(isModelOrigin({ origin: "agent" })).toBe(false);
  });

  test("a proposer alone never marks an outside origin (I3: the origin is the gateway's word)", () => {
    const a: PlannedAction = { type: "x", proposer };
    expect(isOutsideOrigin(a)).toBe(false);
    expect(isAgentOrigin(a)).toBe(false);
    expect(isModelOrigin(a)).toBe(false);
  });

  test("an agent action without a proposer still typechecks (the gate does not require one)", () => {
    const a: PlannedAction = { type: "slack.message.post", origin: "agent" };
    expect(isOutsideOrigin(a)).toBe(true);
  });
});
