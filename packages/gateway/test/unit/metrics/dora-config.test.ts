import { describe, expect, it } from "bun:test";
import { parseNimbusDoraToml } from "../../../src/config/nimbus-toml.ts";
import {
  DEFAULT_DEPLOY_WORKFLOW_PATTERN,
  parseDoraRepoUrn,
} from "../../../src/metrics/dora-config.ts";

describe("DORA TOML parser", () => {
  it("parses one service entry with all keys", () => {
    const raw = `
[metrics.dora.payment-service]
repos = ["github:nimbus-agent/payments", "jenkins:payment-service/deploy-prod"]
pagerduty_services = ["P12ABCD"]
deploy_workflow_pattern = "^Release"
incident_window_minutes = 90
exclude_pr_labels = ["revert", "rollback"]
`;
    const parsed = parseNimbusDoraToml(raw);
    expect(parsed.size).toBe(1);
    const cfg = parsed.get("payment-service");
    if (cfg === undefined) throw new Error("payment-service missing");
    expect(cfg.repos.map((r) => `${r.provider}:${r.providerId}`)).toEqual([
      "github:nimbus-agent/payments",
      "jenkins:payment-service/deploy-prod",
    ]);
    expect(cfg.pagerdutyServices).toEqual(["P12ABCD"]);
    expect(cfg.deployWorkflowPattern.source).toBe("^Release");
    expect(cfg.incidentWindowMinutes).toBe(90);
    expect(cfg.excludePrLabels).toEqual(["revert", "rollback"]);
  });

  it("uses defaults for omitted keys", () => {
    const raw = `
[metrics.dora.svc-a]
repos = ["github:org/svc-a"]
`;
    const cfg = parseNimbusDoraToml(raw).get("svc-a");
    if (cfg === undefined) throw new Error("svc-a missing");
    expect(cfg.deployWorkflowPattern.source).toBe(DEFAULT_DEPLOY_WORKFLOW_PATTERN);
    expect(cfg.incidentWindowMinutes).toBe(60);
    expect(cfg.excludePrLabels).toEqual(["revert"]);
    expect(cfg.pagerdutyServices).toEqual([]);
  });

  it("rejects an unknown provider prefix", () => {
    expect(() => parseDoraRepoUrn("svn:my-repo")).toThrow(/unknown provider/i);
  });

  it("rejects URN with no separator", () => {
    expect(() => parseDoraRepoUrn("github")).toThrow(/invalid urn/i);
  });

  it("parses URN with provider-id containing colons", () => {
    const out = parseDoraRepoUrn("circleci:gh/nimbus-agent/payments");
    expect(out.provider).toBe("circleci");
    expect(out.providerId).toBe("gh/nimbus-agent/payments");
  });

  it("rejects unparseable deploy_workflow_pattern", () => {
    const raw = `
[metrics.dora.bad-service]
repos = ["github:org/svc"]
deploy_workflow_pattern = "["
`;
    expect(() => parseNimbusDoraToml(raw)).toThrow(/regex/i);
  });

  it("rejects out-of-range incident_window_minutes", () => {
    const raw = `
[metrics.dora.bad]
repos = ["github:org/svc"]
incident_window_minutes = 0
`;
    expect(() => parseNimbusDoraToml(raw)).toThrow(/incident_window_minutes/);
  });

  it("accepts incident_window_minutes = 1440 (upper boundary)", () => {
    const raw = `
[metrics.dora.svc]
repos = ["github:org/svc"]
incident_window_minutes = 1440
`;
    const cfg = parseNimbusDoraToml(raw).get("svc");
    if (cfg === undefined) throw new Error("svc missing");
    expect(cfg.incidentWindowMinutes).toBe(1440);
  });

  it("rejects incident_window_minutes = 1441 (above upper bound)", () => {
    const raw = `
[metrics.dora.bad]
repos = ["github:org/svc"]
incident_window_minutes = 1441
`;
    expect(() => parseNimbusDoraToml(raw)).toThrow(/incident_window_minutes/);
  });

  it("rejects unknown keys", () => {
    const raw = `
[metrics.dora.bad]
repos = ["github:org/svc"]
mystery = "yes"
`;
    expect(() => parseNimbusDoraToml(raw)).toThrow(/unknown key/i);
  });

  it("returns an empty Map when no [metrics.dora.*] tables present", () => {
    const parsed = parseNimbusDoraToml('[user]\nme_person_id = "alice"\n');
    expect(parsed.size).toBe(0);
  });

  it("rejects a service block missing the required 'repos' key", () => {
    const raw = `
[metrics.dora.no-repos]
pagerduty_services = ["PXYZ"]
`;
    expect(() => parseNimbusDoraToml(raw)).toThrow(/missing required 'repos'/);
  });

  it("defaults deploy_environments to the standard list when omitted", () => {
    const raw = `
[metrics.dora.svc]
repos = ["github:org/svc"]
`;
    const cfg = parseNimbusDoraToml(raw).get("svc");
    if (cfg === undefined) throw new Error("svc missing");
    expect(cfg.deployEnvironments.length).toBeGreaterThan(0);
  });

  it("accepts a custom valid deploy_environments array", () => {
    const raw = `
[metrics.dora.svc]
repos = ["github:org/svc"]
deploy_environments = ["staging", "production"]
`;
    const cfg = parseNimbusDoraToml(raw).get("svc");
    if (cfg === undefined) throw new Error("svc missing");
    expect(cfg.deployEnvironments).toEqual(["staging", "production"]);
  });

  it("rejects an empty deploy_environments array", () => {
    const raw = `
[metrics.dora.svc]
repos = ["github:org/svc"]
deploy_environments = []
`;
    expect(() => parseNimbusDoraToml(raw)).toThrow(/deploy_environments must be a non-empty array/);
  });

  it("rejects a deploy_environments entry with an invalid name", () => {
    const raw = `
[metrics.dora.svc]
repos = ["github:org/svc"]
deploy_environments = ["Production!"]
`;
    expect(() => parseNimbusDoraToml(raw)).toThrow(
      /deploy_environments entry 'Production!' is invalid/,
    );
  });

  it("parses multiple service entries independently", () => {
    const raw = `
[metrics.dora.svc-a]
repos = ["github:org/a"]

[metrics.dora.svc-b]
repos = ["gitlab:org/b"]
pagerduty_services = ["PXYZ"]
`;
    const parsed = parseNimbusDoraToml(raw);
    expect(parsed.size).toBe(2);
    expect(parsed.get("svc-a")?.pagerdutyServices).toEqual([]);
    expect(parsed.get("svc-b")?.pagerdutyServices).toEqual(["PXYZ"]);
  });
});
