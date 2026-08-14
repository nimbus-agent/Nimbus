import { describe, expect, test } from "bun:test";
import type {
  CatchupBrief,
  ConflictBrief,
  ExpertBrief,
  GhostBrief,
  HuddleBrief,
  ImpactBrief,
  JanitorBrief,
  PreflightBrief,
} from "./findings.ts";
import type { GlossaryBrief, GlossaryEntry } from "./glossary-types.ts";
import {
  renderCatchup,
  renderConflict,
  renderExpert,
  renderGhost,
  renderGlossary,
  renderHuddle,
  renderImpact,
  renderJanitor,
  renderPreflight,
} from "./render.ts";

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
              weight: 1,
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
            "Run `nimbus connector sync pagerduty`. Incidents indexed before attribution " +
            "shipped carry no actor emails — `nimbus index rebody --service pagerduty` " +
            "re-fetches them.",
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
    expect(md).toContain("nimbus index rebody --service pagerduty");
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

const GHOST_BASE: Pick<GhostBrief, BriefMetaKeys> = {
  kind: "ghost",
  agentVersion: 1,
  generatedAt: 1_700_000_000_000,
  latencyMs: 800,
};

describe("renderGhost", () => {
  test("full fixture: findings with context rows + expert name, no Gaps", () => {
    const brief: GhostBrief = {
      ...GHOST_BASE,
      gaps: [],
      query: { file: "src/auth.ts" },
      startEntityId: "graph:symbol#1",
      findings: [
        {
          peerId: "peer:aa",
          expert: "Alice",
          rank: "high",
          suggestedContact: "Ask Alice (high relevance)",
          context: [
            { title: "fix auth race", snippet: "x", service: "github", modifiedAt: 10 },
            { title: "auth retry", snippet: "y", service: "github", modifiedAt: 9 },
          ],
        },
      ],
    };
    const md = renderGhost(brief);
    expect(md).toContain("# Ghost: src/auth.ts");
    expect(md).toContain("**Alice** (high) — Ask Alice (high relevance)");
    expect(md).toContain("- fix auth race (`github`)");
    expect(md).not.toContain("## Gaps");
    expect(md).toContain("_generated in 0.8 s_");
  });

  test("finding with no context rows falls back to the head-only line; null expert uses peerId", () => {
    const brief: GhostBrief = {
      ...GHOST_BASE,
      gaps: [{ category: "missing_connector", detail: "no paired peers — run `nimbus team pair`" }],
      query: { file: "src/auth.ts" },
      startEntityId: null,
      findings: [
        {
          peerId: "peer:zz",
          expert: null,
          rank: "low",
          suggestedContact: "Ask peer:zz (low relevance)",
          context: [],
        },
      ],
    };
    const md = renderGhost(brief);
    expect(md).toContain("**peer:zz** (low) — Ask peer:zz (low relevance)");
    expect(md).toContain("## Gaps");
    expect(md).toContain("no paired peers");
  });

  test("no findings yields the empty-state line", () => {
    const brief: GhostBrief = {
      ...GHOST_BASE,
      gaps: [],
      query: { file: "x.ts" },
      startEntityId: null,
      findings: [],
    };
    expect(renderGhost(brief)).toContain("_no teammate context found_");
  });
});

const CONFLICT_BASE: Pick<ConflictBrief, BriefMetaKeys> = {
  kind: "conflict",
  agentVersion: 1,
  generatedAt: 1_700_000_000_000,
  latencyMs: 600,
};

describe("renderConflict", () => {
  test("full fixture: collisions list with who + collision type", () => {
    const brief: ConflictBrief = {
      ...CONFLICT_BASE,
      gaps: [],
      query: { file: "src/auth.ts" },
      startEntityId: "graph:symbol#1",
      collisions: [
        {
          peerId: "peer:aa",
          who: "Alice",
          service: "github",
          collisionType: "open_pr",
          title: "WIP: refactor auth",
          snippet: "",
          modifiedAt: 10,
        },
      ],
    };
    const md = renderConflict(brief);
    expect(md).toContain("# Conflicts: src/auth.ts");
    expect(md).toContain("**Alice** — open pr: WIP: refactor auth (`github`)");
    expect(md).not.toContain("## Gaps");
    expect(md).toContain("_generated in 0.6 s_");
  });

  test("null who falls back to peerId; no collisions yields the empty-state line", () => {
    const withNullWho: ConflictBrief = {
      ...CONFLICT_BASE,
      gaps: [],
      query: { file: "src/auth.ts" },
      startEntityId: null,
      collisions: [
        {
          peerId: "peer:zz",
          who: null,
          service: "gitlab",
          collisionType: "recent_commit",
          title: "hotfix",
          snippet: "",
          modifiedAt: 5,
        },
      ],
    };
    expect(renderConflict(withNullWho)).toContain("**peer:zz** — recent commit: hotfix (`gitlab`)");

    const empty: ConflictBrief = {
      ...CONFLICT_BASE,
      gaps: [],
      query: { file: "x.ts" },
      startEntityId: null,
      collisions: [],
    };
    expect(renderConflict(empty)).toContain("_no work-in-progress collisions found_");
  });
});

const HUDDLE_BASE: Pick<HuddleBrief, BriefMetaKeys> = {
  kind: "huddle",
  agentVersion: 1,
  generatedAt: 1_700_000_000_000,
  latencyMs: 1_500,
};

describe("renderHuddle", () => {
  test("full fixture: per-contributor PR/ticket/incident lines, who name", () => {
    const brief: HuddleBrief = {
      ...HUDDLE_BASE,
      gaps: [],
      query: { sinceMs: 24 * 60 * 60 * 1000 },
      contributions: [
        {
          peerId: "peer:aa",
          who: "Alice",
          prs: [{ title: "merge billing", snippet: "", service: "github", modifiedAt: 10 }],
          tickets: [{ title: "BILL-12", snippet: "", service: "jira", modifiedAt: 9 }],
          incidents: [{ title: "latency spike", snippet: "", service: "pagerduty", modifiedAt: 8 }],
        },
      ],
    };
    const md = renderHuddle(brief);
    expect(md).toContain("# Team Huddle");
    expect(md).toContain("## Alice");
    expect(md).toContain("- PR: merge billing");
    expect(md).toContain("- Ticket: BILL-12");
    expect(md).toContain("- Incident: latency spike");
    expect(md).not.toContain("## Gaps");
    expect(md).toContain("_generated in 1.5 s_");
  });

  test("contributor with no items renders _quiet_; null who falls back to peerId", () => {
    const brief: HuddleBrief = {
      ...HUDDLE_BASE,
      gaps: [],
      query: { sinceMs: 1_000 },
      contributions: [{ peerId: "peer:zz", who: null, prs: [], tickets: [], incidents: [] }],
    };
    const md = renderHuddle(brief);
    expect(md).toContain("## peer:zz");
    expect(md).toContain("_quiet_");
  });

  test("no contributions yields the empty-state line", () => {
    const brief: HuddleBrief = {
      ...HUDDLE_BASE,
      gaps: [],
      query: { sinceMs: 1_000 },
      contributions: [],
    };
    expect(renderHuddle(brief)).toContain("_no teammate activity in the window_");
  });
});

const JANITOR_BASE: Pick<JanitorBrief, BriefMetaKeys> = {
  kind: "janitor",
  agentVersion: 1,
  generatedAt: 1_700_000_000_000,
  latencyMs: 700,
};

describe("renderJanitor", () => {
  test("idle with a named cleanup action renders the runnable command", () => {
    const brief: JanitorBrief = {
      ...JANITOR_BASE,
      gaps: [],
      query: { resourceRef: "i-12345", idleDays: 14 },
      idle: true,
      proposalSuppressed: false,
      cleanupAction: "cloud.instance.terminate",
      peersClear: 3,
      peersTouched: [],
    };
    const md = renderJanitor(brief);
    expect(md).toContain("# Janitor: i-12345");
    expect(md).toContain("Idle ≥ 14d across 3 peer(s).");
    expect(md).toContain("`nimbus run cloud.instance.terminate i-12345`");
    expect(md).not.toContain("## Gaps");
    expect(md).toContain("_generated in 0.7 s_");
  });

  test("idle with no cleanup action renders the bare 'Consider cleanup' verdict", () => {
    const brief: JanitorBrief = {
      ...JANITOR_BASE,
      gaps: [],
      query: { resourceRef: "i-99", idleDays: 30 },
      idle: true,
      proposalSuppressed: false,
      cleanupAction: null,
      peersClear: 1,
      peersTouched: [],
    };
    const md = renderJanitor(brief);
    expect(md).toContain("Idle ≥ 30d across 1 peer(s). Consider cleanup.");
    expect(md).not.toContain("nimbus run");
  });

  test("proposalSuppressed wins over idle and shows the withheld verdict", () => {
    const brief: JanitorBrief = {
      ...JANITOR_BASE,
      gaps: [{ category: "missing_connector", detail: "no paired peers — run `nimbus team pair`" }],
      query: { resourceRef: "i-12345", idleDays: 14 },
      idle: false,
      proposalSuppressed: true,
      cleanupAction: null,
      peersClear: 0,
      peersTouched: [],
    };
    const md = renderJanitor(brief);
    expect(md).toContain("proposal withheld");
    expect(md).toContain("## Gaps");
    expect(md).toContain("no paired peers");
  });

  test("not idle lists touched peers; null who falls back to peerId, null recency to '?'", () => {
    const brief: JanitorBrief = {
      ...JANITOR_BASE,
      gaps: [],
      query: { resourceRef: "i-12345", idleDays: 14 },
      idle: false,
      proposalSuppressed: false,
      cleanupAction: null,
      peersClear: 0,
      peersTouched: [
        { peerId: "peer:aa", who: "Alice", lastSeenDaysAgo: 2 },
        { peerId: "peer:zz", who: null, lastSeenDaysAgo: null },
      ],
    };
    const md = renderJanitor(brief);
    expect(md).toContain("Still in use:");
    expect(md).toContain("Alice: last seen 2d ago");
    expect(md).toContain("peer:zz: last seen ?d ago");
  });
});

const PREFLIGHT_BASE: Pick<PreflightBrief, BriefMetaKeys> = {
  kind: "preflight",
  agentVersion: 1,
  generatedAt: 1_700_000_000_000,
  latencyMs: 3_200,
};

describe("renderPreflight", () => {
  test("renders one line per downstream covering every status icon; null who → peerId", () => {
    const brief: PreflightBrief = {
      ...PREFLIGHT_BASE,
      gaps: [],
      query: { ref: "HEAD~1..HEAD", namespace: "project:zurich" },
      downstreams: [
        { peerId: "peer:aa", who: "Alice", status: "pass", summary: "42 passed" },
        { peerId: "peer:bb", who: "Bob", status: "fail", summary: "3 failed" },
        { peerId: "peer:cc", who: "Cara", status: "declined", summary: "owner declined" },
        { peerId: "peer:dd", who: null, status: "not_configured", summary: "no command" },
      ],
      anyFailed: true,
      anyIncomplete: true,
    };
    const md = renderPreflight(brief);
    expect(md).toContain("# Preflight: HEAD~1..HEAD");
    expect(md).toContain("**Alice**: ✅ pass — 42 passed");
    expect(md).toContain("**Bob**: ❌ fail — 3 failed");
    expect(md).toContain("**Cara**: ⏸ declined — owner declined");
    expect(md).toContain("**peer:dd**: ⚠ not configured — no command");
    expect(md).not.toContain("## Gaps");
    expect(md).toContain("_generated in 3.2 s_");
  });

  test("no reachable downstreams yields the empty-state line and renders gaps", () => {
    const brief: PreflightBrief = {
      ...PREFLIGHT_BASE,
      gaps: [{ category: "missing_connector", detail: "no paired peers — run `nimbus team pair`" }],
      query: { ref: "HEAD", namespace: "n" },
      downstreams: [],
      anyFailed: false,
      anyIncomplete: true,
    };
    const md = renderPreflight(brief);
    expect(md).toContain("_no downstream owners reachable_");
    expect(md).toContain("## Gaps");
    expect(md).toContain("no paired peers");
  });
});

const GLOSSARY_BASE: Pick<GlossaryBrief, BriefMetaKeys> = {
  kind: "glossary",
  agentVersion: 1,
  generatedAt: 1_700_000_000_000,
  latencyMs: 800,
};

/** A minimal but complete entry — every field render.ts might read is present. */
function glossaryEntryFixture(overrides: Partial<GlossaryEntry> = {}): GlossaryEntry {
  return {
    term: "CDR",
    definition: "Authored.",
    definitionSource: "manual",
    docFreq: 0,
    serviceSpread: 0,
    firstSeenAt: 0,
    lastSeenAt: 0,
    topSources: [],
    synonyms: [],
    nearMisses: [],
    ...overrides,
  };
}

describe("renderGlossary", () => {
  test("an authored definition is labelled as authored, not as a snippet", () => {
    const brief: GlossaryBrief = {
      ...GLOSSARY_BASE,
      gaps: [],
      query: { term: "CDR", limit: 10 },
      mode: "term",
      entries: [glossaryEntryFixture({ term: "CDR", definition: "Authored." })],
      matchedVia: null,
      suggestions: [],
      stats: { total: 1, pending: 0, vetoed: 0, manual: 1, lastPassAt: null, truncatedSources: 0 },
    };
    const md = renderGlossary(brief);
    expect(md).toContain("nimbus.toml");
    expect(md).not.toContain("quoted verbatim");
  });

  test("list mode marks an authored entry with an '— authored' suffix", () => {
    const brief: GlossaryBrief = {
      ...GLOSSARY_BASE,
      gaps: [],
      query: { term: null, limit: 10 },
      mode: "list",
      entries: [
        glossaryEntryFixture({ term: "CDR", docFreq: 0 }),
        glossaryEntryFixture({ term: "widget", definitionSource: "llm", docFreq: 12 }),
      ],
      matchedVia: null,
      suggestions: [],
      stats: { total: 2, pending: 0, vetoed: 0, manual: 1, lastPassAt: null, truncatedSources: 0 },
    };
    const md = renderGlossary(brief);
    expect(md).toContain("**CDR** — 0 mention(s) — authored");
    // A mined entry's line must NOT pick up the authored suffix.
    expect(md).toContain("**widget** — 12 mention(s)");
    expect(md).not.toContain("widget** — 12 mention(s) — authored");
  });
});
