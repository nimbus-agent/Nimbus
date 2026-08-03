import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServiceConfig } from "../../../src/metrics/dora-config.ts";
import { computeDeployPreflight } from "../../../src/preflight/preflight.ts";
import { openSeededDbFile } from "../../helpers/migrated-db-seed.ts";

function seedIncident(
  db: Database,
  id: string,
  opts: {
    status: "triggered" | "acknowledged" | "resolved";
    severity?: string;
    urgency?: string;
    pagerdutyServiceId: string;
    openedAtMs: number;
    title?: string;
    url?: string;
  },
) {
  const meta: Record<string, unknown> = {
    status: opts.status,
    pagerduty_service_id: opts.pagerdutyServiceId,
    opened_at_ms: opts.openedAtMs,
  };
  if (opts.severity !== undefined) meta.severity = opts.severity;
  if (opts.urgency !== undefined) meta.urgency = opts.urgency;
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, body_preview, url, canonical_url,
                       modified_at, author_id, metadata, synced_at, pinned)
     VALUES (?, 'pagerduty', 'incident', ?, ?, '', ?, NULL, ?, NULL, ?, ?, 0)`,
    [
      id,
      id,
      opts.title ?? "Incident",
      opts.url ?? null,
      opts.openedAtMs,
      JSON.stringify(meta),
      opts.openedAtMs,
    ],
  );
}

function seedCiRun(
  db: Database,
  id: string,
  opts: {
    service: string;
    title: string;
    conclusion: "success" | "failure" | "cancelled" | "timed_out";
    branch: string;
    headSha?: string;
    workflowName?: string;
    modifiedAtMs: number;
    url?: string;
  },
) {
  const meta: Record<string, unknown> = {
    conclusion: opts.conclusion,
    branch: opts.branch,
  };
  if (opts.headSha) meta.headSha = opts.headSha;
  if (opts.workflowName) meta.workflow_name = opts.workflowName;
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, body_preview, url, canonical_url,
                       modified_at, author_id, metadata, synced_at, pinned)
     VALUES (?, ?, 'ci_run', ?, ?, '', ?, NULL, ?, NULL, ?, ?, 0)`,
    [
      id,
      opts.service,
      id,
      opts.title,
      opts.url ?? null,
      opts.modifiedAtMs,
      JSON.stringify(meta),
      opts.modifiedAtMs,
    ],
  );
}

function seedPr(
  db: Database,
  id: string,
  opts: {
    service: string;
    repo?: string;
    project?: string;
    number: number;
    state: "open" | "closed";
    title?: string;
    mergeableState?: string | null;
    modifiedAtMs: number;
    url?: string;
  },
) {
  const meta: Record<string, unknown> = {
    number: opts.number,
    state: opts.state,
  };
  if (opts.repo) meta.repo = opts.repo;
  if (opts.project) meta.project = opts.project;
  if (opts.mergeableState !== undefined) meta.mergeable_state = opts.mergeableState;
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, body_preview, url, canonical_url,
                       modified_at, author_id, metadata, synced_at, pinned)
     VALUES (?, ?, 'pr', ?, ?, '', ?, NULL, ?, NULL, ?, ?, 0)`,
    [
      id,
      opts.service,
      id,
      opts.title ?? `PR #${opts.number}`,
      opts.url ?? null,
      opts.modifiedAtMs,
      JSON.stringify(meta),
      opts.modifiedAtMs,
    ],
  );
}

function cfg(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    serviceId: "payment-service",
    repos: [{ provider: "github", providerId: "nimbus-agent/payments" }],
    pagerdutyServices: ["P12ABCD"],
    deployWorkflowPattern: /^[Dd]eploy/,
    incidentWindowMinutes: 60,
    excludePrLabels: ["revert"],
    deployEnvironments: ["prod"],
    severityP1Aliases: [],
    ...overrides,
  };
}

describe("computeDeployPreflight: verdict + envelope", () => {
  let dir: string;
  let db: Database;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nimbus-preflight-"));
    db = openSeededDbFile(join(dir, "nimbus.db"), 27);
  });
  afterEach(() => {
    db.close();
    try {
      // maxRetries: 0 / retryDelay: 0 — a pinned handle must fail FAST rather than block
      // the hook's timeout budget; a leaked temp dir is the accepted trade-off (#972,
      // #973). Do NOT turn this back into a blocking retry.
      rmSync(dir, { recursive: true, force: true, maxRetries: 0, retryDelay: 0 });
    } catch {
      /* non-fatal */
    }
  });

  it("returns verdict='ok' when every check has count===0 even with gaps present", () => {
    const now = 1_715_000_000_000;
    const out = computeDeployPreflight(db, cfg({ pagerdutyServices: [] }), "main", now, 10);
    expect(out.verdict).toBe("ok");
    expect(out.checks.active_p1_incidents.count).toBe(0);
    expect(out.checks.active_p1_incidents.gap).toBe("no_pagerduty_mapping");
    expect(out.service).toBe("payment-service");
    expect(out.target_ref).toBe("main");
    expect(out.computed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("returns verdict='warn' when any check has count>0", () => {
    const now = 1_715_000_000_000;
    seedIncident(db, "pagerduty:inc_1", {
      status: "triggered",
      severity: "P1",
      pagerdutyServiceId: "P12ABCD",
      openedAtMs: now - 60_000,
    });
    const out = computeDeployPreflight(db, cfg(), "main", now, 10);
    expect(out.verdict).toBe("warn");
    expect(out.checks.active_p1_incidents.count).toBe(1);
  });
});

describe("computeDeployPreflight: active_p1_incidents check", () => {
  let dir: string;
  let db: Database;
  const now = 1_715_000_000_000;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nimbus-preflight-inc-"));
    db = openSeededDbFile(join(dir, "nimbus.db"), 27);
  });
  afterEach(() => {
    db.close();
    try {
      // maxRetries: 0 / retryDelay: 0 — a pinned handle must fail FAST rather than block
      // the hook's timeout budget; a leaked temp dir is the accepted trade-off (#972,
      // #973). Do NOT turn this back into a blocking retry.
      rmSync(dir, { recursive: true, force: true, maxRetries: 0, retryDelay: 0 });
    } catch {
      /* non-fatal */
    }
  });

  it("counts triggered + acknowledged P1 incidents on the configured PD service", () => {
    seedIncident(db, "pagerduty:inc_1", {
      status: "triggered",
      severity: "P1",
      pagerdutyServiceId: "P12ABCD",
      openedAtMs: now - 60_000,
    });
    seedIncident(db, "pagerduty:inc_2", {
      status: "acknowledged",
      severity: "P1",
      pagerdutyServiceId: "P12ABCD",
      openedAtMs: now - 120_000,
    });
    seedIncident(db, "pagerduty:inc_3", {
      status: "resolved",
      severity: "P1",
      pagerdutyServiceId: "P12ABCD",
      openedAtMs: now - 180_000,
    });
    seedIncident(db, "pagerduty:inc_4", {
      status: "triggered",
      severity: "P2",
      pagerdutyServiceId: "P12ABCD",
      openedAtMs: now - 240_000,
    });
    const out = computeDeployPreflight(db, cfg(), "main", now, 10);
    expect(out.checks.active_p1_incidents.count).toBe(2);
    expect(out.checks.active_p1_incidents.gap).toBeNull();
  });

  it("excludes incidents on other PagerDuty services", () => {
    seedIncident(db, "pagerduty:other_svc", {
      status: "triggered",
      severity: "P1",
      pagerdutyServiceId: "P-OTHER",
      openedAtMs: now - 60_000,
    });
    const out = computeDeployPreflight(db, cfg(), "main", now, 10);
    expect(out.checks.active_p1_incidents.count).toBe(0);
  });

  it("emits gap='no_pagerduty_mapping' when cfg.pagerdutyServices is empty", () => {
    const out = computeDeployPreflight(db, cfg({ pagerdutyServices: [] }), "main", now, 10);
    expect(out.checks.active_p1_incidents.count).toBe(0);
    expect(out.checks.active_p1_incidents.gap).toBe("no_pagerduty_mapping");
  });

  it("caps findings to max_findings (most recent first)", () => {
    for (let i = 0; i < 15; i++) {
      seedIncident(db, `pagerduty:inc_${i}`, {
        status: "triggered",
        severity: "P1",
        pagerdutyServiceId: "P12ABCD",
        openedAtMs: now - i * 60_000,
      });
    }
    const out = computeDeployPreflight(db, cfg(), "main", now, 5);
    expect(out.checks.active_p1_incidents.count).toBe(15);
    expect(out.checks.active_p1_incidents.findings).toHaveLength(5);
    expect(out.checks.active_p1_incidents.findings[0]?.id).toBe("pagerduty:inc_0");
  });

  it('alias "critical" counts toward P1 and preserves raw severity in finding', () => {
    seedIncident(db, "pagerduty:inc_crit", {
      status: "triggered",
      severity: "Critical",
      pagerdutyServiceId: "P12ABCD",
      openedAtMs: now - 60_000,
    });
    const out = computeDeployPreflight(
      db,
      cfg({ severityP1Aliases: ["critical"] }),
      "main",
      now,
      10,
    );
    expect(out.checks.active_p1_incidents.count).toBe(1);
    expect(out.checks.active_p1_incidents.findings[0]?.severity).toBe("Critical");
  });

  it("alias match is case-insensitive on both sides", () => {
    seedIncident(db, "pagerduty:inc_upper", {
      status: "triggered",
      severity: "CRITICAL",
      pagerdutyServiceId: "P12ABCD",
      openedAtMs: now - 60_000,
    });
    seedIncident(db, "pagerduty:inc_p1", {
      status: "triggered",
      severity: "P1",
      pagerdutyServiceId: "P12ABCD",
      openedAtMs: now - 120_000,
    });
    const out = computeDeployPreflight(
      db,
      cfg({ severityP1Aliases: ["critical"] }),
      "main",
      now,
      10,
    );
    expect(out.checks.active_p1_incidents.count).toBe(2);
  });

  it("empty severityP1Aliases preserves verbatim P1 behavior", () => {
    seedIncident(db, "pagerduty:inc_p1", {
      status: "triggered",
      severity: "P1",
      pagerdutyServiceId: "P12ABCD",
      openedAtMs: now - 60_000,
    });
    seedIncident(db, "pagerduty:inc_crit", {
      status: "triggered",
      severity: "Critical",
      pagerdutyServiceId: "P12ABCD",
      openedAtMs: now - 120_000,
    });
    const out = computeDeployPreflight(db, cfg(), "main", now, 10);
    expect(out.checks.active_p1_incidents.count).toBe(1);
    expect(out.checks.active_p1_incidents.findings[0]?.id).toBe("pagerduty:inc_p1");
  });

  it('emits gap="pagerduty_urgency_without_priority" when count===0 and high-urgency incidents lack priority', () => {
    seedIncident(db, "pagerduty:no_pri", {
      status: "triggered",
      urgency: "high",
      pagerdutyServiceId: "P12ABCD",
      openedAtMs: now - 60_000,
    });
    const out = computeDeployPreflight(db, cfg(), "main", now, 10);
    expect(out.checks.active_p1_incidents.count).toBe(0);
    expect(out.checks.active_p1_incidents.gap).toBe("pagerduty_urgency_without_priority");
  });

  it("urgency-gap is suppressed when count > 0", () => {
    seedIncident(db, "pagerduty:has_p1", {
      status: "triggered",
      severity: "P1",
      pagerdutyServiceId: "P12ABCD",
      openedAtMs: now - 60_000,
    });
    seedIncident(db, "pagerduty:no_pri", {
      status: "triggered",
      urgency: "high",
      pagerdutyServiceId: "P12ABCD",
      openedAtMs: now - 30_000,
    });
    const out = computeDeployPreflight(db, cfg(), "main", now, 10);
    expect(out.checks.active_p1_incidents.count).toBe(1);
    expect(out.checks.active_p1_incidents.gap).toBeNull();
  });

  it("urgency-gap defers to no_pagerduty_mapping when no services configured", () => {
    seedIncident(db, "pagerduty:no_pri", {
      status: "triggered",
      urgency: "high",
      pagerdutyServiceId: "P12ABCD",
      openedAtMs: now - 60_000,
    });
    const out = computeDeployPreflight(db, cfg({ pagerdutyServices: [] }), "main", now, 10);
    expect(out.checks.active_p1_incidents.count).toBe(0);
    expect(out.checks.active_p1_incidents.gap).toBe("no_pagerduty_mapping");
  });

  it("urgency-gap requires status in (triggered, acknowledged) — resolved high-urgency does not trigger", () => {
    seedIncident(db, "pagerduty:resolved_high", {
      status: "resolved",
      urgency: "high",
      pagerdutyServiceId: "P12ABCD",
      openedAtMs: now - 60_000,
    });
    const out = computeDeployPreflight(db, cfg(), "main", now, 10);
    expect(out.checks.active_p1_incidents.count).toBe(0);
    expect(out.checks.active_p1_incidents.gap).toBeNull();
  });
});

describe("computeDeployPreflight: failing_ci_runs check", () => {
  let dir: string;
  let db: Database;
  const now = 1_715_000_000_000;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nimbus-preflight-ci-"));
    db = openSeededDbFile(join(dir, "nimbus.db"), 27);
  });
  afterEach(() => {
    db.close();
    try {
      // maxRetries: 0 / retryDelay: 0 — a pinned handle must fail FAST rather than block
      // the hook's timeout budget; a leaked temp dir is the accepted trade-off (#972,
      // #973). Do NOT turn this back into a blocking retry.
      rmSync(dir, { recursive: true, force: true, maxRetries: 0, retryDelay: 0 });
    } catch {
      /* non-fatal */
    }
  });

  it("counts only failing/cancelled/timed_out runs on the target branch", () => {
    seedCiRun(db, "github_actions:r1", {
      service: "github_actions",
      title: "Deploy production",
      conclusion: "failure",
      branch: "main",
      workflowName: "Deploy production",
      modifiedAtMs: now - 60_000,
    });
    seedCiRun(db, "github_actions:r2", {
      service: "github_actions",
      title: "CI lint",
      conclusion: "success",
      branch: "main",
      workflowName: "CI lint",
      modifiedAtMs: now - 30_000,
    });
    seedCiRun(db, "github_actions:r3", {
      service: "github_actions",
      title: "Deploy production",
      conclusion: "failure",
      branch: "feature-x",
      workflowName: "Deploy production",
      modifiedAtMs: now - 90_000,
    });
    const out = computeDeployPreflight(db, cfg(), "main", now, 10);
    expect(out.checks.failing_ci_runs.count).toBe(1);
  });

  it("groups by workflow_name and keeps only the most recent failing run per workflow", () => {
    seedCiRun(db, "github_actions:old", {
      service: "github_actions",
      title: "Deploy production",
      conclusion: "failure",
      branch: "main",
      workflowName: "Deploy production",
      modifiedAtMs: now - 3 * 60_000,
    });
    seedCiRun(db, "github_actions:mid", {
      service: "github_actions",
      title: "Deploy production",
      conclusion: "failure",
      branch: "main",
      workflowName: "Deploy production",
      modifiedAtMs: now - 2 * 60_000,
    });
    seedCiRun(db, "github_actions:newest", {
      service: "github_actions",
      title: "Deploy production",
      conclusion: "failure",
      branch: "main",
      workflowName: "Deploy production",
      modifiedAtMs: now - 60_000,
    });
    const out = computeDeployPreflight(db, cfg(), "main", now, 10);
    expect(out.checks.failing_ci_runs.count).toBe(1);
    expect(out.checks.failing_ci_runs.findings[0]?.id).toBe("github_actions:newest");
  });

  it("falls back to title when workflow_name is missing", () => {
    seedCiRun(db, "github_actions:no_wf", {
      service: "github_actions",
      title: "Build and Test",
      conclusion: "failure",
      branch: "main",
      modifiedAtMs: now - 60_000,
    });
    seedCiRun(db, "github_actions:no_wf_2", {
      service: "github_actions",
      title: "Build and Test",
      conclusion: "failure",
      branch: "main",
      modifiedAtMs: now - 120_000,
    });
    const out = computeDeployPreflight(db, cfg(), "main", now, 10);
    expect(out.checks.failing_ci_runs.count).toBe(1);
  });

  it("emits gap='no_repos' when cfg.repos is empty", () => {
    const out = computeDeployPreflight(db, cfg({ repos: [] }), "main", now, 10);
    expect(out.checks.failing_ci_runs.count).toBe(0);
    expect(out.checks.failing_ci_runs.gap).toBe("no_repos");
  });
});

describe("computeDeployPreflight: merge_conflicts check", () => {
  let dir: string;
  let db: Database;
  const now = 1_715_000_000_000;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nimbus-preflight-pr-"));
    db = openSeededDbFile(join(dir, "nimbus.db"), 27);
  });
  afterEach(() => {
    db.close();
    try {
      // maxRetries: 0 / retryDelay: 0 — a pinned handle must fail FAST rather than block
      // the hook's timeout budget; a leaked temp dir is the accepted trade-off (#972,
      // #973). Do NOT turn this back into a blocking retry.
      rmSync(dir, { recursive: true, force: true, maxRetries: 0, retryDelay: 0 });
    } catch {
      /* non-fatal */
    }
  });

  it("counts open PRs with mergeable_state='dirty' on matching repos", () => {
    seedPr(db, "github:pr_1", {
      service: "github",
      repo: "nimbus-agent/payments",
      number: 1,
      state: "open",
      mergeableState: "dirty",
      modifiedAtMs: now - 60_000,
    });
    seedPr(db, "github:pr_2", {
      service: "github",
      repo: "nimbus-agent/payments",
      number: 2,
      state: "open",
      mergeableState: "clean",
      modifiedAtMs: now - 30_000,
    });
    seedPr(db, "github:pr_3_closed", {
      service: "github",
      repo: "nimbus-agent/payments",
      number: 3,
      state: "closed",
      mergeableState: "dirty",
      modifiedAtMs: now - 90_000,
    });
    const out = computeDeployPreflight(db, cfg(), "main", now, 10);
    expect(out.checks.merge_conflicts.count).toBe(1);
    expect(out.checks.merge_conflicts.gap).toBeNull();
  });

  it("emits gap='unknown_mergeable_state' when any matching open PR has null mergeable_state", () => {
    seedPr(db, "github:pr_dirty", {
      service: "github",
      repo: "nimbus-agent/payments",
      number: 1,
      state: "open",
      mergeableState: "dirty",
      modifiedAtMs: now - 60_000,
    });
    seedPr(db, "github:pr_unknown", {
      service: "github",
      repo: "nimbus-agent/payments",
      number: 2,
      state: "open",
      mergeableState: null,
      modifiedAtMs: now - 30_000,
    });
    const out = computeDeployPreflight(db, cfg(), "main", now, 10);
    expect(out.checks.merge_conflicts.count).toBe(1);
    expect(out.checks.merge_conflicts.gap).toBe("unknown_mergeable_state");
  });

  it("excludes PRs from non-matching repos", () => {
    seedPr(db, "github:other_repo", {
      service: "github",
      repo: "nimbus-agent/other",
      number: 1,
      state: "open",
      mergeableState: "dirty",
      modifiedAtMs: now - 60_000,
    });
    const out = computeDeployPreflight(db, cfg(), "main", now, 10);
    expect(out.checks.merge_conflicts.count).toBe(0);
  });
});

describe("computeDeployPreflight: max_findings", () => {
  let dir: string;
  let db: Database;
  const now = 1_715_000_000_000;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nimbus-preflight-max-"));
    db = openSeededDbFile(join(dir, "nimbus.db"), 27);
  });
  afterEach(() => {
    db.close();
    try {
      // maxRetries: 0 / retryDelay: 0 — a pinned handle must fail FAST rather than block
      // the hook's timeout budget; a leaked temp dir is the accepted trade-off (#972,
      // #973). Do NOT turn this back into a blocking retry.
      rmSync(dir, { recursive: true, force: true, maxRetries: 0, retryDelay: 0 });
    } catch {
      /* non-fatal */
    }
  });

  it("caps findings independently per check", () => {
    for (let i = 0; i < 12; i++) {
      seedPr(db, `github:pr_${i}`, {
        service: "github",
        repo: "nimbus-agent/payments",
        number: i,
        state: "open",
        mergeableState: "dirty",
        modifiedAtMs: now - i * 60_000,
      });
    }
    const out = computeDeployPreflight(db, cfg(), "main", now, 3);
    expect(out.checks.merge_conflicts.count).toBe(12);
    expect(out.checks.merge_conflicts.findings).toHaveLength(3);
  });
});
