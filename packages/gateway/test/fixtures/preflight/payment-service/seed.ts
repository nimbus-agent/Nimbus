import type { Database } from "bun:sqlite";
import {
  EMPTY_NIMBUS_VAULT,
  syncTestContext,
} from "../../../../src/connectors/connector-sync-test-helpers.ts";
import { githubActionsRunMetadata } from "../../../../src/connectors/github-actions-sync.ts";
import { extractPrMetadataForIndex } from "../../../../src/connectors/github-sync.ts";
import { syncPagerdutyIncidentItems } from "../../../../src/connectors/pagerduty-sync.ts";
import type { ServiceConfig } from "../../../../src/metrics/dora-config.ts";
import { buildPagerdutyIncident } from "../../pagerduty/build-incident.ts";

export const PREFLIGHT_FIXTURE_NOW_MS = 1_715_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function ins(
  db: Database,
  row: {
    id: string;
    service: string;
    type: string;
    external_id: string;
    title: string;
    url: string | null;
    modified_at: number;
    metadata: Record<string, unknown>;
  },
) {
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, body_preview, url, canonical_url,
                       modified_at, author_id, metadata, synced_at, pinned)
     VALUES (?, ?, ?, ?, ?, '', ?, NULL, ?, NULL, ?, ?, 0)`,
    [
      row.id,
      row.service,
      row.type,
      row.external_id,
      row.title,
      row.url,
      row.modified_at,
      JSON.stringify(row.metadata),
      row.modified_at,
    ],
  );
}

export async function seedPaymentServicePreflightFixture(
  db: Database,
): Promise<{ config: ServiceConfig }> {
  const now = PREFLIGHT_FIXTURE_NOW_MS;

  const pdIncidents: unknown[] = [
    buildPagerdutyIncident({
      id: "inc_active",
      title: "DB connection pool exhausted",
      createdAt: new Date(now - 10 * MIN).toISOString(),
      updatedAt: new Date(now - 10 * MIN).toISOString(),
      status: "triggered",
      htmlUrl: "https://nimbus-agent.pagerduty.com/incidents/inc_active",
      serviceId: "P12ABCD",
      priorityName: "P1",
    }),
    buildPagerdutyIncident({
      id: "inc_resolved",
      title: "Old P1 (resolved)",
      createdAt: new Date(now - 2 * DAY - 30 * MIN).toISOString(),
      updatedAt: new Date(now - 2 * DAY).toISOString(),
      status: "resolved",
      serviceId: "P12ABCD",
      priorityName: "P1",
    }),
    buildPagerdutyIncident({
      id: "inc_no_priority",
      title: "Triggered without priority",
      createdAt: new Date(now - 5 * MIN).toISOString(),
      updatedAt: new Date(now - 5 * MIN).toISOString(),
      status: "triggered",
      serviceId: "P12ABCD",
      priorityName: null,
    }),
  ];

  syncPagerdutyIncidentItems(
    syncTestContext(db, EMPTY_NIMBUS_VAULT, "pagerduty"),
    pdIncidents,
    new Date(now - 30 * DAY).toISOString(),
    now,
    new Map(),
  );

  ins(db, {
    id: "github_actions:ci_main_pass",
    service: "github_actions",
    type: "ci_run",
    external_id: "ci_main_pass",
    title: "CI lint",
    url: "https://github.com/nimbus-agent/payments/actions/runs/1",
    modified_at: now - 30 * MIN,
    metadata: githubActionsRunMetadata(
      "nimbus-agent/payments",
      {
        id: 1,
        name: "CI lint",
        status: "completed",
        conclusion: "success",
        head_branch: "main",
        head_sha: "sha_main_1",
      },
      now,
    ),
  });
  ins(db, {
    id: "github_actions:ci_main_fail",
    service: "github_actions",
    type: "ci_run",
    external_id: "ci_main_fail",
    title: "Build and Test",
    url: "https://github.com/nimbus-agent/payments/actions/runs/2",
    modified_at: now - 20 * MIN,
    metadata: githubActionsRunMetadata(
      "nimbus-agent/payments",
      {
        id: 2,
        name: "Build and Test",
        status: "completed",
        conclusion: "failure",
        head_branch: "main",
        head_sha: "sha_main_2",
      },
      now,
    ),
  });
  ins(db, {
    id: "github_actions:ci_feature_fail_1",
    service: "github_actions",
    type: "ci_run",
    external_id: "ci_feature_fail_1",
    title: "Build and Test",
    url: null,
    modified_at: now - 1 * HOUR,
    metadata: githubActionsRunMetadata(
      "nimbus-agent/payments",
      {
        id: 3,
        name: "Build and Test",
        status: "completed",
        conclusion: "failure",
        head_branch: "feature-x",
        head_sha: "sha_feature_1",
      },
      now,
    ),
  });
  ins(db, {
    id: "github_actions:ci_feature_fail_2",
    service: "github_actions",
    type: "ci_run",
    external_id: "ci_feature_fail_2",
    title: "Lint",
    url: null,
    modified_at: now - 2 * HOUR,
    metadata: githubActionsRunMetadata(
      "nimbus-agent/payments",
      {
        id: 4,
        name: "Lint",
        status: "completed",
        conclusion: "failure",
        head_branch: "feature-x",
        head_sha: "sha_feature_2",
      },
      now,
    ),
  });

  ins(db, {
    id: "github:pr_dirty",
    service: "github",
    type: "pr",
    external_id: "nimbus-agent/payments#100",
    title: "Refactor billing retry",
    url: "https://github.com/nimbus-agent/payments/pull/100",
    modified_at: now - 1 * HOUR,
    metadata: extractPrMetadataForIndex(
      "nimbus-agent/payments",
      {
        number: 100,
        state: "open",
        mergeable_state: "dirty",
        mergeable: false,
      },
      now,
    ),
  });
  ins(db, {
    id: "github:pr_clean",
    service: "github",
    type: "pr",
    external_id: "nimbus-agent/payments#101",
    title: "Add metric",
    url: "https://github.com/nimbus-agent/payments/pull/101",
    modified_at: now - 30 * MIN,
    metadata: extractPrMetadataForIndex(
      "nimbus-agent/payments",
      {
        number: 101,
        state: "open",
        mergeable_state: "clean",
        mergeable: true,
      },
      now,
    ),
  });
  ins(db, {
    id: "github:pr_unknown",
    service: "github",
    type: "pr",
    external_id: "nimbus-agent/payments#102",
    title: "WIP big refactor",
    url: null,
    modified_at: now - 6 * HOUR,
    metadata: extractPrMetadataForIndex(
      "nimbus-agent/payments",
      {
        number: 102,
        state: "open",
      },
      now,
    ),
  });

  const config: ServiceConfig = {
    serviceId: "payment-service",
    repos: [{ provider: "github", providerId: "nimbus-agent/payments" }],
    pagerdutyServices: ["P12ABCD"],
    deployWorkflowPattern: /^[Dd]eploy/,
    incidentWindowMinutes: 60,
    excludePrLabels: ["revert"],
    deployEnvironments: ["prod"],
    severityP1Aliases: [],
  };
  return { config };
}
