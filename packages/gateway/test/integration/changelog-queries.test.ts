import { describe, expect, test } from "bun:test";
import {
  nonGithubMergedPrCount,
  selectDeployments,
  selectIncidentsOpened,
  selectIncidentsResolved,
  selectMergedPrs,
} from "../../src/agents/changelog-queries.ts";
import { createMemoryIndexDb } from "../../src/connectors/connector-sync-test-helpers.ts";
import {
  DEFAULT_DEPLOY_WORKFLOW_PATTERN,
  type ServiceConfig,
} from "../../src/metrics/dora-config.ts";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
// ABSOLUTE bounds. `sinceMs` as an agent INPUT is a duration repo-wide; `Window` is not an input.
const W = { fromMs: NOW - 7 * DAY, toMs: NOW, scope: { kind: "all" as const } };

/**
 * A fully-populated `ServiceConfig` fixture, all fields required per the real type — repo scoped
 * to `github:org/web` and PagerDuty scoped to `PD123` by default so most scoped tests need only
 * override the one field they're exercising.
 */
function serviceConfig(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    serviceId: "web",
    repos: [{ provider: "github", providerId: "org/web" }],
    pagerdutyServices: ["PD123"],
    deployWorkflowPattern: new RegExp(DEFAULT_DEPLOY_WORKFLOW_PATTERN),
    incidentWindowMinutes: 60,
    excludePrLabels: [],
    deployEnvironments: ["prod"],
    severityP1Aliases: [],
    ...overrides,
  };
}

function scopedWindow(cfg: ServiceConfig): {
  fromMs: number;
  toMs: number;
  scope: { kind: "service"; cfg: ServiceConfig };
} {
  return { fromMs: W.fromMs, toMs: W.toMs, scope: { kind: "service", cfg } };
}

function insertItem(
  db: ReturnType<typeof createMemoryIndexDb>,
  row: {
    id: string;
    service: string;
    type: string;
    title: string;
    modifiedAt: number;
    meta: unknown;
  },
): void {
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, url, modified_at, metadata, synced_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    [
      row.id,
      row.service,
      row.type,
      row.id,
      row.title,
      row.modifiedAt,
      JSON.stringify(row.meta),
      NOW,
    ],
  );
}

describe("changelog queries against the real migrated schema", () => {
  test("a merged PR inside the window is returned; one merged before it is not", () => {
    const db = createMemoryIndexDb();
    insertItem(db, {
      id: "github:1",
      service: "github",
      type: "pr",
      title: "In window",
      modifiedAt: NOW,
      meta: { merged_at: NOW - DAY },
    });
    insertItem(db, {
      id: "github:2",
      service: "github",
      type: "pr",
      title: "Too old",
      modifiedAt: NOW,
      meta: { merged_at: NOW - 30 * DAY },
    });

    const rows = selectMergedPrs(db, W);
    expect(rows.map((r) => r.title)).toEqual(["In window"]);
    expect(rows[0]?.timeSource).toBe("event");
  });

  test("an OPEN PR is excluded even though modified_at is inside the window", () => {
    // The whole point of event-time windowing: modified_at says "touched", not "merged".
    const db = createMemoryIndexDb();
    insertItem(db, {
      id: "github:3",
      service: "github",
      type: "pr",
      title: "Still open",
      modifiedAt: NOW - DAY,
      meta: { state: "open" },
    });
    expect(selectMergedPrs(db, W)).toEqual([]);
  });

  test("malformed metadata JSON does not throw", () => {
    // json_extract RAISES on malformed JSON in this position; json_valid must guard it.
    const db = createMemoryIndexDb();
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, modified_at, metadata, synced_at)
       VALUES ('github:4','github','pr','4','Broken',?,'{not json',?)`,
      [NOW, NOW],
    );
    expect(() => selectMergedPrs(db, W)).not.toThrow();
  });

  test("the window is half-open: an event exactly at nowMs is excluded", () => {
    const db = createMemoryIndexDb();
    insertItem(db, {
      id: "github:5",
      service: "github",
      type: "pr",
      title: "On the edge",
      modifiedAt: NOW,
      meta: { merged_at: NOW },
    });
    expect(selectMergedPrs(db, W)).toEqual([]);
  });

  test("non-GitHub merged PRs are counted for disclosure, not silently dropped", () => {
    const db = createMemoryIndexDb();
    insertItem(db, {
      id: "gitlab:9",
      service: "gitlab",
      type: "pr",
      title: "Merged MR",
      modifiedAt: NOW - DAY,
      meta: { state: "merged" },
    });
    expect(selectMergedPrs(db, W)).toEqual([]);
    expect(nonGithubMergedPrCount(db, W)).toBe(1);
  });

  test("a successful CI run that is not a deploy is excluded", () => {
    // Counting every green ci_run would report "Run tests" and "Lint" as deployments.
    const db = createMemoryIndexDb();
    insertItem(db, {
      id: "gha:1",
      service: "github_actions",
      type: "ci_run",
      title: "Run tests",
      modifiedAt: NOW - DAY,
      meta: { conclusion: "success" },
    });
    insertItem(db, {
      id: "gha:2",
      service: "github_actions",
      type: "ci_run",
      title: "Deploy to prod",
      modifiedAt: NOW - DAY,
      meta: { conclusion: "success" },
    });

    const rows = selectDeployments(db, W, new RegExp(DEFAULT_DEPLOY_WORKFLOW_PATTERN));
    expect(rows.map((r) => r.title)).toEqual(["Deploy to prod"]);
  });

  test("an annotated deploy is timed from finished_at_ms, a real event time", () => {
    const db = createMemoryIndexDb();
    insertItem(db, {
      id: "dep:1",
      service: "github_actions",
      type: "deployment",
      title: "web",
      modifiedAt: NOW,
      meta: {},
    });
    db.run(
      `INSERT INTO deployment_items (id, provider, nimbus_service_id, environment, sha, ref,
        started_at_ms, finished_at_ms, conclusion, created_at)
       VALUES ('dep:1','github-actions','web','staging','abc','main',?,?,'success',?)`,
      [NOW - 2 * DAY, NOW - DAY, NOW],
    );

    const rows = selectDeployments(db, W, new RegExp(DEFAULT_DEPLOY_WORKFLOW_PATTERN));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.atMs).toBe(NOW - DAY);
    // A real column, not modified_at — so not an approximation.
    expect(rows[0]?.timeSource).toBe("event");
    // Staging counts: a changelog answers "what happened", and the environment is on the entry.
    expect(rows[0]?.title).toContain("staging");
  });

  test("an incident without opened_at_ms is excluded", () => {
    const db = createMemoryIndexDb();
    insertItem(db, {
      id: "pagerduty:1",
      service: "pagerduty",
      type: "incident",
      title: "No time",
      modifiedAt: NOW - DAY,
      meta: {},
    });
    expect(selectIncidentsOpened(db, W)).toEqual([]);
  });

  test("selectMergedPrs scopes to the configured repo URN; a different repo's merged PR is excluded", () => {
    const db = createMemoryIndexDb();
    const cfg = serviceConfig();
    insertItem(db, {
      id: "github:10",
      service: "github",
      type: "pr",
      title: "In scope",
      modifiedAt: NOW,
      meta: { merged_at: NOW - DAY, repo: "org/web" },
    });
    insertItem(db, {
      id: "github:11",
      service: "github",
      type: "pr",
      title: "Other repo",
      modifiedAt: NOW,
      meta: { merged_at: NOW - DAY, repo: "org/other" },
    });

    const rows = selectMergedPrs(db, scopedWindow(cfg));
    expect(rows.map((r) => r.title)).toEqual(["In scope"]);
  });

  test("selectDeployments' CI-run leg scopes to the configured repo URN", () => {
    const db = createMemoryIndexDb();
    const cfg = serviceConfig();
    insertItem(db, {
      id: "gha:10",
      service: "github_actions",
      type: "ci_run",
      title: "Deploy to prod",
      modifiedAt: NOW - DAY,
      meta: { conclusion: "success", repo: "org/web" },
    });
    insertItem(db, {
      id: "gha:11",
      service: "github_actions",
      type: "ci_run",
      title: "Deploy to prod",
      modifiedAt: NOW - DAY,
      meta: { conclusion: "success", repo: "org/other" },
    });

    const rows = selectDeployments(db, scopedWindow(cfg), cfg.deployWorkflowPattern);
    expect(rows.map((r) => r.id)).toEqual(["gha:10"]);
  });

  test("selectDeployments' annotated leg scopes to nimbus_service_id, not the CI connector's item.service", () => {
    const db = createMemoryIndexDb();
    const cfg = serviceConfig(); // serviceId: "web"
    insertItem(db, {
      id: "dep:2",
      service: "github_actions",
      type: "deployment",
      title: "web",
      modifiedAt: NOW,
      meta: {},
    });
    db.run(
      `INSERT INTO deployment_items (id, provider, nimbus_service_id, environment, sha, ref,
        started_at_ms, finished_at_ms, conclusion, created_at)
       VALUES ('dep:2','github-actions','web','prod','abc','main',?,?,'success',?)`,
      [NOW - 2 * DAY, NOW - DAY, NOW],
    );
    insertItem(db, {
      id: "dep:3",
      service: "github_actions",
      type: "deployment",
      title: "other",
      modifiedAt: NOW,
      meta: {},
    });
    db.run(
      `INSERT INTO deployment_items (id, provider, nimbus_service_id, environment, sha, ref,
        started_at_ms, finished_at_ms, conclusion, created_at)
       VALUES ('dep:3','github-actions','other-service','prod','def','main',?,?,'success',?)`,
      [NOW - 2 * DAY, NOW - DAY, NOW],
    );

    const rows = selectDeployments(db, scopedWindow(cfg), cfg.deployWorkflowPattern);
    expect(rows.map((r) => r.id)).toEqual(["dep:2"]);
  });

  test("selectIncidentsOpened scopes to the configured pagerduty_service_id", () => {
    const db = createMemoryIndexDb();
    const cfg = serviceConfig(); // pagerdutyServices: ["PD123"]
    insertItem(db, {
      id: "pagerduty:2",
      service: "pagerduty",
      type: "incident",
      title: "In scope",
      modifiedAt: NOW - DAY,
      meta: { opened_at_ms: NOW - DAY, pagerduty_service_id: "PD123" },
    });
    insertItem(db, {
      id: "pagerduty:3",
      service: "pagerduty",
      type: "incident",
      title: "Other service",
      modifiedAt: NOW - DAY,
      meta: { opened_at_ms: NOW - DAY, pagerduty_service_id: "PD999" },
    });

    const rows = selectIncidentsOpened(db, scopedWindow(cfg));
    expect(rows.map((r) => r.id)).toEqual(["pagerduty:2"]);
  });

  test("a scoped service with no PagerDuty services mapped matches nothing, not everything", () => {
    // The fail-closed case: an empty `IN ()` list is a SQL syntax error, and omitting the
    // clause entirely would silently widen a scoped query back to every service's incidents.
    const db = createMemoryIndexDb();
    const cfg = serviceConfig({ pagerdutyServices: [] });
    insertItem(db, {
      id: "pagerduty:4",
      service: "pagerduty",
      type: "incident",
      title: "Any incident",
      modifiedAt: NOW - DAY,
      meta: { opened_at_ms: NOW - DAY, pagerduty_service_id: "PD123" },
    });

    expect(selectIncidentsOpened(db, scopedWindow(cfg))).toEqual([]);
  });

  test("selectIncidentsResolved returns a resolved incident and excludes one that is not resolved", () => {
    const db = createMemoryIndexDb();
    insertItem(db, {
      id: "pagerduty:5",
      service: "pagerduty",
      type: "incident",
      title: "Resolved",
      modifiedAt: NOW - DAY,
      meta: { status: "resolved" },
    });
    insertItem(db, {
      id: "pagerduty:6",
      service: "pagerduty",
      type: "incident",
      title: "Still open",
      modifiedAt: NOW - DAY,
      meta: { status: "triggered" },
    });

    const rows = selectIncidentsResolved(db, W);
    expect(rows.map((r) => r.title)).toEqual(["Resolved"]);
    expect(rows[0]?.timeSource).toBe("index");
  });

  test("selectIncidentsResolved scopes to the configured pagerduty_service_id", () => {
    const db = createMemoryIndexDb();
    const cfg = serviceConfig(); // pagerdutyServices: ["PD123"]
    insertItem(db, {
      id: "pagerduty:7",
      service: "pagerduty",
      type: "incident",
      title: "In scope",
      modifiedAt: NOW - DAY,
      meta: { status: "resolved", pagerduty_service_id: "PD123" },
    });
    insertItem(db, {
      id: "pagerduty:8",
      service: "pagerduty",
      type: "incident",
      title: "Other service",
      modifiedAt: NOW - DAY,
      meta: { status: "resolved", pagerduty_service_id: "PD999" },
    });

    const rows = selectIncidentsResolved(db, scopedWindow(cfg));
    expect(rows.map((r) => r.id)).toEqual(["pagerduty:7"]);
  });

  test("rows sharing a timestamp come back in a stable, id-ordered sequence", () => {
    // The comparator sorted on `atMs` alone, so a tie left the order to SQLite's unspecified
    // `SELECT` sequence — and `changelog.ts`'s `cap()` keeps the FIRST 50 rows of a category, so
    // with more than 50 sharing a timestamp (a bulk backfill, one pipeline's batch of deploys)
    // which entries a reader sees was arbitrary. `nimbus fleet digest` compares `findings_json`
    // between runs, so that instability surfaces as a change that never happened.
    const db = createMemoryIndexDb();
    const mergedAt = NOW - DAY;
    // Inserted in an order that is neither the id order nor its reverse, so a comparator
    // ignoring `id` cannot produce the expected sequence by accident.
    for (const id of ["github:c", "github:a", "github:d", "github:b"]) {
      insertItem(db, {
        id,
        service: "github",
        type: "pr",
        title: id,
        modifiedAt: NOW,
        meta: { merged_at: mergedAt },
      });
    }
    const ids = selectMergedPrs(db, W).map((r) => r.id);
    expect(ids).toEqual(["github:a", "github:b", "github:c", "github:d"]);
  });

  test("the id tiebreak never outranks recency", () => {
    // The tiebreak must be exactly that. If `id` were compared first — or the subtraction were
    // dropped — the newest entry would stop being the first one listed.
    const db = createMemoryIndexDb();
    insertItem(db, {
      id: "github:z",
      service: "github",
      type: "pr",
      title: "newest",
      modifiedAt: NOW,
      meta: { merged_at: NOW - DAY },
    });
    insertItem(db, {
      id: "github:a",
      service: "github",
      type: "pr",
      title: "older",
      modifiedAt: NOW,
      meta: { merged_at: NOW - 2 * DAY },
    });
    expect(selectMergedPrs(db, W).map((r) => r.id)).toEqual(["github:z", "github:a"]);
  });
});
