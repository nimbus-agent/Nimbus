import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mttr } from "./dora.ts";
import type { ServiceConfig } from "./dora-config.ts";
import { computeStatsSeries, STATS_METRIC_IDS } from "./stats.ts";

const DAY = 86_400_000;
const NOW = 1_700_000_000_000;

function makeDb(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE item (
    id TEXT PRIMARY KEY, service TEXT NOT NULL, type TEXT NOT NULL,
    external_id TEXT NOT NULL, title TEXT, body_preview TEXT, url TEXT,
    canonical_url TEXT, modified_at INTEGER NOT NULL, author_id TEXT,
    metadata TEXT, synced_at INTEGER NOT NULL, pinned INTEGER DEFAULT 0)`);
  // `deploymentFrequency` (dora.ts) joins `deployment_items` unconditionally whenever
  // `cfg.deployEnvironments` is non-empty — required for the registry-totality test, which
  // exercises every metric id including "deployment-frequency". Mirrors `dora.test.ts`'s
  // own `MINIMAL_SCHEMA`, which carries this same table for the same reason.
  db.run(`CREATE TABLE deployment_items (
    id TEXT PRIMARY KEY, provider TEXT NOT NULL, nimbus_service_id TEXT NOT NULL,
    environment TEXT NOT NULL, sha TEXT NOT NULL, ref TEXT NOT NULL,
    started_at_ms INTEGER NOT NULL, finished_at_ms INTEGER, conclusion TEXT NOT NULL,
    workflow_url TEXT, ci_run_external_id TEXT, created_at INTEGER NOT NULL)`);
  return db;
}

function insertPr(db: Database, id: string, repo: string, mergedAtMs: number | null): void {
  const meta = mergedAtMs === null ? { repo } : { repo, merged_at: mergedAtMs };
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, modified_at, metadata, synced_at)
     VALUES (?, 'github', 'pr', ?, 'x', ?, ?, ?)`,
    [id, id, NOW, JSON.stringify(meta), NOW],
  );
}

function cfg(repos: ServiceConfig["repos"]): ServiceConfig {
  return {
    serviceId: "checkout-web",
    repos,
    pagerdutyServices: [],
    deployWorkflowPattern: /^[Dd]eploy/,
    incidentWindowMinutes: 60,
    excludePrLabels: [],
    deployEnvironments: ["prod"],
    severityP1Aliases: [],
  };
}

// ParsedDoraRepoUrn is { provider, providerId } — NOT { forge, owner, name }. For GitHub,
// providerId is the "owner/name" string that `metadata.repo` carries on an indexed PR.
const GH: ServiceConfig["repos"] = [{ provider: "github", providerId: "acme/web" }];
const GL: ServiceConfig["repos"] = [
  { provider: "github", providerId: "acme/web" },
  { provider: "gitlab", providerId: "acme/api" },
];

describe("computeStatsSeries — pr-merges", () => {
  test("counts merges into the bucket their merged_at falls in", () => {
    const db = makeDb();
    insertPr(db, "a", "acme/web", NOW - 1.5 * DAY); // newest bucket
    insertPr(db, "b", "acme/web", NOW - 2.5 * DAY); // older bucket
    insertPr(db, "c", "acme/web", NOW - 2.6 * DAY); // older bucket
    const s = computeStatsSeries(db, cfg(GH), "pr-merges", NOW, 4 * DAY, 2 * DAY);
    expect(s.points.length).toBe(2);
    expect(s.points[0]?.value).toBe(2);
    expect(s.points[1]?.value).toBe(1);
  });

  // The single most important assertion in this feature.
  test("an empty bucket is null with a gap, NEVER 0", () => {
    const db = makeDb();
    const s = computeStatsSeries(db, cfg(GH), "pr-merges", NOW, 2 * DAY, DAY);
    for (const p of s.points) {
      expect(p.value).toBeNull();
      expect(p.gap).not.toBeNull();
    }
  });

  test("an unmerged PR is not counted", () => {
    const db = makeDb();
    insertPr(db, "open", "acme/web", null);
    const s = computeStatsSeries(db, cfg(GH), "pr-merges", NOW, 2 * DAY, DAY);
    expect(s.points.every((p) => p.value === null)).toBe(true);
  });

  test("malformed metadata JSON does not raise", () => {
    const db = makeDb();
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, modified_at, metadata, synced_at)
       VALUES ('bad', 'github', 'pr', 'bad', 'x', ?, '{not json', ?)`,
      [NOW, NOW],
    );
    insertPr(db, "ok", "acme/web", NOW - 0.5 * DAY);
    const s = computeStatsSeries(db, cfg(GH), "pr-merges", NOW, DAY, DAY);
    expect(s.points[0]?.value).toBe(1);
  });

  test("a mixed-forge service flags github_only_merge_data", () => {
    const db = makeDb();
    insertPr(db, "a", "acme/web", NOW - 0.5 * DAY);
    const s = computeStatsSeries(db, cfg(GL), "pr-merges", NOW, DAY, DAY);
    expect(s.points[0]?.gap).toBe("github_only_merge_data");
  });

  test("a github-only service does NOT flag github_only_merge_data", () => {
    const db = makeDb();
    insertPr(db, "a", "acme/web", NOW - 0.5 * DAY);
    const s = computeStatsSeries(db, cfg(GH), "pr-merges", NOW, DAY, DAY);
    expect(s.points[0]?.gap).not.toBe("github_only_merge_data");
  });

  // An empty bucket on a MIXED-forge service must still say "the untracked forge might hold
  // the real answer" rather than the generic low_sample — this is a distinct branch from the
  // count>0 case above.
  test("an empty bucket on a mixed-forge service still flags github_only_merge_data", () => {
    const db = makeDb();
    const s = computeStatsSeries(db, cfg(GL), "pr-merges", NOW, DAY, DAY);
    expect(s.points[0]?.value).toBeNull();
    expect(s.points[0]?.gap).toBe("github_only_merge_data");
  });

  // Spec § 5: scoped to the SERVICE's bound repos. Without the metadata.repo predicate this
  // metric counts every PR in the index and silently reports another team's throughput.
  test("a merge in a repo this service does NOT own is not counted", () => {
    const db = makeDb();
    insertPr(db, "ours", "acme/web", NOW - 0.5 * DAY);
    insertPr(db, "theirs", "other/thing", NOW - 0.5 * DAY);
    const s = computeStatsSeries(db, cfg(GH), "pr-merges", NOW, DAY, DAY);
    expect(s.points[0]?.value).toBe(1);
  });

  test("a service binding no github repos yields no_repos, not zero", () => {
    const db = makeDb();
    insertPr(db, "a", "acme/web", NOW - 0.5 * DAY);
    const gitlabOnly: ServiceConfig["repos"] = [{ provider: "gitlab", providerId: "acme/api" }];
    const s = computeStatsSeries(db, cfg(gitlabOnly), "pr-merges", NOW, DAY, DAY);
    expect(s.points[0]?.value).toBeNull();
    expect(s.points[0]?.gap).toBe("no_repos");
  });
});

// These three pin the corrections in Task 2 step 3 (a), (b) and (c). Without them the plan
// states the rules and nothing enforces them.
describe("computeStatsSeries — incidents-opened", () => {
  function insertIncident(
    db: Database,
    id: string,
    pdService: string,
    openedAtMs: number | null,
    status: string,
    modifiedAt: number,
  ): void {
    const meta: Record<string, unknown> = { pagerduty_service_id: pdService, status };
    if (openedAtMs !== null) meta["opened_at_ms"] = openedAtMs;
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, modified_at, metadata, synced_at)
       VALUES (?, 'pagerduty', 'incident', ?, 'x', ?, ?, ?)`,
      [id, id, modifiedAt, JSON.stringify(meta), NOW],
    );
  }
  const pd = (): ServiceConfig => ({ ...cfg(GH), pagerdutyServices: ["PSVC1"] });

  // (a) buckets on the OPENED time, not modified_at.
  test("an old incident touched recently stays in its ORIGINAL bucket", () => {
    const db = makeDb();
    insertIncident(db, "old", "PSVC1", NOW - 3.5 * DAY, "resolved", NOW);
    const s = computeStatsSeries(db, pd(), "incidents-opened", NOW, 4 * DAY, DAY);
    expect(s.points[3]?.value).toBeNull(); // newest bucket: nothing opened
    expect(s.points[0]?.value).toBe(1); // oldest bucket: where it opened
  });

  // (b) status is NOT filtered — an incident still burning still opened.
  test("an unresolved incident is counted", () => {
    const db = makeDb();
    insertIncident(db, "live", "PSVC1", NOW - 0.5 * DAY, "triggered", NOW);
    const s = computeStatsSeries(db, pd(), "incidents-opened", NOW, DAY, DAY);
    expect(s.points[0]?.value).toBe(1);
  });

  // (c) a missing opened_at_ms is EXCLUDED and REPORTED — never coalesced to synced_at.
  test("an incident with no opened_at_ms is excluded and flagged, not back-dated", () => {
    const db = makeDb();
    insertIncident(db, "timed", "PSVC1", NOW - 0.5 * DAY, "resolved", NOW);
    insertIncident(db, "untimed", "PSVC1", null, "resolved", NOW);
    const s = computeStatsSeries(db, pd(), "incidents-opened", NOW, DAY, DAY);
    expect(s.points[0]?.value).toBe(1);
    expect(s.points[0]?.gap).toBe("incidents_missing_opened_at");
  });

  test("no pagerduty mapping yields no_pagerduty_mapping, not zero", () => {
    const db = makeDb();
    const s = computeStatsSeries(db, cfg(GH), "incidents-opened", NOW, DAY, DAY);
    expect(s.points[0]?.value).toBeNull();
    expect(s.points[0]?.gap).toBe("no_pagerduty_mapping");
  });

  test("an incident belonging to another pagerduty service is not counted", () => {
    const db = makeDb();
    insertIncident(db, "other", "PSVC2", NOW - 0.5 * DAY, "resolved", NOW);
    const s = computeStatsSeries(db, pd(), "incidents-opened", NOW, DAY, DAY);
    expect(s.points[0]?.value).toBeNull();
  });

  // An empty bucket where the ONLY owned incident has no opened_at_ms at all is a distinct
  // branch from "an old incident touched recently": here count is 0 in every bucket, so the
  // exclusion must still surface as incidents_missing_opened_at, not the generic low_sample.
  test("a bucket with zero timed incidents still flags the untimed exclusion", () => {
    const db = makeDb();
    insertIncident(db, "untimed", "PSVC1", null, "resolved", NOW);
    const s = computeStatsSeries(db, pd(), "incidents-opened", NOW, DAY, DAY);
    expect(s.points[0]?.value).toBeNull();
    expect(s.points[0]?.gap).toBe("incidents_missing_opened_at");
  });
});

describe("registry totality", () => {
  test("every declared metric id has an evaluator and returns a series", () => {
    const db = makeDb();
    for (const id of STATS_METRIC_IDS) {
      const s = computeStatsSeries(db, cfg(GH), id, NOW, 2 * DAY, DAY);
      expect(s.metric).toBe(id);
      expect(s.points.length).toBe(2);
      expect(typeof s.points[0]?.unit).toBe("string");
    }
  });

  test("the series echoes its own window and bucket", () => {
    const db = makeDb();
    const s = computeStatsSeries(db, cfg(GH), "pr-merges", NOW, 4 * DAY, 2 * DAY);
    expect(s.window).toEqual({ sinceMs: NOW - 4 * DAY, untilMs: NOW });
    expect(s.bucketMs).toBe(2 * DAY);
  });
});

test("a single-bucket series agrees with the DORA calculator over the same bounds", () => {
  const db = makeDb();
  const series = computeStatsSeries(db, cfg(GH), "mttr", NOW, DAY, DAY);
  const direct = mttr(db, cfg(GH), NOW, NOW - DAY);
  expect(series.points[0]?.value).toBe(direct.value);
  expect(series.points[0]?.unit).toBe(direct.unit);
  expect(series.points[0]?.sample).toBe(direct.sample);
});
