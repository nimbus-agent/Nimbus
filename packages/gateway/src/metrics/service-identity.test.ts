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
