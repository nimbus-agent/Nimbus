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
          metadata: { nimbus_service_id: "checkout", environment: "prod" },
        }),
      ).toEqual({ kind: "bound", serviceId: "checkout" });
    });

    it("falls through when the id does not name a known service", () => {
      const resolve = buildServiceIdentityResolver(configs(baseConfig()));
      expect(
        resolve({
          service: "deploy-annotate",
          type: "deployment",
          metadata: { nimbus_service_id: "unknown-svc" },
        }),
      ).toEqual({ kind: "unknown" });
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
      ).toEqual({ kind: "bound", serviceId: "checkout" });
    });

    it("returns unknown when no ServiceConfig claims the pagerduty service id", () => {
      const resolve = buildServiceIdentityResolver(configs(baseConfig()));
      expect(
        resolve({
          service: "pagerduty",
          type: "incident",
          metadata: { pagerduty_service_id: "PSVC-UNMAPPED" },
        }),
      ).toEqual({ kind: "unknown" });
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
      ).toEqual({ kind: "bound", serviceId: "checkout" });
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
      ).toEqual({ kind: "bound", serviceId: "checkout" });
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
      ).toEqual({ kind: "bound", serviceId: "checkout" });
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
      ).toEqual({ kind: "unknown" });
    });

    it("returns unknown when no repo matches", () => {
      const resolve = buildServiceIdentityResolver(configs(baseConfig()));
      expect(
        resolve({
          service: "github",
          type: "pr",
          metadata: { repo: "acme/some-other-repo" },
        }),
      ).toEqual({ kind: "unknown" });
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
      ).toEqual({ kind: "bound", serviceId: "search" });
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
          metadata: { pagerduty_service_id: "PSVC1", repo: "acme/other", environment: "prod" },
        }),
      ).toEqual({ kind: "bound", serviceId: "checkout" });
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
      ).toEqual({ kind: "bound", serviceId: "checkout" });
    });

    it("excludes a deployment whose metadata.target is excluded by deployEnvironments", () => {
      const resolve = buildServiceIdentityResolver(
        configs(baseConfig({ deployEnvironments: ["prod"] })),
      );
      expect(
        resolve({
          service: "vercel",
          type: "deployment",
          metadata: { repo: "acme/checkout", target: "preview" },
        }),
      ).toEqual({ kind: "excluded" });
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
      ).toEqual({ kind: "bound", serviceId: "checkout" });
    });

    // F2: a deployment with no environment signal at all now resolves
    // `excluded` (fail CLOSED) — the prior fail-open behavior is exactly
    // what this test used to assert; see service-identity.ts's F2 doc for
    // why an unverified "Vercel always writes target" assumption is not
    // trustworthy enough to bind on.
    it("F2: excludes (fails closed) a deployment with no environment signal at all", () => {
      const resolve = buildServiceIdentityResolver(
        configs(baseConfig({ deployEnvironments: ["prod"] })),
      );
      expect(
        resolve({
          service: "vercel",
          type: "deployment",
          metadata: { repo: "acme/checkout" },
        }),
      ).toEqual({ kind: "excluded" });
    });

    it("F2: still binds a deployment whose metadata.target is production", () => {
      const resolve = buildServiceIdentityResolver(
        configs(baseConfig({ deployEnvironments: ["prod"] })),
      );
      expect(
        resolve({
          service: "vercel",
          type: "deployment",
          metadata: { repo: "acme/checkout", target: "production" },
        }),
      ).toEqual({ kind: "bound", serviceId: "checkout" });
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
      ).toEqual({ kind: "bound", serviceId: "checkout" });
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
      expect(result).toEqual({ kind: "bound", serviceId: "checkout" });
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
      expect(result).toEqual({ kind: "bound", serviceId: "checkout" });
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

    // F3: the resolver is built once and then called for every synced item —
    // an ambiguous key hit by many items must still warn only once, not once
    // per item.
    it("F3: warns only once total across many items that all hit the same ambiguous key, not once per item", () => {
      const warnings: unknown[] = [];
      const resolve = buildServiceIdentityResolver(
        configs(
          baseConfig({ serviceId: "checkout", pagerdutyServices: ["PSVC1"] }),
          baseConfig({ serviceId: "checkout-mono", pagerdutyServices: ["PSVC1"], repos: [] }),
        ),
        (w) => warnings.push(w),
      );

      for (let i = 0; i < 50; i++) {
        resolve({
          service: "pagerduty",
          type: "incident",
          metadata: { pagerduty_service_id: "PSVC1" },
        });
      }

      expect(warnings).toHaveLength(1);
    });

    // F4: an ambiguous binding behind a deployment that the I-1/F2
    // environment gate excludes must not be reported — the log would
    // otherwise assert a `chosenServiceId` for a resolve that returned
    // nothing. Once the SAME key later actually binds, it warns exactly
    // once, for that bound resolution only.
    it("F4: does not warn for an ambiguous binding the environment gate excluded; warns once it actually binds", () => {
      const warnings: unknown[] = [];
      const resolve = buildServiceIdentityResolver(
        configs(
          baseConfig({
            serviceId: "checkout",
            pagerdutyServices: [],
            repos: [{ provider: "github", providerId: "acme/mono" }],
            deployEnvironments: ["prod"],
          }),
          baseConfig({
            serviceId: "billing",
            pagerdutyServices: [],
            repos: [{ provider: "github", providerId: "acme/mono" }],
            deployEnvironments: ["prod"],
          }),
        ),
        (w) => warnings.push(w),
      );

      const excluded = resolve({
        service: "vercel",
        type: "deployment",
        metadata: { repo: "acme/mono", target: "preview" },
      });
      expect(excluded).toEqual({ kind: "excluded" });
      expect(warnings).toHaveLength(0);

      const bound = resolve({
        service: "vercel",
        type: "deployment",
        metadata: { repo: "acme/mono", target: "production" },
      });
      expect(bound).toEqual({ kind: "bound", serviceId: "checkout" });
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatchObject({
        bindingKind: "repo_urn",
        chosenServiceId: "checkout",
        candidateServiceIds: ["checkout", "billing"],
      });
    });
  });

  describe("no match anywhere", () => {
    it("returns unknown for an item with none of the bound fields", () => {
      const resolve = buildServiceIdentityResolver(configs(baseConfig()));
      expect(
        resolve({
          service: "vercel",
          type: "deployment",
          metadata: { uid: "dpl_123", state: "READY" },
        }),
      ).toEqual({ kind: "unknown" });
    });

    it("returns unknown against an empty config map", () => {
      const resolve = buildServiceIdentityResolver(new Map());
      expect(
        resolve({
          service: "pagerduty",
          type: "incident",
          metadata: { pagerduty_service_id: "PSVC1" },
        }),
      ).toEqual({ kind: "unknown" });
    });
  });
});
