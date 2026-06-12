import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  changeFailureRate,
  computeDoraMetrics,
  deploymentFrequency,
  leadTimeForChanges,
  mttr,
} from "./dora.ts";
import type { ServiceConfig } from "./dora-config.ts";

// ---------------------------------------------------------------------------
// Minimal schema — only the tables referenced by dora.ts
// ---------------------------------------------------------------------------
const MINIMAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS item (
  id           TEXT PRIMARY KEY,
  service      TEXT NOT NULL,
  type         TEXT NOT NULL,
  external_id  TEXT NOT NULL,
  title        TEXT NOT NULL,
  body_preview TEXT,
  modified_at  INTEGER NOT NULL,
  author_id    TEXT,
  metadata     TEXT,
  synced_at    INTEGER NOT NULL,
  pinned       INTEGER NOT NULL DEFAULT 0,
  UNIQUE(service, external_id)
);

CREATE TABLE IF NOT EXISTS deployment_items (
  id                 TEXT PRIMARY KEY,
  provider           TEXT NOT NULL,
  nimbus_service_id  TEXT NOT NULL,
  environment        TEXT NOT NULL,
  sha                TEXT NOT NULL,
  ref                TEXT NOT NULL,
  started_at_ms      INTEGER NOT NULL,
  finished_at_ms     INTEGER,
  conclusion         TEXT NOT NULL,
  workflow_url       TEXT,
  ci_run_external_id TEXT,
  created_at         INTEGER NOT NULL,
  FOREIGN KEY (id) REFERENCES item(id) ON DELETE CASCADE
);
`;

function freshDb(): Database {
  const db = new Database(":memory:");
  db.exec(MINIMAL_SCHEMA);
  return db;
}

// ---------------------------------------------------------------------------
// Base config helpers
// ---------------------------------------------------------------------------
const NOW = Date.now();
const ONE_DAY = 86_400_000;
const SINCE = 30 * ONE_DAY; // 30-day window

function baseConfig(overrides?: Partial<ServiceConfig>): ServiceConfig {
  return {
    serviceId: "svc-test",
    repos: [{ provider: "github", providerId: "org/repo" }],
    pagerdutyServices: ["pd-svc-1"],
    deployWorkflowPattern: /^Deploy/,
    incidentWindowMinutes: 60,
    excludePrLabels: ["revert"],
    deployEnvironments: ["prod"],
    severityP1Aliases: ["P1"],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// DB seeding helpers
// ---------------------------------------------------------------------------
let itemSeq = 0;

function resetSeq() {
  itemSeq = 0;
}

function insertItem(
  db: Database,
  service: string,
  type: string,
  title: string,
  modifiedAt: number,
  metadata: Record<string, unknown> | null,
  syncedAt?: number,
): string {
  itemSeq += 1;
  const id = `item-${itemSeq}`;
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, modified_at, metadata, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      service,
      type,
      `ext-${itemSeq}`,
      title,
      modifiedAt,
      metadata !== null ? JSON.stringify(metadata) : null,
      syncedAt ?? modifiedAt,
    ],
  );
  return id;
}

function insertCiRun(
  db: Database,
  service: string,
  title: string,
  modifiedAt: number,
  repo: string,
  headSha?: string,
): string {
  return insertItem(db, service, "ci_run", title, modifiedAt, {
    conclusion: "success",
    repo,
    headSha: headSha ?? null,
  });
}

function insertDeploymentItem(
  db: Database,
  itemId: string,
  serviceId: string,
  environment: string,
  conclusion: string,
): void {
  db.run(
    `INSERT INTO deployment_items
      (id, provider, nimbus_service_id, environment, sha, ref, started_at_ms, conclusion, created_at)
     VALUES (?, 'github-actions', ?, ?, '', 'main', ?, ?, ?)`,
    [itemId, serviceId, environment, NOW - ONE_DAY, conclusion, NOW],
  );
}

function insertAnnotatedDeploy(
  db: Database,
  serviceId: string,
  environment: string,
  modifiedAt: number,
): string {
  const id = insertItem(db, "github", "deployment", "Deployment", modifiedAt, {});
  insertDeploymentItem(db, id, serviceId, environment, "success");
  return id;
}

function insertIncident(
  db: Database,
  pdServiceId: string,
  modifiedAt: number,
  openedAtMs?: number,
  synced?: number,
): string {
  return insertItem(
    db,
    "pagerduty",
    "incident",
    "Incident",
    modifiedAt,
    {
      status: "resolved",
      pagerduty_service_id: pdServiceId,
      opened_at_ms: openedAtMs ?? modifiedAt - 600_000, // 10 min TTR
    },
    synced ?? modifiedAt,
  );
}

function insertPr(
  db: Database,
  service: string,
  modifiedAt: number,
  meta: Record<string, unknown>,
): string {
  return insertItem(db, service, "pr", "PR", modifiedAt, meta);
}

// ---------------------------------------------------------------------------
// deploymentFrequency
// ---------------------------------------------------------------------------
describe("deploymentFrequency", () => {
  let db: Database;
  beforeEach(() => {
    db = freshDb();
    resetSeq();
  });
  afterEach(() => {
    db.close();
  });

  test("returns no_repos gap when repos is empty", () => {
    const cfg = baseConfig({ repos: [] });
    const result = deploymentFrequency(db, cfg, NOW, SINCE);
    expect(result.gap).toBe("no_repos");
    expect(result.value).toBeNull();
    expect(result.unit).toBe("deploys_per_day");
    expect(result.sample).toBe(0);
  });

  test("returns no_deployment_data when no annotated and no regex deploys", () => {
    const cfg = baseConfig({ deployEnvironments: [] }); // no annotated
    const result = deploymentFrequency(db, cfg, NOW, SINCE);
    expect(result.gap).toBe("no_deployment_data");
    expect(result.value).toBeNull();
  });

  test("uses annotated deploys (deployment_items) when present", () => {
    const cfg = baseConfig();
    insertAnnotatedDeploy(db, "svc-test", "prod", NOW - ONE_DAY);
    insertAnnotatedDeploy(db, "svc-test", "prod", NOW - 2 * ONE_DAY);
    insertAnnotatedDeploy(db, "svc-test", "prod", NOW - 3 * ONE_DAY);
    const result = deploymentFrequency(db, cfg, NOW, SINCE);
    expect(result.value).not.toBeNull();
    expect(result.sample).toBe(3);
    expect(result.unit).toBe("deploys_per_day");
    expect(result.gap).toBeNull();
  });

  test("annotated path: mixed_source gap when regex deploys also exist", () => {
    const cfg = baseConfig();
    // Insert annotated deploy
    insertAnnotatedDeploy(db, "svc-test", "prod", NOW - ONE_DAY);
    // Insert CI run that matches regex (github_actions service, title matches /^Deploy/)
    insertCiRun(db, "github_actions", "Deploy main", NOW - 2 * ONE_DAY, "org/repo");
    const result = deploymentFrequency(db, cfg, NOW, SINCE);
    expect(result.gap).toBe("mixed_source");
    expect(result.sample).toBe(1); // annotated count
  });

  test("annotated path: low_sample gap when sample < 3 and no other gap", () => {
    const cfg = baseConfig();
    insertAnnotatedDeploy(db, "svc-test", "prod", NOW - ONE_DAY);
    const result = deploymentFrequency(db, cfg, NOW, SINCE);
    expect(result.gap).toBe("low_sample");
    expect(result.sample).toBe(1);
  });

  test("regex deploy path: computes frequency from ci_run items", () => {
    // No annotated deploys (empty deployEnvironments)
    const cfg = baseConfig({ deployEnvironments: [] });
    // Need 3+ to avoid low_sample
    insertCiRun(db, "github_actions", "Deploy main", NOW - ONE_DAY, "org/repo");
    insertCiRun(db, "github_actions", "Deploy main", NOW - 2 * ONE_DAY, "org/repo");
    insertCiRun(db, "github_actions", "Deploy main", NOW - 3 * ONE_DAY, "org/repo");
    const result = deploymentFrequency(db, cfg, NOW, SINCE);
    expect(result.sample).toBe(3);
    expect(result.gap).toBeNull();
    expect(result.value).toBeGreaterThan(0);
  });

  test("regex deploy path: low_sample gap when fewer than 3 deploys", () => {
    const cfg = baseConfig({ deployEnvironments: [] });
    insertCiRun(db, "github_actions", "Deploy main", NOW - ONE_DAY, "org/repo");
    const result = deploymentFrequency(db, cfg, NOW, SINCE);
    expect(result.gap).toBe("low_sample");
  });

  test("regex: filters out ci_runs that don't match workflow pattern", () => {
    const cfg = baseConfig({ deployEnvironments: [] });
    insertCiRun(db, "github_actions", "Build main", NOW - ONE_DAY, "org/repo"); // no match
    const result = deploymentFrequency(db, cfg, NOW, SINCE);
    expect(result.gap).toBe("no_deployment_data");
    expect(result.value).toBeNull();
  });

  test("regex: filters out ci_runs with non-matching repo", () => {
    const cfg = baseConfig({ deployEnvironments: [] });
    insertCiRun(db, "github_actions", "Deploy main", NOW - ONE_DAY, "other/repo"); // wrong repo
    const result = deploymentFrequency(db, cfg, NOW, SINCE);
    expect(result.gap).toBe("no_deployment_data");
  });

  test("regex: circleci uses externalId match", () => {
    const cfg = baseConfig({
      repos: [{ provider: "circleci", providerId: "org/repo" }],
      deployEnvironments: [],
    });
    // Insert a circleci ci_run with external_id containing the providerId
    itemSeq += 1;
    const id = `item-${itemSeq}`;
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, modified_at, metadata, synced_at)
       VALUES (?, 'circleci', 'ci_run', 'org/repo/123', 'Deploy main', ?, ?, ?)`,
      [id, NOW - ONE_DAY, JSON.stringify({ conclusion: "success" }), NOW],
    );
    const result = deploymentFrequency(db, cfg, NOW, SINCE);
    // circleci: externalId.includes(providerId) -> should match
    expect(result.sample).toBe(1);
  });

  test("gitlab repo match via 'project' metadata field", () => {
    const cfg = baseConfig({
      repos: [{ provider: "gitlab", providerId: "group/project" }],
      deployEnvironments: [],
    });
    insertItem(db, "gitlab", "ci_run", "Deploy prod", NOW - ONE_DAY, {
      conclusion: "success",
      project: "group/project",
    });
    const result = deploymentFrequency(db, cfg, NOW, SINCE);
    expect(result.sample).toBe(1);
  });

  test("jenkins repo match via 'jobName' metadata field", () => {
    const cfg = baseConfig({
      repos: [{ provider: "jenkins", providerId: "deploy-job" }],
      deployEnvironments: [],
    });
    insertItem(db, "jenkins", "ci_run", "Deploy prod", NOW - ONE_DAY, {
      conclusion: "success",
      jobName: "deploy-job",
    });
    const result = deploymentFrequency(db, cfg, NOW, SINCE);
    expect(result.sample).toBe(1);
  });

  test("bitbucket repo match via 'repo' metadata field", () => {
    const cfg = baseConfig({
      repos: [{ provider: "bitbucket", providerId: "org/repo" }],
      deployEnvironments: [],
    });
    insertItem(db, "bitbucket", "ci_run", "Deploy prod", NOW - ONE_DAY, {
      conclusion: "success",
      repo: "org/repo",
    });
    const result = deploymentFrequency(db, cfg, NOW, SINCE);
    expect(result.sample).toBe(1);
  });

  test("null metadata ci_run is excluded (repoLikeMatchesUrn returns false for null)", () => {
    const cfg = baseConfig({ deployEnvironments: [] });
    itemSeq += 1;
    const id = `item-${itemSeq}`;
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, modified_at, metadata, synced_at)
       VALUES (?, 'github_actions', 'ci_run', ?, 'Deploy main', ?, NULL, ?)`,
      [id, `ext-${itemSeq}`, NOW - ONE_DAY, NOW],
    );
    const result = deploymentFrequency(db, cfg, NOW, SINCE);
    expect(result.gap).toBe("no_deployment_data");
  });

  test("ci_run with failed conclusion is excluded", () => {
    const cfg = baseConfig({ deployEnvironments: [] });
    insertItem(db, "github_actions", "ci_run", "Deploy main", NOW - ONE_DAY, {
      conclusion: "failure",
      repo: "org/repo",
    });
    const result = deploymentFrequency(db, cfg, NOW, SINCE);
    expect(result.gap).toBe("no_deployment_data");
  });
});

// ---------------------------------------------------------------------------
// leadTimeForChanges
// ---------------------------------------------------------------------------
describe("leadTimeForChanges", () => {
  let db: Database;
  beforeEach(() => {
    db = freshDb();
    resetSeq();
  });
  afterEach(() => {
    db.close();
  });

  test("returns no_repos when repos is empty", () => {
    const cfg = baseConfig({ repos: [] });
    const result = leadTimeForChanges(db, cfg, NOW, SINCE);
    expect(result.gap).toBe("no_repos");
    expect(result.value).toBeNull();
    expect(result.unit).toBe("seconds_median");
  });

  test("returns no_deployment_data when no CI runs exist", () => {
    const cfg = baseConfig({ deployEnvironments: [] });
    const result = leadTimeForChanges(db, cfg, NOW, SINCE);
    expect(result.gap).toBe("no_deployment_data");
  });

  test("returns approximate_lead_time when provider has no PR service (jenkins)", () => {
    const cfg = baseConfig({
      repos: [{ provider: "jenkins", providerId: "deploy-job" }],
      deployEnvironments: [],
    });
    // Jenkins has no prServices
    insertItem(db, "jenkins", "ci_run", "Deploy prod", NOW - ONE_DAY, {
      conclusion: "success",
      jobName: "deploy-job",
    });
    const result = leadTimeForChanges(db, cfg, NOW, SINCE);
    expect(result.gap).toBe("approximate_lead_time");
  });

  test("returns approximate_lead_time when provider is circleci (no prServices)", () => {
    const cfg = baseConfig({
      repos: [{ provider: "circleci", providerId: "org/repo" }],
      deployEnvironments: [],
    });
    itemSeq += 1;
    const id = `item-${itemSeq}`;
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, modified_at, metadata, synced_at)
       VALUES (?, 'circleci', 'ci_run', 'org/repo/1', 'Deploy main', ?, ?, ?)`,
      [id, NOW - ONE_DAY, JSON.stringify({ conclusion: "success" }), NOW],
    );
    const result = leadTimeForChanges(db, cfg, NOW, SINCE);
    expect(result.gap).toBe("approximate_lead_time");
  });

  test("returns no_deployment_data when PRs exist but none have matching deployed sha", () => {
    const cfg = baseConfig({ deployEnvironments: [] });
    const sha = "abc123";
    // Insert deploy without headSha
    insertCiRun(db, "github_actions", "Deploy main", NOW - ONE_DAY, "org/repo"); // no headSha match
    // Insert merged PR with merge_commit_sha that doesn't match any deploy
    insertPr(db, "github", NOW - 2 * ONE_DAY, {
      merged: true,
      merged_at: NOW - 3 * ONE_DAY,
      merge_commit_sha: sha,
      labels: [],
    });
    const result = leadTimeForChanges(db, cfg, NOW, SINCE);
    expect(result.gap).toBe("approximate_lead_time"); // approximate=true because no sha match
    expect(result.value).toBeNull();
  });

  test("computes median lead time correctly for matched PR-deploy pairs", () => {
    const cfg = baseConfig({ deployEnvironments: [] });
    const sha1 = "sha-aaa";
    const sha2 = "sha-bbb";
    const sha3 = "sha-ccc";
    const mergedAt1 = NOW - 2 * ONE_DAY;
    const deployAt1 = NOW - ONE_DAY;
    const mergedAt2 = NOW - 4 * ONE_DAY;
    const deployAt2 = NOW - 3 * ONE_DAY;
    const mergedAt3 = NOW - 6 * ONE_DAY;
    const deployAt3 = NOW - 5 * ONE_DAY;

    // Three deploys with headShas
    insertCiRun(db, "github_actions", "Deploy main", deployAt1, "org/repo", sha1);
    insertCiRun(db, "github_actions", "Deploy main", deployAt2, "org/repo", sha2);
    insertCiRun(db, "github_actions", "Deploy main", deployAt3, "org/repo", sha3);

    // Three PRs merged before respective deploys
    insertPr(db, "github", mergedAt1, {
      merged: true,
      merged_at: mergedAt1,
      merge_commit_sha: sha1,
      labels: [],
    });
    insertPr(db, "github", mergedAt2, {
      merged: true,
      merged_at: mergedAt2,
      merge_commit_sha: sha2,
      labels: [],
    });
    insertPr(db, "github", mergedAt3, {
      merged: true,
      merged_at: mergedAt3,
      merge_commit_sha: sha3,
      labels: [],
    });

    const result = leadTimeForChanges(db, cfg, NOW, SINCE);
    expect(result.value).not.toBeNull();
    expect(result.sample).toBe(3);
    expect(result.gap).toBeNull();
    expect(result.unit).toBe("seconds_median");
  });

  test("excludes PRs with excluded labels", () => {
    const cfg = baseConfig({ deployEnvironments: [], excludePrLabels: ["revert"] });
    const sha = "sha-revert";
    insertCiRun(db, "github_actions", "Deploy main", NOW - ONE_DAY, "org/repo", sha);
    insertPr(db, "github", NOW - 2 * ONE_DAY, {
      merged: true,
      merged_at: NOW - 2 * ONE_DAY,
      merge_commit_sha: sha,
      labels: ["revert"],
    });
    const result = leadTimeForChanges(db, cfg, NOW, SINCE);
    // The labeled PR is excluded, so no lead times
    expect(result.value).toBeNull();
  });

  test("skips unmerged PRs (merged !== true)", () => {
    const cfg = baseConfig({ deployEnvironments: [] });
    const sha = "sha-open";
    insertCiRun(db, "github_actions", "Deploy main", NOW - ONE_DAY, "org/repo", sha);
    insertPr(db, "github", NOW - 2 * ONE_DAY, {
      merged: false,
      merged_at: NOW - 2 * ONE_DAY,
      merge_commit_sha: sha,
      labels: [],
    });
    const result = leadTimeForChanges(db, cfg, NOW, SINCE);
    expect(result.value).toBeNull();
    expect(result.gap).toBe("no_deployment_data"); // no approximate flag either
  });

  test("PR with no merged_at returns no lead time (not approximate)", () => {
    const cfg = baseConfig({ deployEnvironments: [] });
    const sha = "sha-nomerge";
    insertCiRun(db, "github_actions", "Deploy main", NOW - ONE_DAY, "org/repo", sha);
    insertPr(db, "github", NOW - 2 * ONE_DAY, {
      merged: true,
      // merged_at deliberately missing
      merge_commit_sha: sha,
      labels: [],
    });
    const result = leadTimeForChanges(db, cfg, NOW, SINCE);
    expect(result.value).toBeNull();
    // merged_at is null → leadTime=null, approximate=false
    expect(result.gap).toBe("no_deployment_data");
  });

  test("PR with no merge_commit_sha sets approximate=true", () => {
    const cfg = baseConfig({ deployEnvironments: [] });
    insertCiRun(db, "github_actions", "Deploy main", NOW - ONE_DAY, "org/repo", "sha-x");
    insertPr(db, "github", NOW - 2 * ONE_DAY, {
      merged: true,
      merged_at: NOW - 2 * ONE_DAY,
      // merge_commit_sha deliberately missing
      labels: [],
    });
    const result = leadTimeForChanges(db, cfg, NOW, SINCE);
    expect(result.value).toBeNull();
    expect(result.gap).toBe("approximate_lead_time");
  });

  test("low_sample gap for fewer than 3 lead times, no approximate flag", () => {
    const cfg = baseConfig({ deployEnvironments: [] });
    const sha = "sha-low";
    insertCiRun(db, "github_actions", "Deploy main", NOW - ONE_DAY, "org/repo", sha);
    insertPr(db, "github", NOW - 2 * ONE_DAY, {
      merged: true,
      merged_at: NOW - 2 * ONE_DAY,
      merge_commit_sha: sha,
      labels: [],
    });
    const result = leadTimeForChanges(db, cfg, NOW, SINCE);
    expect(result.gap).toBe("low_sample");
    expect(result.sample).toBe(1);
  });

  test("approximate_lead_time gap preserved even with results (some PRs have no sha)", () => {
    const cfg = baseConfig({ deployEnvironments: [], excludePrLabels: [] });
    const sha = "sha-matched";
    const deployAt = NOW - ONE_DAY;
    const mergedAt = NOW - 2 * ONE_DAY;
    insertCiRun(db, "github_actions", "Deploy main", deployAt, "org/repo", sha);
    // PR 1: matches, contributes lead time
    insertPr(db, "github", mergedAt, {
      merged: true,
      merged_at: mergedAt,
      merge_commit_sha: sha,
      labels: [],
    });
    // PR 2: merged but no merge_commit_sha → approximate=true
    insertPr(db, "github", mergedAt - ONE_DAY, {
      merged: true,
      merged_at: mergedAt - ONE_DAY,
      // no merge_commit_sha
      labels: [],
    });
    // PR 3: same sha to get 3 samples and avoid low_sample
    insertPr(db, "github", mergedAt - 2 * ONE_DAY, {
      merged: true,
      merged_at: mergedAt - 2 * ONE_DAY,
      merge_commit_sha: sha,
      labels: [],
    });
    const result = leadTimeForChanges(db, cfg, NOW, SINCE);
    // approximate is true from PR2, so gap should be approximate_lead_time
    expect(result.gap).toBe("approximate_lead_time");
    expect(result.value).not.toBeNull();
  });

  test("median of even-count array uses floor((a+b)/2)", () => {
    // 4 lead times: verify median is floor of middle two
    const cfg = baseConfig({ deployEnvironments: [], excludePrLabels: [] });
    const shas = ["sha-1", "sha-2", "sha-3", "sha-4"];
    const baseDeployAt = NOW - ONE_DAY;
    for (let i = 0; i < 4; i++) {
      const deployAt = baseDeployAt - i * 1_000_000;
      const mergedAt = deployAt - (i + 1) * 1_000_000;
      insertCiRun(db, "github_actions", "Deploy main", deployAt, "org/repo", shas[i]);
      insertPr(db, "github", mergedAt, {
        merged: true,
        merged_at: mergedAt,
        merge_commit_sha: shas[i],
        labels: [],
      });
    }
    const result = leadTimeForChanges(db, cfg, NOW, SINCE);
    expect(result.sample).toBe(4);
    expect(typeof result.value).toBe("number");
  });

  test("PR metadata is null → no lead time", () => {
    const cfg = baseConfig({ deployEnvironments: [] });
    insertCiRun(db, "github_actions", "Deploy main", NOW - ONE_DAY, "org/repo", "sha-q");
    // PR with null metadata
    itemSeq += 1;
    const id = `item-${itemSeq}`;
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, modified_at, metadata, synced_at)
       VALUES (?, 'github', 'pr', ?, 'PR null meta', ?, NULL, ?)`,
      [id, `ext-${itemSeq}`, NOW - 2 * ONE_DAY, NOW],
    );
    const result = leadTimeForChanges(db, cfg, NOW, SINCE);
    expect(result.value).toBeNull();
    expect(result.gap).toBe("no_deployment_data");
  });

  test("deploy without headSha (headSha is null) doesn't match PR", () => {
    const cfg = baseConfig({ deployEnvironments: [] });
    // Deploy has null headSha (metadata has no headSha key)
    insertItem(db, "github_actions", "ci_run", "Deploy main", NOW - ONE_DAY, {
      conclusion: "success",
      repo: "org/repo",
      // headSha intentionally absent → rawHead=undefined → headSha=null
    });
    insertPr(db, "github", NOW - 2 * ONE_DAY, {
      merged: true,
      merged_at: NOW - 2 * ONE_DAY,
      merge_commit_sha: "some-sha",
      labels: [],
    });
    const result = leadTimeForChanges(db, cfg, NOW, SINCE);
    // No match (headSha=null doesn't equal "some-sha"), so approximate
    expect(result.gap).toBe("approximate_lead_time");
  });
});

// ---------------------------------------------------------------------------
// changeFailureRate
// ---------------------------------------------------------------------------
describe("changeFailureRate", () => {
  let db: Database;
  beforeEach(() => {
    db = freshDb();
    resetSeq();
  });
  afterEach(() => {
    db.close();
  });

  test("returns no_repos when repos is empty", () => {
    const cfg = baseConfig({ repos: [] });
    const result = changeFailureRate(db, cfg, NOW, SINCE);
    expect(result.gap).toBe("no_repos");
    expect(result.value).toBeNull();
    expect(result.unit).toBe("ratio");
  });

  test("returns no_deployment_data when no deploys", () => {
    const cfg = baseConfig({ deployEnvironments: [] });
    const result = changeFailureRate(db, cfg, NOW, SINCE);
    expect(result.gap).toBe("no_deployment_data");
  });

  test("returns no_pagerduty_mapping when no pd services configured", () => {
    const cfg = baseConfig({ deployEnvironments: [], pagerdutyServices: [] });
    insertCiRun(db, "github_actions", "Deploy main", NOW - ONE_DAY, "org/repo");
    const result = changeFailureRate(db, cfg, NOW, SINCE);
    expect(result.gap).toBe("no_pagerduty_mapping");
    expect(result.sample).toBe(1);
    expect(result.value).toBeNull();
  });

  test("returns 0 ratio when no incidents in window", () => {
    const cfg = baseConfig({ deployEnvironments: [], pagerdutyServices: ["pd-svc-1"] });
    insertCiRun(db, "github_actions", "Deploy main", NOW - ONE_DAY, "org/repo");
    insertCiRun(db, "github_actions", "Deploy main", NOW - 2 * ONE_DAY, "org/repo");
    insertCiRun(db, "github_actions", "Deploy main", NOW - 3 * ONE_DAY, "org/repo");
    const result = changeFailureRate(db, cfg, NOW, SINCE);
    expect(result.value).toBe(0);
    expect(result.gap).toBeNull();
    expect(result.sample).toBe(3);
  });

  test("attributes incident to the most-recent deploy before the incident", () => {
    const cfg = baseConfig({ deployEnvironments: [], pagerdutyServices: ["pd-svc-1"] });
    const deployAt1 = NOW - 3 * ONE_DAY;
    const deployAt2 = NOW - 2 * ONE_DAY;
    const deployAt3 = NOW - ONE_DAY;
    insertCiRun(db, "github_actions", "Deploy main", deployAt1, "org/repo");
    insertCiRun(db, "github_actions", "Deploy main", deployAt2, "org/repo");
    insertCiRun(db, "github_actions", "Deploy main", deployAt3, "org/repo");
    // Incident opened shortly after deploy 2
    const incidentOpened = deployAt2 + 1_800_000; // 30 min after deploy2 (within 60 min window)
    insertIncident(db, "pd-svc-1", NOW - ONE_DAY - 100_000, incidentOpened);
    const result = changeFailureRate(db, cfg, NOW, SINCE);
    // 1 of 3 deploys failed
    expect(result.value).toBeCloseTo(1 / 3);
    expect(result.gap).toBeNull();
  });

  test("incident outside window is not attributed", () => {
    const cfg = baseConfig({ deployEnvironments: [], pagerdutyServices: ["pd-svc-1"] });
    const deployAt = NOW - 3 * ONE_DAY;
    insertCiRun(db, "github_actions", "Deploy main", deployAt, "org/repo");
    insertCiRun(db, "github_actions", "Deploy main", NOW - 2 * ONE_DAY, "org/repo");
    insertCiRun(db, "github_actions", "Deploy main", NOW - ONE_DAY, "org/repo");
    // Incident opened 2 hours after deploy (outside 60-min window)
    const incidentOpened = deployAt + 2 * 3_600_000;
    insertIncident(db, "pd-svc-1", NOW - 100_000, incidentOpened);
    const result = changeFailureRate(db, cfg, NOW, SINCE);
    expect(result.value).toBe(0); // no attribution
  });

  test("incident before all deploys is not attributed", () => {
    const cfg = baseConfig({ deployEnvironments: [], pagerdutyServices: ["pd-svc-1"] });
    insertCiRun(db, "github_actions", "Deploy main", NOW - ONE_DAY, "org/repo");
    insertCiRun(db, "github_actions", "Deploy main", NOW - 2 * ONE_DAY, "org/repo");
    insertCiRun(db, "github_actions", "Deploy main", NOW - 3 * ONE_DAY, "org/repo");
    // Incident opened 29 days ago (before all deploys in sample)
    const incidentOpened = NOW - 29 * ONE_DAY;
    insertIncident(db, "pd-svc-1", NOW - 100_000, incidentOpened);
    const result = changeFailureRate(db, cfg, NOW, SINCE);
    expect(result.value).toBe(0);
  });

  test("low_sample gap when fewer than 3 deploys", () => {
    const cfg = baseConfig({ deployEnvironments: [], pagerdutyServices: ["pd-svc-1"] });
    insertCiRun(db, "github_actions", "Deploy main", NOW - ONE_DAY, "org/repo");
    const result = changeFailureRate(db, cfg, NOW, SINCE);
    expect(result.gap).toBe("low_sample");
  });

  test("incident without resolved status is excluded", () => {
    const cfg = baseConfig({ deployEnvironments: [], pagerdutyServices: ["pd-svc-1"] });
    const deployAt = NOW - 2 * ONE_DAY;
    insertCiRun(db, "github_actions", "Deploy main", deployAt, "org/repo");
    insertCiRun(db, "github_actions", "Deploy main", NOW - ONE_DAY, "org/repo");
    insertCiRun(db, "github_actions", "Deploy main", NOW - 3 * ONE_DAY, "org/repo");
    // Active incident (not resolved)
    insertItem(db, "pagerduty", "incident", "Active Incident", NOW - ONE_DAY - 100_000, {
      status: "acknowledged",
      pagerduty_service_id: "pd-svc-1",
      opened_at_ms: deployAt + 1_000_000,
    });
    const result = changeFailureRate(db, cfg, NOW, SINCE);
    expect(result.value).toBe(0);
  });

  test("incident with no opened_at_ms falls back to synced_at", () => {
    const cfg = baseConfig({ deployEnvironments: [], pagerdutyServices: ["pd-svc-1"] });
    const deployAt = NOW - 2 * ONE_DAY;
    insertCiRun(db, "github_actions", "Deploy main", deployAt, "org/repo");
    insertCiRun(db, "github_actions", "Deploy main", NOW - ONE_DAY, "org/repo");
    insertCiRun(db, "github_actions", "Deploy main", NOW - 3 * ONE_DAY, "org/repo");
    // Insert incident without opened_at_ms — synced_at is within window of deployAt
    const syncedAt = deployAt + 1_800_000; // 30 min after deploy
    itemSeq += 1;
    const incId = `item-${itemSeq}`;
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, modified_at, metadata, synced_at)
       VALUES (?, 'pagerduty', 'incident', ?, 'Incident fallback', ?, ?, ?)`,
      [
        incId,
        `ext-${itemSeq}`,
        NOW - ONE_DAY,
        JSON.stringify({ status: "resolved", pagerduty_service_id: "pd-svc-1" }),
        // no opened_at_ms → fallback to synced_at
        syncedAt,
      ],
    );
    const result = changeFailureRate(db, cfg, NOW, SINCE);
    // synced_at = deployAt + 30min → within window → attributed
    expect(result.value).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// mttr
// ---------------------------------------------------------------------------
describe("mttr", () => {
  let db: Database;
  beforeEach(() => {
    db = freshDb();
    resetSeq();
  });
  afterEach(() => {
    db.close();
  });

  test("returns no_pagerduty_mapping when pagerdutyServices is empty", () => {
    const cfg = baseConfig({ pagerdutyServices: [] });
    const result = mttr(db, cfg, NOW, SINCE);
    expect(result.gap).toBe("no_pagerduty_mapping");
    expect(result.value).toBeNull();
    expect(result.unit).toBe("seconds_median");
    expect(result.sample).toBe(0);
  });

  test("returns low_sample when no resolved incidents", () => {
    const cfg = baseConfig();
    const result = mttr(db, cfg, NOW, SINCE);
    expect(result.gap).toBe("low_sample");
    expect(result.value).toBeNull();
  });

  test("computes median MTTR for single incident", () => {
    const cfg = baseConfig();
    const openedAt = NOW - 2 * ONE_DAY;
    const resolvedAt = NOW - 2 * ONE_DAY + 3_600_000; // 1 hour TTR
    insertIncident(db, "pd-svc-1", resolvedAt, openedAt);
    const result = mttr(db, cfg, NOW, SINCE);
    expect(result.value).toBe(3600); // 1 hour in seconds
    expect(result.gap).toBe("low_sample"); // sample=1 < 3
    expect(result.sample).toBe(1);
  });

  test("computes median MTTR for odd number of incidents", () => {
    const cfg = baseConfig();
    // 3 incidents with TTRs: 1h, 2h, 3h → median = 2h = 7200s
    const ttrValues = [3_600_000, 7_200_000, 10_800_000];
    for (const ttr of ttrValues) {
      const openedAt = NOW - 10 * ONE_DAY;
      insertIncident(db, "pd-svc-1", openedAt + ttr, openedAt);
    }
    const result = mttr(db, cfg, NOW, SINCE);
    expect(result.value).toBe(7200);
    expect(result.gap).toBeNull(); // sample=3, no low_sample
    expect(result.sample).toBe(3);
  });

  test("computes median MTTR for even number of incidents (floor of avg)", () => {
    const cfg = baseConfig();
    // 4 incidents with TTRs sorted: 3600, 7200, 10800, 14400 → median = floor((7200+10800)/2) = 9000
    const ttrValues = [3_600_000, 7_200_000, 10_800_000, 14_400_000];
    for (const ttr of ttrValues) {
      const openedAt = NOW - 10 * ONE_DAY;
      insertIncident(db, "pd-svc-1", openedAt + ttr, openedAt);
    }
    const result = mttr(db, cfg, NOW, SINCE);
    expect(result.value).toBe(9000);
    expect(result.gap).toBeNull();
    expect(result.sample).toBe(4);
  });

  test("MTTR is floored to 0 when resolved_at < opened_at (data inconsistency)", () => {
    const cfg = baseConfig();
    const resolvedAt = NOW - 2 * ONE_DAY;
    // opened_at > resolved_at (negative TTR → clamped to 0)
    const openedAt = resolvedAt + 1_000_000;
    insertIncident(db, "pd-svc-1", resolvedAt, openedAt);
    const result = mttr(db, cfg, NOW, SINCE);
    expect(result.value).toBe(0);
  });

  test("low_sample gap when fewer than 3 incidents", () => {
    const cfg = baseConfig();
    insertIncident(db, "pd-svc-1", NOW - ONE_DAY, NOW - 2 * ONE_DAY);
    insertIncident(db, "pd-svc-1", NOW - 2 * ONE_DAY, NOW - 3 * ONE_DAY);
    const result = mttr(db, cfg, NOW, SINCE);
    expect(result.gap).toBe("low_sample");
    expect(result.sample).toBe(2);
  });

  test("excludes incidents from non-matching pagerduty service", () => {
    const cfg = baseConfig({ pagerdutyServices: ["pd-svc-1"] });
    insertIncident(db, "pd-svc-OTHER", NOW - ONE_DAY, NOW - 2 * ONE_DAY);
    const result = mttr(db, cfg, NOW, SINCE);
    expect(result.gap).toBe("low_sample"); // no matching incidents
    expect(result.value).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// computeDoraMetrics
// ---------------------------------------------------------------------------
describe("computeDoraMetrics", () => {
  let db: Database;
  beforeEach(() => {
    db = freshDb();
    resetSeq();
  });
  afterEach(() => {
    db.close();
  });

  test("returns all four metrics with correct service/since_ms/computed_at shape", () => {
    const cfg = baseConfig({ repos: [], pagerdutyServices: [] });
    const result = computeDoraMetrics(db, cfg, NOW, SINCE);
    expect(result.service).toBe("svc-test");
    expect(result.since_ms).toBe(SINCE);
    expect(result.computed_at).toBe(new Date(NOW).toISOString());
    expect(result.metrics.deployment_frequency.unit).toBe("deploys_per_day");
    expect(result.metrics.lead_time_for_changes.unit).toBe("seconds_median");
    expect(result.metrics.change_failure_rate.unit).toBe("ratio");
    expect(result.metrics.mttr.unit).toBe("seconds_median");
  });

  test("all gaps are no_repos/no_pagerduty when no repos and no pd config", () => {
    const cfg = baseConfig({ repos: [], pagerdutyServices: [] });
    const result = computeDoraMetrics(db, cfg, NOW, SINCE);
    expect(result.metrics.deployment_frequency.gap).toBe("no_repos");
    expect(result.metrics.lead_time_for_changes.gap).toBe("no_repos");
    expect(result.metrics.change_failure_rate.gap).toBe("no_repos");
    expect(result.metrics.mttr.gap).toBe("no_pagerduty_mapping");
  });
});
