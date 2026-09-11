import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createMemoryIndexDb } from "../connectors/connector-sync-test-helpers.ts";
import { DEFAULT_DEPLOY_WORKFLOW_PATTERN, type ServiceConfig } from "../metrics/dora-config.ts";
import { buildChangelogBrief, CHANGELOG_CATEGORY_CAP, emitChangelogBrief } from "./changelog.ts";
import type { ChangelogScope } from "./changelog-queries.ts";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

/**
 * The REAL migrated schema, not a hand-written `CREATE TABLE item`.
 *
 * `selectDeployments` JOINs `deployment_items`, so a hand-written `item`-only schema makes the
 * "an empty index yields zero counts, not an error" test below throw an SQLite error instead of
 * proving what it claims — the exact trap the Task 2 integration test was written to avoid.
 */
function emptyDb(): Database {
  return createMemoryIndexDb();
}

function serviceConfig(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    serviceId: "payments",
    repos: [{ provider: "github", providerId: "org/payments" }],
    pagerdutyServices: ["PD123"],
    deployWorkflowPattern: new RegExp(DEFAULT_DEPLOY_WORKFLOW_PATTERN),
    incidentWindowMinutes: 60,
    excludePrLabels: [],
    deployEnvironments: ["prod"],
    severityP1Aliases: [],
    ...overrides,
  };
}

function build(opts: { db?: Database; scope?: ChangelogScope } = {}) {
  return buildChangelogBrief({
    db: opts.db ?? emptyDb(),
    nowMs: NOW,
    lookbackMs: 7 * DAY,
    scope: opts.scope ?? { kind: "all" },
    deployPattern: new RegExp(DEFAULT_DEPLOY_WORKFLOW_PATTERN),
    latencyMs: 1,
  });
}

function insertPr(
  db: Database,
  row: { id: string; service: string; title: string; meta: unknown },
): void {
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, url, modified_at, metadata, synced_at)
     VALUES (?, ?, 'pr', ?, ?, NULL, ?, ?, ?)`,
    [row.id, row.service, row.id, row.title, NOW - DAY, JSON.stringify(row.meta), NOW],
  );
}

describe("buildChangelogBrief", () => {
  test("always carries the unconditional missing-categories gap", () => {
    // Unconditional by design, following `ownership`: a conditional note would be absent
    // exactly when a reader most needs it, and reading "no dependency updates listed" as
    // "no dependency updates happened" is the failure this brief invites.
    const brief = build();
    // Case-insensitive: the sentence opens with "Dependency updates …", and a case-sensitive
    // `includes("dependency")` would fail on a gap that is in fact present.
    expect(brief.gaps.some((g) => g.detail.toLowerCase().includes("dependency"))).toBe(true);
  });

  test("reports the window and service it was asked about", () => {
    const brief = build({ scope: { kind: "service", cfg: serviceConfig() } });
    expect(brief.query).toEqual({ sinceMs: NOW - 7 * DAY, nowMs: NOW, service: "payments" });
  });

  test("an unscoped brief reports no service", () => {
    expect(build().query.service).toBeNull();
  });

  test("an empty index yields zero counts, not an error", () => {
    expect(build().counts).toEqual({
      mergedPrs: 0,
      deployments: 0,
      incidentsOpened: 0,
      incidentsResolved: 0,
    });
  });

  test("discloses index-derived times only when some entry has one", () => {
    expect(build().indexTimedCount).toBe(0);
  });

  test("counts merged PRs the window covers, and reports them as event-timed", () => {
    const db = emptyDb();
    insertPr(db, {
      id: "github:1",
      service: "github",
      title: "Fix auth",
      meta: { merged_at: NOW - 2 * DAY, repo: "org/payments" },
    });
    const brief = build({ db });
    expect(brief.counts.mergedPrs).toBe(1);
    expect(brief.mergedPrs[0]?.title).toBe("Fix auth");
    // `merged_at` is a real event field, so nothing here is index-timed.
    expect(brief.indexTimedCount).toBe(0);
  });

  test("a merged GitLab PR is counted as invisible and disclosed as a gap", () => {
    const db = emptyDb();
    insertPr(db, {
      id: "gitlab:7",
      service: "gitlab",
      title: "Invisible merge",
      meta: { state: "merged" },
    });
    const brief = build({ db });
    expect(brief.nonGithubMergedPrs).toBe(1);
    expect(brief.counts.mergedPrs).toBe(0);
    expect(brief.gaps.some((g) => g.detail.includes("non-GitHub forge"))).toBe(true);
  });

  test("no non-GitHub gap when every merged PR is visible", () => {
    // The gap must be absent at zero, or it reads as a warning about a problem that does not
    // exist — the same suppression rule `negotiate`'s unattributable-incidents clause follows.
    expect(build().gaps.some((g) => g.detail.includes("non-GitHub forge"))).toBe(false);
  });

  test("entries past the per-category cap are dropped and counted, not silently lost", () => {
    const db = emptyDb();
    for (let i = 0; i < CHANGELOG_CATEGORY_CAP + 3; i++) {
      insertPr(db, {
        id: `github:${String(i)}`,
        service: "github",
        title: `PR ${String(i)}`,
        meta: { merged_at: NOW - DAY, repo: "org/payments" },
      });
    }
    const brief = build({ db });
    expect(brief.counts.mergedPrs).toBe(CHANGELOG_CATEGORY_CAP);
    expect(brief.mergedPrs).toHaveLength(CHANGELOG_CATEGORY_CAP);
    expect(brief.truncatedCount).toBe(3);
  });

  test("a service with nothing bound to it is disclosed, not silently empty", () => {
    // An empty changelog and a quiet week are otherwise indistinguishable: with no repos and no
    // PagerDuty ids, every scoped query matches nothing for a REASON the reader must be told.
    const brief = build({
      scope: {
        kind: "service",
        cfg: serviceConfig({ repos: [], pagerdutyServices: [] }),
      },
    });
    expect(brief.gaps.some((g) => g.detail.includes("no repositories and no PagerDuty"))).toBe(
      true,
    );
  });

  test("a service WITH bindings gets no unbound-service gap", () => {
    const brief = build({ scope: { kind: "service", cfg: serviceConfig() } });
    expect(brief.gaps.some((g) => g.detail.includes("no repositories and no PagerDuty"))).toBe(
      false,
    );
  });
});

describe("emitChangelogBrief", () => {
  /**
   * The emit is fire-and-forget, so the test must wait for the notification rather than for a
   * duration. A `setTimeout` here would be a wall-clock assumption on a CI runner that is
   * 13-18x slower than a dev machine at temp-dir SQLite work — the largest single source of
   * cross-platform flakes in this repo. The notify callback IS the completion signal.
   */
  function captureBriefReady(): {
    notify: (method: string, params: unknown) => void;
    ready: Promise<{ method: string; params: unknown }>;
  } {
    let resolve: (v: { method: string; params: unknown }) => void = () => {};
    const ready = new Promise<{ method: string; params: unknown }>((r) => {
      resolve = r;
    });
    return {
      notify: (method, params) => {
        // `briefError` resolves it too: a rejected build must fail the assertion below with the
        // error it carries, not by timing out with no explanation.
        if (method.startsWith("changelog.brief")) resolve({ method, params });
      },
      ready,
    };
  }

  test("emits changelog.briefReady with markdown and the typed findings", async () => {
    const cap = captureBriefReady();
    await emitChangelogBrief({
      db: emptyDb(),
      sessionId: "s1",
      lookbackMs: 7 * DAY,
      service: null,
      serviceConfigs: [],
      notify: cap.notify,
    });
    const ready = await cap.ready;
    expect(ready.method).toBe("changelog.briefReady");
    const params = ready.params as { brief: string; findings: { kind: string } };
    expect(params.findings.kind).toBe("changelog");
    expect(params.brief).toContain("## Merged Pull Requests");
  });

  test("an unconfigured --service still scopes, using the default deploy pattern", async () => {
    const cap = captureBriefReady();
    await emitChangelogBrief({
      db: emptyDb(),
      sessionId: "s2",
      lookbackMs: 7 * DAY,
      service: "not-in-config",
      serviceConfigs: [],
      notify: cap.notify,
    });
    const ready = await cap.ready;
    expect(ready.method).toBe("changelog.briefReady");
    const params = ready.params as { findings: { query: { service: string | null } } };
    expect(params.findings.query.service).toBe("not-in-config");
  });

  test("a synthesis rewrite keeps the Gaps section and the preamble disclosure", async () => {
    // The whole I31 chain for this kind, end to end: the model never sees `## Gaps` (it is
    // withheld and re-attached verbatim), and a rewrite that drops the interleaved preamble
    // sentence is discarded by the contract guard rather than shipped.
    const cap = captureBriefReady();
    let promptSeen = "";
    await emitChangelogBrief({
      db: emptyDb(),
      sessionId: "s4",
      lookbackMs: 7 * DAY,
      service: null,
      serviceConfigs: [],
      notify: cap.notify,
      runner: {
        run: async (prompt: string) => {
          promptSeen = prompt;
          return {
            ok: true,
            markdown: "# Changelog\n\nA quiet week.\n\n## Deployments\n\n_None._\n",
            model: "fake",
            remote: false,
          };
        },
      },
    });
    const ready = await cap.ready;
    expect(ready.method).toBe("changelog.briefReady");
    const params = ready.params as {
      brief: string;
      synthesis: { attempted: boolean; used?: boolean; reason?: string };
    };
    // The prompt's deterministic template half carries no Gaps section (the typed findings JSON
    // still lists the gap notes, so the prose cannot contradict them).
    expect(promptSeen).toContain("Deterministic fallback rendering");
    expect(promptSeen.split("Deterministic fallback rendering")[1]).not.toContain("## Gaps");
    // The rewrite dropped the preamble disclosure, so it is discarded, not shipped.
    expect(params.synthesis.used).toBe(false);
    expect(params.synthesis.reason).toBe("contract_violation");
    expect(params.brief).toContain("## Gaps");
  });

  test("a configured --service uses that service's own deploy pattern", async () => {
    const cap = captureBriefReady();
    await emitChangelogBrief({
      db: emptyDb(),
      sessionId: "s3",
      lookbackMs: 7 * DAY,
      service: "payments",
      serviceConfigs: [serviceConfig()],
      notify: cap.notify,
    });
    const ready = await cap.ready;
    expect(ready.method).toBe("changelog.briefReady");
    const params = ready.params as { findings: { query: { service: string | null } } };
    expect(params.findings.query.service).toBe("payments");
  });
});
