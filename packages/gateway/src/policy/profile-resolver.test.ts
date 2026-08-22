import { describe, expect, test } from "bun:test";
import type { EnforcedPolicy } from "./policy-gate.ts";
import { type ProfileConfig, resolveEffectiveConfig } from "./profile-resolver.ts";

const policy: EnforcedPolicy = {
  connectorAllow: ["github", "slack", "jira"],
  retentionDays: 30,
  hitlRequired: new Set(["db.drop"]),
  quorum: new Map(),
  capabilitiesDisabled: new Set(),
  chatops: { channels: new Map(), ownership: new Map() },
};

describe("resolveEffectiveConfig", () => {
  test("connectors = profile ∩ policy.allow (profile cannot add a forbidden connector)", () => {
    const profile: ProfileConfig = { enabledConnectors: ["github", "notion"], retentionDays: 90 };
    expect(resolveEffectiveConfig(profile, policy).enabledConnectors).toEqual(["github"]);
  });

  test("retention = max(profile, policy)", () => {
    expect(
      resolveEffectiveConfig({ enabledConnectors: [], retentionDays: 90 }, policy).retentionDays,
    ).toBe(90);
    expect(
      resolveEffectiveConfig({ enabledConnectors: [], retentionDays: 10 }, policy).retentionDays,
    ).toBe(30);
  });

  test("policy.connectorAllow undefined => profile passes through unbounded", () => {
    const policyNoAllow: EnforcedPolicy = {
      retentionDays: 30,
      hitlRequired: new Set(["db.drop"]),
      quorum: new Map(),
      capabilitiesDisabled: new Set(),
      chatops: { channels: new Map(), ownership: new Map() },
    };
    const e = resolveEffectiveConfig(
      { enabledConnectors: ["x", "y"], retentionDays: 5 },
      policyNoAllow,
    );
    expect(e.enabledConnectors).toEqual(["x", "y"]);
  });

  test("empty intersection => empty connector list", () => {
    const profile: ProfileConfig = { enabledConnectors: ["notion", "linear"], retentionDays: 5 };
    expect(resolveEffectiveConfig(profile, policy).enabledConnectors).toEqual([]);
  });
});
