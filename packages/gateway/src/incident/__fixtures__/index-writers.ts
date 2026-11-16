import type { Database } from "bun:sqlite";

import { githubActionsRunMetadata } from "../../connectors/github-actions-sync.ts";
import { extractPrMetadataForIndex } from "../../connectors/github-sync.ts";
import { upsertOncallShift } from "../../connectors/oncall-shift-items.ts";
import { pdEntryToShift } from "../../connectors/pagerduty-oncall.ts";
import { annotateDeployment } from "../../deployment/annotate.ts";
import { graphAnnotatedDeployment } from "../../deployment/graph-annotated.ts";
import type { DeploymentAnnotateInput } from "../../deployment/types.ts";
import { upsertIndexedItem } from "../../index/item-store.ts";
import { NO_INCIDENT_BINDINGS, type ServiceConfig } from "../../metrics/dora-config.ts";
import {
  buildServiceIdentityResolver,
  type ServiceIdentityResolver,
} from "../../metrics/service-identity.ts";
import { fixtureCtx } from "./trigger-writers.ts";

/**
 * Index writers for the incident-engine tests, built from the real connector writers and mappers (never
 * hand-built metadata), so a test cannot filter on a key no writer writes.
 */

export const HOUR = 3_600_000;
export const T0 = Date.parse("2026-11-10T12:00:00.000Z");
export const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

export function serviceConfig(over: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    serviceId: "payment-service",
    repos: [{ provider: "github", providerId: "acme/payment-service" }],
    pagerdutyServices: ["PSVC1"],
    deployWorkflowPattern: /^Deploy/,
    incidentWindowMinutes: 60,
    excludePrLabels: [],
    deployEnvironments: ["prod"],
    severityP1Aliases: [],
    ...NO_INCIDENT_BINDINGS,
    jsmAlertTags: ["payments"],
    sentryProjects: ["payments-api"],
    dataModels: ["analytics.payments.*"],
    ...over,
  };
}

export function configMap(...cfgs: ServiceConfig[]): Map<string, ServiceConfig> {
  return new Map(cfgs.map((c) => [c.serviceId, c]));
}

export function resolverFor(...cfgs: ServiceConfig[]): ServiceIdentityResolver {
  return buildServiceIdentityResolver(configMap(...cfgs));
}

/** An annotated deployment of `service` (graphed through the real populator). Returns the item id. */
export function writeDeployment(
  db: Database,
  resolver: ServiceIdentityResolver,
  over: {
    readonly service?: string;
    readonly startedAtMs?: number;
    readonly sha?: string;
    readonly runId?: string | null;
    readonly environment?: string;
  } = {},
): string {
  const runId = over.runId === null ? undefined : (over.runId ?? "7412");
  const input: DeploymentAnnotateInput = {
    service: over.service ?? "payment-service",
    provider: "github-actions",
    environment: over.environment ?? "prod",
    sha: over.sha ?? SHA,
    ref: "main",
    status: "success",
    started_at_ms: over.startedAtMs ?? T0,
    ...(runId === undefined ? {} : { run_id: runId }),
  };
  const r = annotateDeployment(db, input, over.startedAtMs ?? T0);
  const id = `deployment:${r.external_id}`;
  graphAnnotatedDeployment(db, id, resolver);
  return id;
}

export function writeMergedPr(
  db: Database,
  resolver: ServiceIdentityResolver,
  over: {
    readonly number?: number;
    readonly title?: string;
    readonly sha?: string;
    readonly mergedAtMs?: number;
    readonly branch?: string;
    readonly repo?: string;
  } = {},
): string {
  const repo = over.repo ?? "acme/payment-service";
  const n = over.number ?? 501;
  const at = over.mergedAtMs ?? T0;
  upsertIndexedItem(
    db,
    {
      service: "github",
      type: "pr",
      externalId: `${repo}#${String(n)}`,
      title: over.title ?? "Mitigate payment latency",
      bodyPreview: "",
      modifiedAt: at,
      syncedAt: at,
      metadata: extractPrMetadataForIndex(
        repo,
        {
          number: n,
          state: "closed",
          merged: true,
          merged_at: new Date(at).toISOString(),
          merge_commit_sha: over.sha ?? SHA,
          additions: 12,
          deletions: 3,
          changed_files: 2,
          head: { ref: over.branch ?? "fix/latency" },
        },
        at,
      ),
    },
    resolver,
  );
  return `github:${repo}#${String(n)}`;
}

export function writeCiRun(
  db: Database,
  resolver: ServiceIdentityResolver,
  over: { readonly runId?: number; readonly repo?: string; readonly sha?: string } = {},
): string {
  const repo = over.repo ?? "acme/payment-service";
  const id = over.runId ?? 7412;
  upsertIndexedItem(
    db,
    {
      service: "github_actions",
      type: "ci_run",
      externalId: `${repo}#run-${String(id)}`,
      title: "Deploy run",
      bodyPreview: "",
      modifiedAt: T0,
      syncedAt: T0,
      metadata: githubActionsRunMetadata(
        repo,
        {
          id,
          name: "Deploy",
          status: "completed",
          conclusion: "success",
          head_sha: over.sha ?? SHA,
        },
        T0,
      ),
    },
    resolver,
  );
  return `github_actions:${repo}#run-${String(id)}`;
}

/** A chat message (mirrors the item shape `connectors/slack-sync.ts` writes). Returns the item id. */
export function writeSlackMessage(
  db: Database,
  over: {
    readonly ts: string;
    readonly text: string;
    readonly atMs: number;
    readonly channel?: string;
  },
): string {
  const ch = over.channel ?? "C1";
  fixtureCtx(db, "slack").upsertItem({
    service: "slack",
    type: "message",
    externalId: `${ch}:${over.ts}`,
    title: over.text.slice(0, 512),
    body: over.text,
    url: `https://acme.slack.com/archives/${ch}/p${over.ts.replace(".", "")}`,
    canonicalUrl: null,
    modifiedAt: over.atMs,
    authorId: null,
    metadata: { channel: ch, user: "U1", thread_ts: null },
    pinned: false,
    syncedAt: over.atMs,
  });
  return `slack:${ch}:${over.ts}`;
}

export function markSynced(db: Database, connectorId: string, atMs: number): void {
  db.run(
    "INSERT INTO sync_state (connector_id, last_sync_at) VALUES (?, ?) ON CONFLICT(connector_id) DO UPDATE SET last_sync_at = excluded.last_sync_at",
    [connectorId, atMs],
  );
}

/** A PagerDuty on-call entry written through the real shift mapper. */
export function writePagerdutyShift(
  db: Database,
  over: {
    readonly userId?: string;
    readonly userName?: string;
    readonly email?: string;
    readonly policyId?: string;
    readonly serviceIds?: readonly string[];
    readonly isMe?: boolean;
    readonly startMs: number;
    readonly endMs: number;
    readonly fetchedAtMs: number;
    readonly scheduleName?: string;
    readonly mapComplete?: boolean;
  },
): void {
  const policyId = over.policyId ?? "POL1";
  const ids = new Map<string, string[]>([[policyId, [...(over.serviceIds ?? ["PSVC1"])]]]);
  const names = new Map<string, string[]>([[policyId, [...(over.serviceIds ?? ["PSVC1"])]]]);
  const userId = over.userId ?? "U1";
  const shift = pdEntryToShift(
    {
      user: {
        id: userId,
        name: over.userName ?? "Alex Rivera",
        email: over.email ?? "alex@acme.test",
      },
      escalation_policy: { id: policyId, name: "Payments policy" },
      schedule: { id: "SCH1", name: over.scheduleName ?? "Payments primary" },
      escalation_level: 1,
      start: new Date(over.startMs).toISOString(),
      end: new Date(over.endMs).toISOString(),
    },
    over.isMe === true ? { id: userId, email: null } : { id: "SOMEONE-ELSE", email: null },
    { ids, names, complete: over.mapComplete ?? true },
  );
  if (shift === null) throw new Error("shift fixture rejected");
  upsertOncallShift(fixtureCtx(db, "pagerduty"), shift, over.fetchedAtMs);
}
