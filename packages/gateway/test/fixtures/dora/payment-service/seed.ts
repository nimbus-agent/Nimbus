import type { Database } from "bun:sqlite";
import {
  EMPTY_NIMBUS_VAULT,
  silentSyncContextExtras,
} from "../../../../src/connectors/connector-sync-test-helpers.ts";
import { syncPagerdutyIncidentItems } from "../../../../src/connectors/pagerduty-sync.ts";
import type { ServiceConfig } from "../../../../src/metrics/dora-config.ts";
import { buildPagerdutyIncident } from "../../pagerduty/build-incident.ts";

export const FIXTURE_NOW_MS = 1_715_000_000_000;
const DAY = 86_400_000;

type ItemRow = {
  id: string;
  service: string;
  type: string;
  external_id: string;
  title: string;
  modified_at: number;
  metadata: Record<string, unknown>;
  synced_at?: number;
};

function ins(db: Database, row: ItemRow): void {
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, body_preview, url, canonical_url,
                       modified_at, author_id, metadata, synced_at, pinned)
     VALUES (?, ?, ?, ?, ?, '', NULL, NULL, ?, NULL, ?, ?, 0)`,
    [
      row.id,
      row.service,
      row.type,
      row.external_id,
      row.title,
      row.modified_at,
      JSON.stringify(row.metadata),
      row.synced_at ?? row.modified_at,
    ],
  );
}

export async function seedPaymentServiceFixture(db: Database): Promise<{ config: ServiceConfig }> {
  let t = FIXTURE_NOW_MS - 5 * DAY;
  for (let i = 0; i < 8; i++) {
    ins(db, {
      id: `github_actions:gha_deploy_${i}`,
      service: "github_actions",
      type: "ci_run",
      external_id: `gha_deploy_${i}`,
      title: "Deploy production",
      modified_at: t,
      metadata: {
        conclusion: "success",
        repo: "nimbus-agent/payments",
        headSha: `sha_gha_${i}`,
      },
    });
    t -= 2 * DAY;
  }

  t = FIXTURE_NOW_MS - 1 * DAY;
  for (let i = 0; i < 4; i++) {
    ins(db, {
      id: `gitlab:gl_deploy_${i}`,
      service: "gitlab",
      type: "ci_run",
      external_id: `gl_deploy_${i}`,
      title: "Deploy production",
      modified_at: t,
      metadata: {
        conclusion: "success",
        project: "nimbus-agent/payments",
        headSha: `sha_gl_${i}`,
      },
    });
    t -= 3 * DAY;
  }

  ins(db, {
    id: "jenkins:jen_deploy_0",
    service: "jenkins",
    type: "ci_run",
    external_id: "jen_deploy_0",
    title: "Deploy to prod",
    modified_at: FIXTURE_NOW_MS - 15 * DAY,
    metadata: {
      conclusion: "success",
      jobName: "payment-service/deploy-prod",
      headSha: "sha_jen_0",
    },
  });

  for (let i = 0; i < 8; i++) {
    const deployAt = FIXTURE_NOW_MS - 5 * DAY - i * 2 * DAY;
    const mergedAt = deployAt - 3600_000;
    ins(db, {
      id: `github:pr_${i}`,
      service: "github",
      type: "pr",
      external_id: `nimbus-agent/payments#${i}`,
      title: `PR ${i}`,
      modified_at: mergedAt,
      metadata: {
        repo: "nimbus-agent/payments",
        merged: true,
        merged_at: mergedAt,
        merge_commit_sha: `sha_gha_${i}`,
        labels: [],
      },
    });
  }

  for (let i = 0; i < 4; i++) {
    const deployAt = FIXTURE_NOW_MS - 1 * DAY - i * 3 * DAY;
    const mergedAt = deployAt - 7200_000;
    ins(db, {
      id: `gitlab:pr_${i}`,
      service: "gitlab",
      type: "pr",
      external_id: `nimbus-agent/payments!${i}`,
      title: `MR ${i}`,
      modified_at: mergedAt,
      metadata: {
        project: "nimbus-agent/payments",
        merged: true,
        merged_at: mergedAt,
        merge_commit_sha: `sha_gl_${i}`,
        labels: [],
      },
    });
  }

  for (let i = 0; i < 7; i++) {
    const mergedAt = FIXTURE_NOW_MS - (10 * DAY + i * 1 * DAY) - 1800_000;
    ins(db, {
      id: `github:pr_extra_${i}`,
      service: "github",
      type: "pr",
      external_id: `nimbus-agent/payments#extra${i}`,
      title: `extra PR ${i}`,
      modified_at: mergedAt,
      metadata: {
        repo: "nimbus-agent/payments",
        merged: true,
        merged_at: mergedAt,
        merge_commit_sha: `sha_gha_${i}`, // shares SHA with gha_deploy_${i}
        labels: [],
      },
    });
  }

  for (let i = 0; i < 3; i++) {
    const mergedAt = FIXTURE_NOW_MS - (4 * DAY + i * DAY);
    ins(db, {
      id: `github:pr_revert_${i}`,
      service: "github",
      type: "pr",
      external_id: `nimbus-agent/payments#revert${i}`,
      title: `Revert ${i}`,
      modified_at: mergedAt,
      metadata: {
        repo: "nimbus-agent/payments",
        merged: true,
        merged_at: mergedAt,
        merge_commit_sha: `sha_gha_${i}`,
        labels: ["revert"],
      },
    });
  }

  const pdIncidents: unknown[] = [];
  for (let i = 0; i < 3; i++) {
    const deployAt = FIXTURE_NOW_MS - 5 * DAY - i * 2 * DAY;
    const openedAt = deployAt + 10 * 60_000;
    const resolvedAt = openedAt + (20 + i * 5) * 60_000;
    pdIncidents.push(
      buildPagerdutyIncident({
        id: `inc_${i}`,
        title: `Incident ${i}`,
        createdAt: new Date(openedAt).toISOString(),
        updatedAt: new Date(resolvedAt).toISOString(),
        status: "resolved",
        serviceId: "P12ABCD",
        priorityName: "P1",
      }),
    );
  }
  const outsideOpened = FIXTURE_NOW_MS - 7 * DAY - 90 * 60_000;
  const outsideResolved = outsideOpened + 30 * 60_000;
  pdIncidents.push(
    buildPagerdutyIncident({
      id: "inc_outside",
      title: "Late alert",
      createdAt: new Date(outsideOpened).toISOString(),
      updatedAt: new Date(outsideResolved).toISOString(),
      status: "resolved",
      serviceId: "P12ABCD",
      priorityName: "P1",
    }),
  );

  syncPagerdutyIncidentItems(
    { db, vault: EMPTY_NIMBUS_VAULT, ...silentSyncContextExtras() },
    pdIncidents,
    new Date(FIXTURE_NOW_MS - 30 * DAY).toISOString(),
    FIXTURE_NOW_MS,
    new Map(),
  );

  const config: ServiceConfig = {
    serviceId: "payment-service",
    repos: [
      { provider: "github", providerId: "nimbus-agent/payments" },
      { provider: "gitlab", providerId: "nimbus-agent/payments" },
      { provider: "jenkins", providerId: "payment-service/deploy-prod" },
    ],
    pagerdutyServices: ["P12ABCD"],
    deployWorkflowPattern: /^[Dd]eploy/,
    incidentWindowMinutes: 60,
    excludePrLabels: ["revert"],
    deployEnvironments: ["prod"],
    severityP1Aliases: [],
  };
  return { config };
}
