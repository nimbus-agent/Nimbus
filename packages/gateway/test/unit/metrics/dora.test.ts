import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  changeFailureRate,
  computeDoraMetrics,
  deploymentFrequency,
  leadTimeForChanges,
  mttr,
} from "../../../src/metrics/dora.ts";
import type { ServiceConfig } from "../../../src/metrics/dora-config.ts";
import { openSeededDbFile } from "../../helpers/migrated-db-seed.ts";

type SeedCiOpts = {
  service: string;
  title: string;
  conclusion: string;
  repo?: string;
  project?: string;
  jobName?: string;
  headSha?: string;
  modifiedAt: number;
  externalId?: string;
};

function seedCiRun(db: Database, id: string, opts: SeedCiOpts): void {
  const meta: Record<string, unknown> = { conclusion: opts.conclusion };
  if (opts.repo !== undefined) meta["repo"] = opts.repo;
  if (opts.project !== undefined) meta["project"] = opts.project;
  if (opts.jobName !== undefined) meta["jobName"] = opts.jobName;
  if (opts.headSha !== undefined) meta["headSha"] = opts.headSha;
  const externalId = opts.externalId ?? id;
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, body_preview, url, canonical_url,
                       modified_at, author_id, metadata, synced_at, pinned)
     VALUES (?, ?, 'ci_run', ?, ?, '', NULL, NULL, ?, NULL, ?, ?, 0)`,
    [
      id,
      opts.service,
      externalId,
      opts.title,
      opts.modifiedAt,
      JSON.stringify(meta),
      opts.modifiedAt,
    ],
  );
}

type SeedPrOpts = {
  service: string;
  repo?: string;
  project?: string;
  merged: boolean;
  mergedAt?: number;
  mergeCommitSha?: string;
  labels?: readonly string[];
  modifiedAt: number;
};

function seedPr(db: Database, id: string, opts: SeedPrOpts): void {
  const meta: Record<string, unknown> = { merged: opts.merged };
  if (opts.repo !== undefined) meta["repo"] = opts.repo;
  if (opts.project !== undefined) meta["project"] = opts.project;
  if (opts.mergedAt !== undefined) meta["merged_at"] = opts.mergedAt;
  if (opts.mergeCommitSha !== undefined) meta["merge_commit_sha"] = opts.mergeCommitSha;
  meta["labels"] = opts.labels ?? [];
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, body_preview, url, canonical_url,
                       modified_at, author_id, metadata, synced_at, pinned)
     VALUES (?, ?, 'pr', ?, 'PR', '', NULL, NULL, ?, NULL, ?, ?, 0)`,
    [id, opts.service, id, opts.modifiedAt, JSON.stringify(meta), opts.modifiedAt],
  );
}

type SeedIncidentOpts = {
  status: string;
  pagerdutyServiceId: string;
  openedAt: number;
  resolvedAt: number;
};

function seedIncident(db: Database, id: string, opts: SeedIncidentOpts): void {
  const meta = {
    status: opts.status,
    pagerduty_service_id: opts.pagerdutyServiceId,
    opened_at_ms: opts.openedAt,
  };
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, body_preview, url, canonical_url,
                       modified_at, author_id, metadata, synced_at, pinned)
     VALUES (?, 'pagerduty', 'incident', ?, 'Incident', '', NULL, NULL, ?, NULL, ?, ?, 0)`,
    [id, id, opts.resolvedAt, JSON.stringify(meta), opts.resolvedAt],
  );
}

function cfg(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    serviceId: "payment-service",
    repos: [{ provider: "github", providerId: "nimbus-agent/payments" }],
    pagerdutyServices: ["P1"],
    deployWorkflowPattern: /^[Dd]eploy/,
    incidentWindowMinutes: 60,
    excludePrLabels: ["revert"],
    deployEnvironments: ["prod"],
    severityP1Aliases: [],
    ...overrides,
  };
}

const NOW = 1_700_000_000_000;
const WINDOW = 7 * 86_400_000;
describe("DORA metrics calculators", () => {
  let dir: string;
  let db: Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nimbus-dora-"));
    db = openSeededDbFile(join(dir, "nimbus.db"), 28);
  });

  afterEach(() => {
    db.close();
    try {
      // maxRetries: 0 / retryDelay: 0 — a pinned handle must fail FAST rather than block
      // the hook's timeout budget; a leaked temp dir is the accepted trade-off (#972,
      // #973). Do NOT turn this back into a blocking retry.
      rmSync(dir, { recursive: true, force: true, maxRetries: 0, retryDelay: 0 });
    } catch {
      /* Windows EBUSY — OS cleans temp dir on reboot */
    }
  });

  describe("deploymentFrequency", () => {
    it("counts only successful deploys matching the regex on a matching repo", () => {
      for (let i = 0; i < 5; i++) {
        seedCiRun(db, `gha-${i}`, {
          service: "github_actions",
          title: "Deploy production",
          conclusion: "success",
          repo: "nimbus-agent/payments",
          headSha: `sha-${i}`,
          modifiedAt: NOW - (i + 1) * 86_400_000,
        });
      }
      seedCiRun(db, "gha-fail", {
        service: "github_actions",
        title: "Deploy production",
        conclusion: "failure",
        repo: "nimbus-agent/payments",
        modifiedAt: NOW - 86_400_000,
      });
      seedCiRun(db, "gha-ci", {
        service: "github_actions",
        title: "CI lint",
        conclusion: "success",
        repo: "nimbus-agent/payments",
        modifiedAt: NOW - 86_400_000,
      });
      seedCiRun(db, "gha-other", {
        service: "github_actions",
        title: "Deploy production",
        conclusion: "success",
        repo: "someone-else/other",
        modifiedAt: NOW - 86_400_000,
      });
      const m = deploymentFrequency(db, cfg(), NOW, WINDOW);
      expect(m.sample).toBe(5);
      expect(m.unit).toBe("deploys_per_day");
      expect(m.gap).toBeNull();
      expect(m.value).toBeCloseTo(5 / 7, 5);
    });

    it("returns null with gap='no_repos' when repos is empty", () => {
      const m = deploymentFrequency(db, cfg({ repos: [] }), NOW, WINDOW);
      expect(m.value).toBeNull();
      expect(m.sample).toBe(0);
      expect(m.gap).toBe("no_repos");
    });

    it("returns null with gap='no_deployment_data' when zero ci_run titles match the regex", () => {
      seedCiRun(db, "gha-1", {
        service: "github_actions",
        title: "CI lint",
        conclusion: "success",
        repo: "nimbus-agent/payments",
        modifiedAt: NOW - 86_400_000,
      });
      const m = deploymentFrequency(db, cfg(), NOW, WINDOW);
      expect(m.value).toBeNull();
      expect(m.sample).toBe(0);
      expect(m.gap).toBe("no_deployment_data");
    });

    it("emits gap='low_sample' when fewer than 3 deploys in window", () => {
      for (let i = 0; i < 2; i++) {
        seedCiRun(db, `gha-${i}`, {
          service: "github_actions",
          title: "Deploy production",
          conclusion: "success",
          repo: "nimbus-agent/payments",
          modifiedAt: NOW - (i + 1) * 86_400_000,
        });
      }
      const m = deploymentFrequency(db, cfg(), NOW, WINDOW);
      expect(m.sample).toBe(2);
      expect(m.gap).toBe("low_sample");
      expect(m.value).toBeCloseTo(2 / 7, 5);
    });
  });

  describe("leadTimeForChanges", () => {
    it("returns median seconds for PRs with merge_commit_sha matching a deploy headSha", () => {
      const t0 = NOW - 3 * 86_400_000;
      const leadTimes = [3600, 7200, 10800];
      for (let i = 0; i < 3; i++) {
        const mergedAt = t0 + i * 100_000;
        const lt = leadTimes[i];
        if (lt === undefined) throw new Error("unreachable");
        const deployedAt = mergedAt + lt * 1000;
        seedPr(db, `pr-${i}`, {
          service: "github",
          repo: "nimbus-agent/payments",
          merged: true,
          mergedAt,
          mergeCommitSha: `sha-${i}`,
          labels: [],
          modifiedAt: mergedAt,
        });
        seedCiRun(db, `gha-${i}`, {
          service: "github_actions",
          title: "Deploy production",
          conclusion: "success",
          repo: "nimbus-agent/payments",
          headSha: `sha-${i}`,
          modifiedAt: deployedAt,
        });
      }
      const m = leadTimeForChanges(db, cfg(), NOW, WINDOW);
      expect(m.unit).toBe("seconds_median");
      expect(m.sample).toBe(3);
      expect(m.value).toBe(7200);
      expect(m.gap).toBeNull();
    });

    it("emits gap='approximate_lead_time' when at least one merged PR has no merge_commit_sha", () => {
      const t0 = NOW - 3 * 86_400_000;
      seedPr(db, "pr-1", {
        service: "github",
        repo: "nimbus-agent/payments",
        merged: true,
        mergedAt: t0,
        mergeCommitSha: "sha-1",
        modifiedAt: t0,
      });
      seedCiRun(db, "gha-1", {
        service: "github_actions",
        title: "Deploy production",
        conclusion: "success",
        repo: "nimbus-agent/payments",
        headSha: "sha-1",
        modifiedAt: t0 + 3600 * 1000,
      });
      seedPr(db, "pr-2", {
        service: "github",
        repo: "nimbus-agent/payments",
        merged: true,
        mergedAt: t0 + 100_000,
        modifiedAt: t0 + 100_000,
      });
      seedCiRun(db, "gha-2", {
        service: "github_actions",
        title: "Deploy production",
        conclusion: "success",
        repo: "nimbus-agent/payments",
        headSha: "sha-other",
        modifiedAt: t0 + 200_000,
      });
      seedCiRun(db, "gha-3", {
        service: "github_actions",
        title: "Deploy production",
        conclusion: "success",
        repo: "nimbus-agent/payments",
        headSha: "sha-another",
        modifiedAt: t0 + 300_000,
      });
      const m = leadTimeForChanges(db, cfg(), NOW, WINDOW);
      expect(m.gap).toBe("approximate_lead_time");
      expect(m.sample).toBe(1);
      expect(m.value).toBe(3600);
    });

    it("excludes PRs whose labels intersect cfg.excludePrLabels", () => {
      const t0 = NOW - 3 * 86_400_000;
      seedPr(db, "pr-revert", {
        service: "github",
        repo: "nimbus-agent/payments",
        merged: true,
        mergedAt: t0,
        mergeCommitSha: "sha-revert",
        labels: ["revert"],
        modifiedAt: t0,
      });
      for (let i = 0; i < 3; i++) {
        const mergedAt = t0 + (i + 1) * 100_000;
        seedPr(db, `pr-${i}`, {
          service: "github",
          repo: "nimbus-agent/payments",
          merged: true,
          mergedAt,
          mergeCommitSha: `sha-${i}`,
          modifiedAt: mergedAt,
        });
        seedCiRun(db, `gha-${i}`, {
          service: "github_actions",
          title: "Deploy production",
          conclusion: "success",
          repo: "nimbus-agent/payments",
          headSha: `sha-${i}`,
          modifiedAt: mergedAt + 60_000,
        });
      }
      seedCiRun(db, "gha-revert", {
        service: "github_actions",
        title: "Deploy production",
        conclusion: "success",
        repo: "nimbus-agent/payments",
        headSha: "sha-revert",
        modifiedAt: t0 + 60_000,
      });
      const m = leadTimeForChanges(db, cfg(), NOW, WINDOW);
      expect(m.sample).toBe(3);
      expect(m.value).toBe(60);
      expect(m.gap).toBeNull();
    });

    it("returns gap='no_repos' when repos is empty", () => {
      const m = leadTimeForChanges(db, cfg({ repos: [] }), NOW, WINDOW);
      expect(m.value).toBeNull();
      expect(m.gap).toBe("no_repos");
    });

    it("returns gap='no_deployment_data' when there are no matching deploys", () => {
      const m = leadTimeForChanges(db, cfg(), NOW, WINDOW);
      expect(m.value).toBeNull();
      expect(m.gap).toBe("no_deployment_data");
    });
  });

  describe("changeFailureRate", () => {
    it("attributes incident to most-recent-preceding deploy within window", () => {
      const t0 = NOW - 3 * 86_400_000;
      seedCiRun(db, "d1", {
        service: "github_actions",
        title: "Deploy",
        conclusion: "success",
        repo: "nimbus-agent/payments",
        headSha: "sha-1",
        modifiedAt: t0,
      });
      seedCiRun(db, "d2", {
        service: "github_actions",
        title: "Deploy",
        conclusion: "success",
        repo: "nimbus-agent/payments",
        headSha: "sha-2",
        modifiedAt: t0 + 10 * 60_000, // 10 min later
      });
      seedCiRun(db, "d3", {
        service: "github_actions",
        title: "Deploy",
        conclusion: "success",
        repo: "nimbus-agent/payments",
        headSha: "sha-3",
        modifiedAt: t0 + 2 * 86_400_000, // 2 days after d2
      });
      seedIncident(db, "inc-1", {
        status: "resolved",
        pagerdutyServiceId: "P1",
        openedAt: t0 + 10 * 60_000 + 30 * 60_000,
        resolvedAt: t0 + 10 * 60_000 + 60 * 60_000,
      });
      const m = changeFailureRate(db, cfg(), NOW, WINDOW);
      expect(m.value).toBeCloseTo(1 / 3, 5);
      expect(m.sample).toBe(3);
      expect(m.gap).toBeNull();
    });

    it("two close-together deploys followed by one incident — only the second is counted as failed", () => {
      const t0 = NOW - 3 * 86_400_000;
      seedCiRun(db, "d1", {
        service: "github_actions",
        title: "Deploy",
        conclusion: "success",
        repo: "nimbus-agent/payments",
        headSha: "sha-1",
        modifiedAt: t0,
      });
      seedCiRun(db, "d2", {
        service: "github_actions",
        title: "Deploy",
        conclusion: "success",
        repo: "nimbus-agent/payments",
        headSha: "sha-2",
        modifiedAt: t0 + 60_000, // 1 minute later
      });
      seedCiRun(db, "d3", {
        service: "github_actions",
        title: "Deploy",
        conclusion: "success",
        repo: "nimbus-agent/payments",
        headSha: "sha-3",
        modifiedAt: t0 + 86_400_000, // 1 day after d2
      });
      seedIncident(db, "inc-1", {
        status: "resolved",
        pagerdutyServiceId: "P1",
        openedAt: t0 + 60_000 + 10 * 60_000,
        resolvedAt: t0 + 60_000 + 20 * 60_000,
      });
      const m = changeFailureRate(db, cfg(), NOW, WINDOW);
      expect(m.value).toBeCloseTo(1 / 3, 5);
      expect(m.sample).toBe(3);
    });

    it("emits gap='no_pagerduty_mapping' when pagerdutyServices is empty", () => {
      for (let i = 0; i < 3; i++) {
        seedCiRun(db, `d${i}`, {
          service: "github_actions",
          title: "Deploy",
          conclusion: "success",
          repo: "nimbus-agent/payments",
          headSha: `sha-${i}`,
          modifiedAt: NOW - (i + 1) * 86_400_000,
        });
      }
      const m = changeFailureRate(db, cfg({ pagerdutyServices: [] }), NOW, WINDOW);
      expect(m.value).toBeNull();
      expect(m.gap).toBe("no_pagerduty_mapping");
      expect(m.sample).toBe(3);
    });

    it("computes ratio correctly when some deploys have no associated incidents", () => {
      const t0 = NOW - 3 * 86_400_000;
      for (let i = 0; i < 4; i++) {
        seedCiRun(db, `d${i}`, {
          service: "github_actions",
          title: "Deploy",
          conclusion: "success",
          repo: "nimbus-agent/payments",
          headSha: `sha-${i}`,
          modifiedAt: t0 + i * 86_400_000,
        });
      }
      seedIncident(db, "inc-1", {
        status: "resolved",
        pagerdutyServiceId: "P1",
        openedAt: t0 + 10 * 60_000,
        resolvedAt: t0 + 20 * 60_000,
      });
      const m = changeFailureRate(db, cfg(), NOW, WINDOW);
      expect(m.value).toBeCloseTo(1 / 4, 5);
      expect(m.sample).toBe(4);
      expect(m.gap).toBeNull();
    });
  });

  describe("mttr", () => {
    it("returns median resolution time in seconds", () => {
      const t0 = NOW - 3 * 86_400_000;
      seedIncident(db, "inc-1", {
        status: "resolved",
        pagerdutyServiceId: "P1",
        openedAt: t0,
        resolvedAt: t0 + 60_000,
      });
      seedIncident(db, "inc-2", {
        status: "resolved",
        pagerdutyServiceId: "P1",
        openedAt: t0 + 1000,
        resolvedAt: t0 + 1000 + 120_000,
      });
      seedIncident(db, "inc-3", {
        status: "resolved",
        pagerdutyServiceId: "P1",
        openedAt: t0 + 2000,
        resolvedAt: t0 + 2000 + 180_000,
      });
      const m = mttr(db, cfg(), NOW, WINDOW);
      expect(m.value).toBe(120);
      expect(m.unit).toBe("seconds_median");
      expect(m.sample).toBe(3);
      expect(m.gap).toBeNull();
    });

    it("N=1 → low_sample gap", () => {
      const t0 = NOW - 86_400_000;
      seedIncident(db, "inc-1", {
        status: "resolved",
        pagerdutyServiceId: "P1",
        openedAt: t0,
        resolvedAt: t0 + 60_000,
      });
      const m = mttr(db, cfg(), NOW, WINDOW);
      expect(m.value).toBe(60);
      expect(m.sample).toBe(1);
      expect(m.gap).toBe("low_sample");
    });

    it("N=2 → low_sample gap", () => {
      const t0 = NOW - 86_400_000;
      seedIncident(db, "inc-1", {
        status: "resolved",
        pagerdutyServiceId: "P1",
        openedAt: t0,
        resolvedAt: t0 + 60_000,
      });
      seedIncident(db, "inc-2", {
        status: "resolved",
        pagerdutyServiceId: "P1",
        openedAt: t0 + 1000,
        resolvedAt: t0 + 1000 + 180_000,
      });
      const m = mttr(db, cfg(), NOW, WINDOW);
      expect(m.value).toBe(Math.floor((60 + 180) / 2));
      expect(m.sample).toBe(2);
      expect(m.gap).toBe("low_sample");
    });

    it("emits gap='no_pagerduty_mapping' when pagerdutyServices is empty", () => {
      const m = mttr(db, cfg({ pagerdutyServices: [] }), NOW, WINDOW);
      expect(m.value).toBeNull();
      expect(m.sample).toBe(0);
      expect(m.gap).toBe("no_pagerduty_mapping");
    });

    it("ignores incidents with no pagerduty_service_id field", () => {
      const t0 = NOW - 86_400_000;
      db.run(
        `INSERT INTO item (id, service, type, external_id, title, body_preview, url, canonical_url,
                           modified_at, author_id, metadata, synced_at, pinned)
         VALUES (?, 'pagerduty', 'incident', ?, 'Incident', '', NULL, NULL, ?, NULL, ?, ?, 0)`,
        [
          "pagerduty:inc_no_service",
          "inc_no_service",
          t0 + 60_000,
          JSON.stringify({ status: "resolved", opened_at_ms: t0 }),
          t0 + 60_000,
        ],
      );
      for (let i = 0; i < 3; i++) {
        seedIncident(db, `pagerduty:inc_${i}`, {
          status: "resolved",
          pagerdutyServiceId: "P1",
          openedAt: t0 + i * 1000,
          resolvedAt: t0 + i * 1000 + (i + 1) * 60_000,
        });
      }
      const result = mttr(db, cfg(), NOW, WINDOW);
      expect(result.sample).toBe(3);
      expect(result.gap).toBeNull();
    });
  });

  describe("computeDoraMetrics envelope", () => {
    it("returns all four metrics with computed_at ISO string set to nowMs", () => {
      const result = computeDoraMetrics(db, cfg(), NOW, WINDOW);
      expect(result.service).toBe("payment-service");
      expect(result.since_ms).toBe(WINDOW);
      expect(result.computed_at).toBe(new Date(NOW).toISOString());
      expect(result.metrics.deployment_frequency).toBeDefined();
      expect(result.metrics.lead_time_for_changes).toBeDefined();
      expect(result.metrics.change_failure_rate).toBeDefined();
      expect(result.metrics.mttr).toBeDefined();
    });
  });

  describe("Multi-provider", () => {
    it("counts deploys across github_actions + gitlab when both providers are in cfg.repos", () => {
      const t0 = NOW - 86_400_000;
      seedCiRun(db, "gha-1", {
        service: "github_actions",
        title: "Deploy",
        conclusion: "success",
        repo: "org/svc",
        headSha: "sha-gha",
        modifiedAt: t0,
      });
      seedCiRun(db, "gl-1", {
        service: "gitlab",
        title: "Deploy",
        conclusion: "success",
        project: "org/svc-gl",
        headSha: "sha-gl",
        modifiedAt: t0 + 1000,
      });
      seedCiRun(db, "gl-2", {
        service: "gitlab",
        title: "Deploy",
        conclusion: "success",
        project: "other/repo",
        modifiedAt: t0 + 2000,
      });
      seedCiRun(db, "gha-2", {
        service: "github_actions",
        title: "Deploy",
        conclusion: "success",
        repo: "org/svc",
        headSha: "sha-gha-2",
        modifiedAt: t0 + 3000,
      });
      const multi = cfg({
        repos: [
          { provider: "github", providerId: "org/svc" },
          { provider: "gitlab", providerId: "org/svc-gl" },
        ],
      });
      const m = deploymentFrequency(db, multi, NOW, WINDOW);
      expect(m.sample).toBe(3);
      expect(m.gap).toBeNull();
    });
  });
});
