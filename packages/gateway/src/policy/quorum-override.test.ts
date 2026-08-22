import { describe, expect, test } from "bun:test";
import type { QuorumRule } from "../config/nimbus-toml.ts";
import type { EnforcedPolicy } from "./policy-gate.ts";
import { isHitlRequiredByPolicy, resolveQuorumRule } from "./quorum-override.ts";

const enforced: EnforcedPolicy = {
  retentionDays: 7,
  hitlRequired: new Set(["db.drop"]),
  quorum: new Map<string, QuorumRule>([
    ["terraform.destroy", { approvers: 2, windowSeconds: 3600 }],
  ]),
  chatops: { channels: new Map(), ownership: new Map() },
  capabilitiesDisabled: new Set(),
};

describe("resolveQuorumRule", () => {
  test("returns the enforced rule for a governed action", () => {
    expect(resolveQuorumRule(enforced, "terraform.destroy")).toEqual({
      approvers: 2,
      windowSeconds: 3600,
    });
  });
  test("returns undefined for an ungoverned action (no quorum)", () => {
    expect(resolveQuorumRule(enforced, "noop.action")).toBeUndefined();
  });
  test("isHitlRequiredByPolicy reflects the union set", () => {
    expect(isHitlRequiredByPolicy(enforced, "db.drop")).toBe(true);
    expect(isHitlRequiredByPolicy(enforced, "noop.action")).toBe(false);
  });
});
