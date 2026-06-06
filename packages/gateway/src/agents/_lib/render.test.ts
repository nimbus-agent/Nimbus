import { describe, expect, test } from "bun:test";
import type { CatchupBrief, ExpertBrief, ImpactBrief } from "./findings.ts";
import { renderCatchup, renderExpert, renderImpact } from "./render.ts";

type BriefMetaKeys = "kind" | "agentVersion" | "generatedAt" | "latencyMs";

const BASE: Pick<ExpertBrief, BriefMetaKeys> = {
  kind: "expert",
  agentVersion: 1,
  generatedAt: 1_700_000_000_000,
  latencyMs: 1400,
};

describe("renderExpert", () => {
  test("full-coverage fixture: top-N section, no Gaps section", () => {
    const brief: ExpertBrief = {
      ...BASE,
      gaps: [],
      query: { topicOrFile: "src/billing/retry.ts" },
      ranked: [
        {
          personId: "p1",
          displayName: "Alice Chen",
          score: 0.92,
          confidence: "high",
          evidence: [
            {
              itemId: "github:org/repo#42",
              type: "pr_authored",
              serviceId: "github",
              title: "fix retry backoff",
              modifiedAt: 1_699_999_900_000,
              weight: 1.0,
            },
          ],
        },
        {
          personId: "p2",
          displayName: "Bob Wong",
          score: 0.55,
          confidence: "medium",
          evidence: [],
        },
      ],
    };
    const md = renderExpert(brief);
    expect(md).toContain("# Expert: src/billing/retry.ts");
    expect(md).toContain("## Top 2");
    expect(md).toContain("**Alice Chen**");
    expect(md).toContain("(high");
    expect(md).toContain("**Bob Wong**");
    expect(md).toContain("(medium");
    expect(md).not.toContain("## Gaps");
    expect(md).toContain("_generated in 1.4 s_");
  });

  test("sparse fixture: Gaps section listed with remediation", () => {
    const brief: ExpertBrief = {
      ...BASE,
      gaps: [
        {
          category: "missing_entity_type",
          detail: "No `incident` graph entities — 0 incidents considered.",
          remediation:
            "Tracked as a graph-populator follow-up on existing PagerDuty / Sentry connectors.",
        },
      ],
      query: { topicOrFile: "src/billing/retry.ts" },
      ranked: [],
    };
    const md = renderExpert(brief);
    expect(md).toContain("## Top 0");
    expect(md).toContain("_no people matched_");
    expect(md).toContain("## Gaps");
    expect(md).toContain("`incident` graph entities");
    expect(md).toContain("graph-populator follow-up");
  });

  test("renderExpert is deterministic across two calls with the same brief", () => {
    const brief: ExpertBrief = {
      ...BASE,
      gaps: [{ category: "empty_index", detail: "No items.", remediation: "sync" }],
      query: { topicOrFile: "x" },
      ranked: [],
    };
    expect(renderExpert(brief)).toBe(renderExpert(brief));
  });

  test("truncates evidence at 5 rows per finding", () => {
    const brief: ExpertBrief = {
      ...BASE,
      gaps: [],
      query: { topicOrFile: "x" },
      ranked: [
        {
          personId: "p1",
          displayName: "Eva",
          score: 1,
          confidence: "high",
          evidence: Array.from({ length: 7 }, (_, i) => ({
            itemId: `i${i}`,
            type: "pr_authored",
            serviceId: "github",
            title: `evidence row ${i}`,
            modifiedAt: 0,
            weight: 1,
          })),
        },
      ],
    };
    const md = renderExpert(brief);
    expect(md).toContain("evidence row 0");
    expect(md).toContain("evidence row 4");
    expect(md).not.toContain("evidence row 5");
    expect(md).not.toContain("evidence row 6");
    expect(md).toContain("(high — 7 evidence rows)");
  });
});

const IMPACT_BASE: Pick<ImpactBrief, BriefMetaKeys> = {
  kind: "impact",
  agentVersion: 1,
  generatedAt: 1_700_000_000_000,
  latencyMs: 2400,
};

describe("renderImpact", () => {
  test("full-coverage fixture: per-bucket sections, no Gaps, latency footer", () => {
    const brief: ImpactBrief = {
      ...IMPACT_BASE,
      gaps: [],
      query: { fileOrPrUrl: "src/billing/retry.ts" },
      startEntityId: "graph:code_symbol#1",
      affected: [
        {
          category: "service",
          affectedItemId: "graph:repo#payment",
          affectedTitle: "payment-service",
          serviceId: "github",
          hops: 1,
          pathSummary: "code_symbol → defined_in → repo",
        },
        {
          category: "pipeline",
          affectedItemId: "github:acme/payment#actions/runs/42",
          affectedTitle: "payment CI run #42",
          serviceId: "github",
          hops: 2,
          pathSummary: "code_symbol → defined_in → repo → triggers → ci_run",
        },
        {
          category: "oncall_rotation",
          affectedItemId: "pagerduty:schedule/PXYZ",
          affectedTitle: "Payment oncall",
          serviceId: "pagerduty",
          hops: 2,
          pathSummary: "service → belongs_to → oncall_rotation",
        },
        {
          category: "dashboard",
          affectedItemId: "metabase:dashboard/17",
          affectedTitle: "Payment health dashboard",
          serviceId: "metabase",
          hops: 2,
          pathSummary: "data_model → upstream_refs → dashboard",
        },
        {
          category: "downstream_repo",
          affectedItemId: "graph:repo#payment-cli",
          affectedTitle: "payment-cli",
          serviceId: "github",
          hops: 1,
          pathSummary: "code_symbol → defined_in → repo",
        },
      ],
    };
    const md = renderImpact(brief);
    expect(md).toContain("# Impact: src/billing/retry.ts");
    expect(md).toContain("## Services\n\n- **payment-service**");
    expect(md).toContain("## Pipelines\n\n- **payment CI run");
    expect(md).toContain("## Oncall\n\n- **Payment oncall**");
    expect(md).toContain("## Dashboards");
    expect(md).toContain("Payment health dashboard");
    expect(md).toContain("## Downstream Repos");
    expect(md).toContain("payment-cli");
    expect(md).toContain("1 hop)");
    expect(md).toContain("2 hops)");
    expect(md).not.toContain("## Gaps");
    expect(md).toContain("_generated in 2.4 s_");
  });

  test("sparse fixture: aggregated gap note rendered with remediation", () => {
    const brief: ImpactBrief = {
      ...IMPACT_BASE,
      gaps: [
        {
          category: "missing_entity_type",
          detail: "3 categories blocked: `data_model` / `dashboard` / `pipeline_run`",
          remediation:
            "Phase 5 Wave D will populate `data_model` via dbt-schema / warehouse connectors. " +
            "Phase 5 Wave D will populate `dashboard` via Metabase / Superset connectors. " +
            "Tracked as a graph-populator follow-up on the existing CI/CD connectors.",
        },
      ],
      query: { fileOrPrUrl: "src/billing/retry.ts" },
      startEntityId: null,
      affected: [],
    };
    const md = renderImpact(brief);
    expect(md).toContain("# Impact: src/billing/retry.ts");
    expect(md).toContain("_no downstream impact resolved_");
    expect(md).toContain("## Gaps");
    expect(md).toContain("3 categories blocked");
    expect(md).toContain("Phase 5 Wave D");
    expect(md).toContain("graph-populator follow-up");
  });

  test("renderImpact is deterministic across two calls with the same brief", () => {
    const brief: ImpactBrief = {
      ...IMPACT_BASE,
      gaps: [],
      query: { fileOrPrUrl: "x" },
      startEntityId: null,
      affected: [],
    };
    expect(renderImpact(brief)).toBe(renderImpact(brief));
  });
});

const CATCHUP_BASE: Pick<CatchupBrief, BriefMetaKeys> = {
  kind: "catchup",
  agentVersion: 1,
  generatedAt: 1_700_000_000_000,
  latencyMs: 12_400,
};

describe("renderCatchup", () => {
  test("full-coverage fixture: per-service sections, items with relevance reasons, no Gaps", () => {
    const brief: CatchupBrief = {
      ...CATCHUP_BASE,
      gaps: [],
      query: { sinceMs: 3 * 24 * 60 * 60 * 1000 },
      selfPersonId: "person-alice",
      involvement: {
        ownedServices: ["github"],
        activeRepos: ["acme/payment"],
        incidentServices: ["pagerduty"],
        collaboratorPersonIds: ["person-bob"],
      },
      sections: [
        {
          serviceId: "github",
          totalItemsInWindow: 14,
          items: [
            {
              itemId: "github:acme/payment#501",
              title: "fix retry backoff in payment-service",
              modifiedAt: 1_699_900_000_000,
              relevanceScore: 0.92,
              relevanceReasons: ["owned_service:github", "active_repo:acme/payment"],
            },
            {
              itemId: "github:acme/payment#502",
              title: "bump deps",
              modifiedAt: 1_699_800_000_000,
              relevanceScore: 0.41,
              relevanceReasons: ["active_repo:acme/payment"],
            },
          ],
        },
        {
          serviceId: "pagerduty",
          totalItemsInWindow: 2,
          items: [
            {
              itemId: "pagerduty:incident/PXYZ",
              title: "Payment Service Latency Spike",
              modifiedAt: 1_699_950_000_000,
              relevanceScore: 0.72,
              relevanceReasons: ["incident_service:pagerduty"],
            },
          ],
        },
      ],
    };
    const md = renderCatchup(brief);
    expect(md).toContain("# Catchup");
    expect(md).toContain("## github");
    expect(md).toContain("(14 items in window)");
    expect(md).toContain("fix retry backoff in payment-service");
    expect(md).toContain("owned_service:github");
    expect(md).toContain("## pagerduty");
    expect(md).toContain("Payment Service Latency Spike");
    expect(md).not.toContain("## Gaps");
    expect(md).toContain("_generated in 12.4 s_");
  });

  test("sparse fixture: missing_user_identity gap rendered with remediation", () => {
    const brief: CatchupBrief = {
      ...CATCHUP_BASE,
      gaps: [
        {
          category: "missing_user_identity",
          detail:
            "Could not resolve the current user — no override / git email / OS username matched a known person.",
          remediation:
            "Set `[user] me_person_id` in your active profile's nimbus.toml, or run `nimbus people search <you>` to find your person id.",
        },
      ],
      query: { sinceMs: 3 * 24 * 60 * 60 * 1000 },
      selfPersonId: null,
      involvement: {
        ownedServices: [],
        activeRepos: [],
        incidentServices: [],
        collaboratorPersonIds: [],
      },
      sections: [],
    };
    const md = renderCatchup(brief);
    expect(md).toContain("# Catchup");
    expect(md).toContain("_no activity in the requested window_");
    expect(md).toContain("## Gaps");
    expect(md).toContain("Could not resolve the current user");
    expect(md).toContain("nimbus people search");
  });

  test("renderCatchup is deterministic across two calls with the same brief", () => {
    const brief: CatchupBrief = {
      ...CATCHUP_BASE,
      gaps: [],
      query: { sinceMs: 1_000 },
      selfPersonId: "person-x",
      involvement: {
        ownedServices: [],
        activeRepos: [],
        incidentServices: [],
        collaboratorPersonIds: [],
      },
      sections: [],
    };
    expect(renderCatchup(brief)).toBe(renderCatchup(brief));
  });

  test("section header lists item count and orders items by relevance descending", () => {
    const brief: CatchupBrief = {
      ...CATCHUP_BASE,
      gaps: [],
      query: { sinceMs: 1_000 },
      selfPersonId: "p",
      involvement: {
        ownedServices: [],
        activeRepos: [],
        incidentServices: [],
        collaboratorPersonIds: [],
      },
      sections: [
        {
          serviceId: "linear",
          totalItemsInWindow: 3,
          items: [
            {
              itemId: "linear:1",
              title: "low",
              modifiedAt: 0,
              relevanceScore: 0.1,
              relevanceReasons: [],
            },
            {
              itemId: "linear:2",
              title: "high",
              modifiedAt: 0,
              relevanceScore: 0.9,
              relevanceReasons: [],
            },
          ],
        },
      ],
    };
    const md = renderCatchup(brief);
    const linearIdx = md.indexOf("## linear");
    const highIdx = md.indexOf("**high**");
    const lowIdx = md.indexOf("**low**");
    expect(linearIdx).toBeGreaterThan(-1);
    expect(highIdx).toBeGreaterThan(linearIdx);
    expect(lowIdx).toBeGreaterThan(highIdx);
  });
});
