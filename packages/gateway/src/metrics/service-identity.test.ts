import { describe, expect, it } from "bun:test";
import type { ServiceConfig } from "./dora-config.ts";
import { NO_INCIDENT_BINDINGS } from "./dora-config.ts";
import { buildServiceIdentityResolver, resolveServicesByRepoUrn } from "./service-identity.ts";

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
    ...NO_INCIDENT_BINDINGS,
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

    it("resolves a gitlab repo URN via metadata.repo, as Vercel and premortem's synthetic row carry it", () => {
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
          metadata: { repo: "group/checkout" },
        }),
      ).toEqual({ kind: "bound", serviceId: "checkout" });
    });

    it("never binds a jenkins URN through metadata.jobName (no deployment writer records a job name)", () => {
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
        }).kind,
      ).not.toBe("bound");
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

describe("incident-engine bindings (Phase 10 IC2)", () => {
  const payments = baseConfig({
    serviceId: "payments",
    jsmAlertTags: ["Payments", "prod-db"],
    sentryProjects: ["payments-api"],
    dataModels: ["analytics.payments.*", "*.orders"],
  });

  it("a jira:alert binds through any tag, case-insensitively and trimmed", () => {
    const resolve = buildServiceIdentityResolver(configs(payments));
    for (const tag of ["payments", "PAYMENTS", " Prod-DB "]) {
      expect(
        resolve({ service: "jira", type: "alert", metadata: { tags: ["other", tag] } }),
      ).toEqual({ kind: "bound", serviceId: "payments" });
    }
  });

  it("a jira:alert whose only tag is unclaimed, or with no tags, resolves unknown", () => {
    const resolve = buildServiceIdentityResolver(configs(payments));
    expect(resolve({ service: "jira", type: "alert", metadata: { tags: ["billing"] } })).toEqual({
      kind: "unknown",
    });
    expect(resolve({ service: "jira", type: "alert", metadata: { tags: "payments" } })).toEqual({
      kind: "unknown",
    });
    expect(resolve({ service: "jira", type: "alert", metadata: {} })).toEqual({ kind: "unknown" });
    expect(resolve({ service: "jira", type: "alert", metadata: { tags: [5, null] } })).toEqual({
      kind: "unknown",
    });
  });

  it("a sentry:error_issue binds by project slug (exact)", () => {
    const resolve = buildServiceIdentityResolver(configs(payments));
    expect(
      resolve({ service: "sentry", type: "error_issue", metadata: { project: "payments-api" } }),
    ).toEqual({ kind: "bound", serviceId: "payments" });
    expect(
      resolve({ service: "sentry", type: "error_issue", metadata: { project: "Payments-API" } }),
    ).toEqual({ kind: "unknown" });
    expect(
      resolve({ service: "sentry", type: "error_issue", metadata: { project: null } }),
    ).toEqual({ kind: "unknown" });
  });

  it("a Monte Carlo and a Bigeye data_quality_test bind through monitoredDataModelKeys against a glob", () => {
    const resolve = buildServiceIdentityResolver(configs(payments));
    for (const service of ["montecarlo", "bigeye"]) {
      expect(
        resolve({
          service,
          type: "data_quality_test",
          metadata: { monitoredDataModelKeys: ["warehouse.other.t", "analytics.payments.refunds"] },
        }),
      ).toEqual({ kind: "bound", serviceId: "payments" });
      expect(
        resolve({
          service,
          type: "data_quality_test",
          metadata: { monitoredDataModelKeys: ["x.y.orders"] },
        }),
      ).toEqual({ kind: "bound", serviceId: "payments" });
      expect(
        resolve({
          service,
          type: "data_quality_test",
          metadata: { monitoredDataModelKeys: ["warehouse.other.t"] },
        }),
      ).toEqual({ kind: "unknown" });
      expect(
        resolve({ service, type: "data_quality_test", metadata: { monitoredDataModelKeys: [] } }),
      ).toEqual({
        kind: "unknown",
      });
      expect(resolve({ service, type: "data_quality_test", metadata: {} })).toEqual({
        kind: "unknown",
      });
    }
  });

  it("an item of any other (service, type) carrying tags or project is NOT bound", () => {
    const resolve = buildServiceIdentityResolver(configs(payments));
    expect(
      resolve({ service: "prefect", type: "deployment", metadata: { tags: ["payments"] } }),
    ).toEqual({ kind: "unknown" });
    expect(
      resolve({ service: "github", type: "pr", metadata: { project: "payments-api" } }),
    ).toEqual({ kind: "unknown" });
    expect(
      resolve({
        service: "snowflake",
        type: "data_quality_test",
        metadata: { monitoredDataModelKeys: ["analytics.payments.t"] },
      }),
    ).toEqual({ kind: "unknown" });
  });

  it("the existing resolution wins first: a pagerduty id still binds before any binding key", () => {
    const resolve = buildServiceIdentityResolver(
      configs(payments, baseConfig({ serviceId: "other", repos: [], pagerdutyServices: ["PX"] })),
    );
    expect(
      resolve({
        service: "jira",
        type: "alert",
        metadata: { pagerduty_service_id: "PX", tags: ["payments"] },
      }),
    ).toEqual({ kind: "bound", serviceId: "other" });
  });

  it("two configs claiming one tag resolve to the first and warn once", () => {
    const warnings: unknown[] = [];
    const resolve = buildServiceIdentityResolver(
      configs(
        payments,
        baseConfig({
          serviceId: "billing",
          repos: [],
          pagerdutyServices: [],
          jsmAlertTags: ["PAYMENTS"],
        }),
      ),
      (w) => warnings.push(w),
    );
    const alert = { service: "jira", type: "alert", metadata: { tags: ["payments"] } };
    expect(resolve(alert)).toEqual({ kind: "bound", serviceId: "payments" });
    expect(resolve(alert)).toEqual({ kind: "bound", serviceId: "payments" });
    expect(warnings).toEqual([
      {
        bindingKind: "jsm_alert_tag",
        key: "payments",
        chosenServiceId: "payments",
        candidateServiceIds: ["payments", "billing"],
      },
    ]);
  });

  it("two configs claiming one Sentry slug resolve to the first and warn once", () => {
    const warnings: unknown[] = [];
    const resolve = buildServiceIdentityResolver(
      configs(
        payments,
        baseConfig({
          serviceId: "billing",
          repos: [],
          pagerdutyServices: [],
          sentryProjects: ["payments-api"],
        }),
      ),
      (w) => warnings.push(w),
    );
    const issue = { service: "sentry", type: "error_issue", metadata: { project: "payments-api" } };
    resolve(issue);
    resolve(issue);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      bindingKind: "sentry_project",
      chosenServiceId: "payments",
    });
  });

  it("a glob overlap warns once per matched model key per resolver lifetime", () => {
    const warnings: unknown[] = [];
    const resolve = buildServiceIdentityResolver(
      configs(
        payments,
        baseConfig({
          serviceId: "billing",
          repos: [],
          pagerdutyServices: [],
          dataModels: ["analytics.*"],
        }),
      ),
      (w) => warnings.push(w),
    );
    const test = (key: string) => ({
      service: "montecarlo",
      type: "data_quality_test",
      metadata: { monitoredDataModelKeys: [key] },
    });
    expect(resolve(test("analytics.payments.t"))).toEqual({ kind: "bound", serviceId: "payments" });
    resolve(test("analytics.payments.t"));
    resolve(test("analytics.sales.t")); // only billing's glob matches: no overlap
    resolve(test("x.y.orders")); // only payments' glob matches
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      bindingKind: "data_model_glob",
      key: "analytics.payments.t",
      chosenServiceId: "payments",
      candidateServiceIds: ["payments", "billing"],
    });
  });

  it("a duplicated claim of one tag by the SAME config is not ambiguous", () => {
    const warnings: unknown[] = [];
    const resolve = buildServiceIdentityResolver(
      configs(baseConfig({ serviceId: "payments", jsmAlertTags: ["a", "A"] })),
      (w) => warnings.push(w),
    );
    resolve({ service: "jira", type: "alert", metadata: { tags: ["a"] } });
    expect(warnings).toEqual([]);
  });
});

describe("resolveServicesByRepoUrn", () => {
  it("resolves a repo URN to the service that claims it", () => {
    const res = resolveServicesByRepoUrn(configs(baseConfig()), {
      provider: "github",
      providerId: "acme/checkout",
    });
    expect(res.serviceId).toBe("checkout");
    expect(res.candidateServiceIds).toEqual(["checkout"]);
  });

  it("answers null for a URN no config claims", () => {
    const res = resolveServicesByRepoUrn(configs(baseConfig()), {
      provider: "github",
      providerId: "acme/unclaimed",
    });
    expect(res.serviceId).toBeNull();
    expect(res.candidateServiceIds).toEqual([]);
  });

  it("does not match the same providerId under a different provider", () => {
    const res = resolveServicesByRepoUrn(configs(baseConfig()), {
      provider: "gitlab",
      providerId: "acme/checkout",
    });
    expect(res.serviceId).toBeNull();
  });

  // C6: the item-shaped matcher returns false for every circleci URN because its item shape
  // carries no external id. A URN-to-URN query has no such gap — both sides are config
  // vocabulary, parsed by the same parser — so circleci resolves like any other provider.
  it("resolves a circleci URN, which the item-shaped matcher cannot", () => {
    const res = resolveServicesByRepoUrn(
      configs(baseConfig({ repos: [{ provider: "circleci", providerId: "gh/acme/checkout" }] })),
      { provider: "circleci", providerId: "gh/acme/checkout" },
    );
    expect(res.serviceId).toBe("checkout");
  });

  // §5.1: first claimant wins, matching buildServiceIdentityResolver's M-2 rule, and every
  // claimant is disclosed so the caller can tell a sole claim from a contested one.
  it("picks the first claimant by config order and discloses every candidate", () => {
    const shared = { provider: "github", providerId: "acme/shared" } as const;
    const res = resolveServicesByRepoUrn(
      configs(
        baseConfig({ serviceId: "payments", repos: [shared] }),
        baseConfig({ serviceId: "billing", repos: [shared] }),
      ),
      shared,
    );
    expect(res.serviceId).toBe("payments");
    expect(res.candidateServiceIds).toEqual(["payments", "billing"]);
  });

  it("lists a claimant once even when it names the same repo twice", () => {
    const urn = { provider: "github", providerId: "acme/dup" } as const;
    const res = resolveServicesByRepoUrn(
      configs(baseConfig({ serviceId: "dup", repos: [urn, urn] })),
      urn,
    );
    expect(res.candidateServiceIds).toEqual(["dup"]);
  });
});
