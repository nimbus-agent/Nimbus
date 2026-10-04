/**
 * DORA arms the rest of the suite leaves unexercised, on the REAL migrated schema with rows written
 * through the real item writer: each repo URN provider matches on its own key only (never another
 * provider's key, a different repo, or null metadata), a PR whose `labels` is not an array is
 * never excluded by it, and MTTR falls back to the row's `synced_at` when an incident carries no
 * `opened_at_ms`.
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { upsertIndexedItem } from "../index/item-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import { leadTimeForChanges, mttr, repoLikeMatchesUrn } from "./dora.ts";
import type { ParsedDoraRepoUrn, ServiceConfig } from "./dora-config.ts";

const NOW = 1_760_000_000_000;
const HOUR = 3_600_000;
const SINCE = 30 * 24 * HOUR;

const cfg: ServiceConfig = {
  serviceId: "payments",
  repos: [{ provider: "github", providerId: "acme/payments" }],
  pagerdutyServices: ["PD-PAY"],
  deployWorkflowPattern: /^Deploy/,
  incidentWindowMinutes: 60,
  excludePrLabels: ["revert"],
  deployEnvironments: ["prod"],
  severityP1Aliases: ["P1"],
};

function openDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

function put(
  db: Database,
  row: {
    service: string;
    type: string;
    externalId: string;
    title: string;
    modifiedAt: number;
    syncedAt?: number;
    metadata: Record<string, unknown>;
  },
): void {
  upsertIndexedItem(db, { ...row, syncedAt: row.syncedAt ?? row.modifiedAt });
}

describe("repoLikeMatchesUrn", () => {
  /**
   * `misses` are the same row shapes with the value under ANOTHER provider's key, or a different
   * repo under this provider's own key. Without them a provider that matched every row would pass —
   * and for `jenkins` and `circleci` nothing else in the suite would notice.
   */
  type UrnCase = {
    urn: ParsedDoraRepoUrn;
    meta: Record<string, unknown>;
    ext: string;
    misses: readonly { meta: Record<string, unknown>; ext: string }[];
  };
  const cases: UrnCase[] = [
    {
      urn: { provider: "github", providerId: "acme/api" },
      meta: { repo: "acme/api" },
      ext: "x",
      misses: [
        { meta: { repo: "acme/web" }, ext: "x" },
        { meta: { project: "acme/api", jobName: "acme/api" }, ext: "acme/api" },
      ],
    },
    {
      urn: { provider: "bitbucket", providerId: "acme/api" },
      meta: { repo: "acme/api" },
      ext: "x",
      misses: [
        { meta: { repo: "acme/web" }, ext: "x" },
        { meta: { project: "acme/api", jobName: "acme/api" }, ext: "acme/api" },
      ],
    },
    {
      urn: { provider: "gitlab", providerId: "grp/api" },
      meta: { project: "grp/api" },
      ext: "x",
      misses: [
        { meta: { project: "grp/web", repo: "grp/web" }, ext: "x" },
        { meta: { jobName: "grp/api" }, ext: "grp/api" },
      ],
    },
    {
      urn: { provider: "gitlab", providerId: "grp/api" },
      meta: { repo: "grp/api" },
      ext: "x",
      misses: [{ meta: { repo: "grp/web" }, ext: "x" }],
    },
    {
      urn: { provider: "jenkins", providerId: "deploy-api" },
      meta: { jobName: "deploy-api" },
      ext: "x",
      misses: [
        { meta: { jobName: "deploy-web" }, ext: "x" },
        { meta: { repo: "deploy-api", project: "deploy-api" }, ext: "deploy-api" },
      ],
    },
    {
      urn: { provider: "circleci", providerId: "gh/acme/api" },
      meta: {},
      ext: "gh/acme/api/123",
      // circleci matches on the external id ALONE: a metadata key naming the repo is not a match.
      misses: [{ meta: { repo: "gh/acme/api", jobName: "gh/acme/api" }, ext: "gh/acme/web/123" }],
    },
  ];

  test.each(cases)(
    "$urn.provider matches on its own key only, and never on null metadata",
    ({ urn, meta, ext, misses }: UrnCase) => {
      expect(repoLikeMatchesUrn(meta, ext, urn)).toBe(true);
      expect(repoLikeMatchesUrn(null, ext, urn)).toBe(false);
      expect(misses.map((m) => repoLikeMatchesUrn(m.meta, m.ext, urn))).toEqual(
        misses.map(() => false),
      );
    },
  );
});

describe("leadTimeForChanges — PR labels", () => {
  function seedDeployAndPr(db: Database, labels: unknown): void {
    put(db, {
      service: "github_actions",
      type: "ci_run",
      externalId: "run-1",
      title: "Deploy prod",
      modifiedAt: NOW - HOUR,
      metadata: { conclusion: "success", repo: "acme/payments", headSha: "abc1234" },
    });
    put(db, {
      service: "github",
      type: "pr",
      externalId: "acme/payments#7",
      title: "Retry the settlement call",
      modifiedAt: NOW - 2 * HOUR,
      metadata: {
        merged: true,
        merged_at: NOW - 3 * HOUR,
        merge_commit_sha: "abc1234",
        ...(labels === undefined ? {} : { labels }),
      },
    });
  }

  test("a labels value that is not an array excludes nothing — even the literal excluded label", () => {
    const db = openDb();
    seedDeployAndPr(db, "revert");
    const m = leadTimeForChanges(db, cfg, NOW, SINCE);
    db.close();
    // merged 3h before now, deployed 1h before now: two hours of lead time.
    expect(m).toEqual({ value: 7_200, unit: "seconds_median", sample: 1, gap: "low_sample" });
  });

  test("a PR with no labels at all is counted the same way", () => {
    const db = openDb();
    seedDeployAndPr(db, undefined);
    const m = leadTimeForChanges(db, cfg, NOW, SINCE);
    db.close();
    expect(m.value).toBe(7_200);
    expect(m.sample).toBe(1);
  });

  test("control: the same label inside an array excludes the PR", () => {
    const db = openDb();
    seedDeployAndPr(db, ["revert"]);
    const m = leadTimeForChanges(db, cfg, NOW, SINCE);
    db.close();
    expect(m).toEqual({
      value: null,
      unit: "seconds_median",
      sample: 0,
      gap: "no_deployment_data",
    });
  });
});

describe("mttr — the opened timestamp", () => {
  function seedResolvedIncident(db: Database, openedAtMs: number | undefined): void {
    put(db, {
      service: "pagerduty",
      type: "incident",
      externalId: "PINC1",
      title: "Settlement latency",
      // A resolved incident's modified_at is its resolution instant.
      modifiedAt: NOW - HOUR,
      syncedAt: NOW - 4 * HOUR,
      metadata: {
        status: "resolved",
        pagerduty_service_id: "PD-PAY",
        ...(openedAtMs === undefined ? {} : { opened_at_ms: openedAtMs }),
      },
    });
  }

  test("an incident with no opened_at_ms is measured from when the row was synced", () => {
    const db = openDb();
    seedResolvedIncident(db, undefined);
    const m = mttr(db, cfg, NOW, SINCE);
    db.close();
    // synced 4h before now, resolved 1h before now.
    expect(m).toEqual({ value: 10_800, unit: "seconds_median", sample: 1, gap: "low_sample" });
  });

  test("control: a real opened_at_ms wins over synced_at", () => {
    const db = openDb();
    seedResolvedIncident(db, NOW - 2 * HOUR);
    const m = mttr(db, cfg, NOW, SINCE);
    db.close();
    expect(m.value).toBe(3_600);
  });
});
