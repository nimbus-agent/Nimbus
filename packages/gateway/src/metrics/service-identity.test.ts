import { describe, expect, it } from "bun:test";
import type { ServiceConfig } from "./dora-config.ts";
import { buildServiceIdentityResolver } from "./service-identity.ts";

function baseConfig(overrides?: Partial<ServiceConfig>): ServiceConfig {
  return {
    serviceId: "checkout",
    repos: [{ provider: "github", providerId: "acme/checkout" }],
    pagerdutyServices: ["PSVC1"],
    deployWorkflowPattern: /^Deploy/,
    incidentWindowMinutes: 60,
    excludePrLabels: ["revert"],
    deployEnvironments: ["prod"],
    severityP1Aliases: ["P1"],
    ...overrides,
  };
}

function configs(...cfgs: ServiceConfig[]): Map<string, ServiceConfig> {
  return new Map(cfgs.map((c) => [c.serviceId, c]));
}

describe("buildServiceIdentityResolver", () => {
  describe("path 1: metadata.nimbus_service_id", () => {
    it("resolves directly when the id names a known service", () => {
      const resolve = buildServiceIdentityResolver(configs(baseConfig()));
      expect(
        resolve({
          service: "deploy-annotate",
          type: "deployment",
          metadata: { nimbus_service_id: "checkout" },
        }),
      ).toBe("checkout");
    });

    it("falls through when the id does not name a known service", () => {
      const resolve = buildServiceIdentityResolver(configs(baseConfig()));
      expect(
        resolve({
          service: "deploy-annotate",
          type: "deployment",
          metadata: { nimbus_service_id: "unknown-svc" },
        }),
      ).toBeUndefined();
    });
  });

  describe("path 2: metadata.pagerduty_service_id", () => {
    it("resolves via the ServiceConfig whose pagerdutyServices contains it", () => {
      const resolve = buildServiceIdentityResolver(
        configs(baseConfig({ serviceId: "checkout", pagerdutyServices: ["PSVC1", "PSVC2"] })),
      );
      expect(
        resolve({
          service: "pagerduty",
          type: "incident",
          metadata: { pagerduty_service_id: "PSVC2" },
        }),
      ).toBe("checkout");
    });

    it("returns undefined when no ServiceConfig claims the pagerduty service id", () => {
      const resolve = buildServiceIdentityResolver(configs(baseConfig()));
      expect(
        resolve({
          service: "pagerduty",
          type: "incident",
          metadata: { pagerduty_service_id: "PSVC-UNMAPPED" },
        }),
      ).toBeUndefined();
    });
  });

  describe("path 3: repo-bearing metadata", () => {
    it("resolves a github repo URN via metadata.repo", () => {
      const resolve = buildServiceIdentityResolver(
        configs(
          baseConfig({
            serviceId: "checkout",
            repos: [{ provider: "github", providerId: "acme/checkout" }],
          }),
        ),
      );
      expect(
        resolve({
          service: "github",
          type: "pr",
          metadata: { repo: "acme/checkout" },
        }),
      ).toBe("checkout");
    });

    it("resolves a gitlab repo URN via metadata.project", () => {
      const resolve = buildServiceIdentityResolver(
        configs(
          baseConfig({
            serviceId: "checkout",
            repos: [{ provider: "gitlab", providerId: "group/checkout" }],
          }),
        ),
      );
      expect(
        resolve({
          service: "gitlab",
          type: "pr",
          metadata: { project: "group/checkout" },
        }),
      ).toBe("checkout");
    });

    it("resolves a jenkins URN via metadata.jobName", () => {
      const resolve = buildServiceIdentityResolver(
        configs(
          baseConfig({
            serviceId: "checkout",
            repos: [{ provider: "jenkins", providerId: "checkout-pipeline" }],
          }),
        ),
      );
      expect(
        resolve({
          service: "jenkins",
          type: "ci_run",
          metadata: { jobName: "checkout-pipeline" },
        }),
      ).toBe("checkout");
    });

    it("never matches a circleci URN (no external id in this item shape)", () => {
      const resolve = buildServiceIdentityResolver(
        configs(
          baseConfig({
            serviceId: "checkout",
            repos: [{ provider: "circleci", providerId: "gh/acme/checkout" }],
          }),
        ),
      );
      expect(
        resolve({
          service: "circleci",
          type: "ci_run",
          metadata: {},
        }),
      ).toBeUndefined();
    });

    it("returns undefined when no repo matches", () => {
      const resolve = buildServiceIdentityResolver(configs(baseConfig()));
      expect(
        resolve({
          service: "github",
          type: "pr",
          metadata: { repo: "acme/some-other-repo" },
        }),
      ).toBeUndefined();
    });
  });

  describe("precedence", () => {
    it("prefers nimbus_service_id over pagerduty_service_id", () => {
      const resolve = buildServiceIdentityResolver(
        configs(
          baseConfig({ serviceId: "checkout", pagerdutyServices: ["PSVC1"] }),
          baseConfig({ serviceId: "search", pagerdutyServices: [], repos: [] }),
        ),
      );
      expect(
        resolve({
          service: "pagerduty",
          type: "incident",
          metadata: { nimbus_service_id: "search", pagerduty_service_id: "PSVC1" },
        }),
      ).toBe("search");
    });

    it("prefers pagerduty_service_id over a repo match", () => {
      const resolve = buildServiceIdentityResolver(
        configs(
          baseConfig({
            serviceId: "checkout",
            pagerdutyServices: ["PSVC1"],
            repos: [{ provider: "github", providerId: "acme/other" }],
          }),
          baseConfig({
            serviceId: "other",
            pagerdutyServices: [],
            repos: [{ provider: "github", providerId: "acme/other" }],
          }),
        ),
      );
      expect(
        resolve({
          service: "vercel",
          type: "deployment",
          metadata: { pagerduty_service_id: "PSVC1", repo: "acme/other" },
        }),
      ).toBe("checkout");
    });
  });

  describe("I-1: deployment environment gating", () => {
    it("binds a deployment whose metadata.target matches deployEnvironments (after the production→prod alias)", () => {
      const resolve = buildServiceIdentityResolver(
        configs(baseConfig({ deployEnvironments: ["prod"] })),
      );
      expect(
        resolve({
          service: "vercel",
          type: "deployment",
          metadata: { repo: "acme/checkout", target: "production" },
        }),
      ).toBe("checkout");
    });

    it("does not bind a deployment whose metadata.target is excluded by deployEnvironments", () => {
      const resolve = buildServiceIdentityResolver(
        configs(baseConfig({ deployEnvironments: ["prod"] })),
      );
      expect(
        resolve({
          service: "vercel",
          type: "deployment",
          metadata: { repo: "acme/checkout", target: "preview" },
        }),
      ).toBeUndefined();
    });

    it("prefers the canonical metadata.environment over metadata.target when both are present", () => {
      const resolve = buildServiceIdentityResolver(
        configs(baseConfig({ deployEnvironments: ["staging"] })),
      );
      expect(
        resolve({
          service: "vercel",
          type: "deployment",
          metadata: { repo: "acme/checkout", environment: "staging", target: "preview" },
        }),
      ).toBe("checkout");
    });

    it("binds a deployment with no environment signal at all (fail-open)", () => {
      const resolve = buildServiceIdentityResolver(
        configs(baseConfig({ deployEnvironments: ["prod"] })),
      );
      expect(
        resolve({
          service: "vercel",
          type: "deployment",
          metadata: { repo: "acme/checkout" },
        }),
      ).toBe("checkout");
    });

    it("does not gate a non-deployment item type even when it carries a non-matching target", () => {
      const resolve = buildServiceIdentityResolver(
        configs(baseConfig({ deployEnvironments: ["prod"] })),
      );
      expect(
        resolve({
          service: "vercel",
          type: "incident",
          metadata: { repo: "acme/checkout", target: "preview" },
        }),
      ).toBe("checkout");
    });
  });

  describe("M-2: ambiguous binding warning", () => {
    it("warns when two ServiceConfigs claim the same pagerdutyServices entry, and still resolves deterministically (first by config-map order)", () => {
      const warnings: unknown[] = [];
      const resolve = buildServiceIdentityResolver(
        configs(
          baseConfig({ serviceId: "checkout", pagerdutyServices: ["PSVC1"] }),
          baseConfig({ serviceId: "checkout-mono", pagerdutyServices: ["PSVC1"], repos: [] }),
        ),
        (w) => warnings.push(w),
      );
      const result = resolve({
        service: "pagerduty",
        type: "incident",
        metadata: { pagerduty_service_id: "PSVC1" },
      });
      expect(result).toBe("checkout");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatchObject({
        bindingKind: "pagerduty_service_id",
        key: "PSVC1",
        chosenServiceId: "checkout",
        candidateServiceIds: ["checkout", "checkout-mono"],
      });
    });

    it("warns when two ServiceConfigs claim the same repo URN (a monorepo)", () => {
      const warnings: unknown[] = [];
      const resolve = buildServiceIdentityResolver(
        configs(
          baseConfig({
            serviceId: "checkout",
            pagerdutyServices: [],
            repos: [{ provider: "github", providerId: "acme/mono" }],
          }),
          baseConfig({
            serviceId: "billing",
            pagerdutyServices: [],
            repos: [{ provider: "github", providerId: "acme/mono" }],
          }),
        ),
        (w) => warnings.push(w),
      );
      const result = resolve({
        service: "github",
        type: "pr",
        metadata: { repo: "acme/mono" },
      });
      expect(result).toBe("checkout");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatchObject({
        bindingKind: "repo_urn",
        chosenServiceId: "checkout",
        candidateServiceIds: ["checkout", "billing"],
      });
    });

    it("does not warn when only one ServiceConfig claims the key", () => {
      const warnings: unknown[] = [];
      const resolve = buildServiceIdentityResolver(
        configs(baseConfig({ serviceId: "checkout", pagerdutyServices: ["PSVC1"] })),
        (w) => warnings.push(w),
      );
      resolve({
        service: "pagerduty",
        type: "incident",
        metadata: { pagerduty_service_id: "PSVC1" },
      });
      expect(warnings).toHaveLength(0);
    });
  });

  describe("no match anywhere", () => {
    it("returns undefined for an item with none of the bound fields", () => {
      const resolve = buildServiceIdentityResolver(configs(baseConfig()));
      expect(
        resolve({
          service: "vercel",
          type: "deployment",
          metadata: { uid: "dpl_123", state: "READY" },
        }),
      ).toBeUndefined();
    });

    it("returns undefined against an empty config map", () => {
      const resolve = buildServiceIdentityResolver(new Map());
      expect(
        resolve({
          service: "pagerduty",
          type: "incident",
          metadata: { pagerduty_service_id: "PSVC1" },
        }),
      ).toBeUndefined();
    });
  });
});
