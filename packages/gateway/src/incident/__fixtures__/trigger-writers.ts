import type { Database } from "bun:sqlite";

import { mapBigeyeIssueToItem } from "../../connectors/bigeye-dq-mapping.ts";
import {
  EMPTY_NIMBUS_VAULT,
  syncTestContext,
} from "../../connectors/connector-sync-test-helpers.ts";
import { mapJsmAlertToItem } from "../../connectors/jsm-alert-mapping.ts";
import { mapMonteCarloIncidentToItem } from "../../connectors/monte-carlo-dq-mapping.ts";
import { syncPagerdutyIncidentItems } from "../../connectors/pagerduty-sync.ts";
import { mapSentryIssueToItem } from "../../connectors/sentry-issue-mapping.ts";
import type { ServiceIdentityResolver } from "../../metrics/service-identity.ts";

/**
 * Fixture writers for the five incident trigger sources, built from the REAL connector writers and mappers
 * (never hand-built metadata), so a test cannot filter on a key no writer writes.
 */

export type FixtureService = "pagerduty" | "jira" | "sentry" | "montecarlo" | "bigeye" | "slack";

export function fixtureCtx(
  db: Database,
  service: FixtureService,
  resolver?: ServiceIdentityResolver,
): ReturnType<typeof syncTestContext> {
  return syncTestContext(db, EMPTY_NIMBUS_VAULT, service, "full", resolver);
}

const iso = (ms: number): string => new Date(ms).toISOString();

export type PagerdutyFixture = {
  readonly id: string;
  readonly title?: string;
  readonly status?: string;
  readonly openedAtMs: number;
  readonly updatedAtMs?: number;
  readonly resolvedAtMs?: number;
  readonly priority?: string;
  readonly pagerdutyServiceId?: string;
};

/** Item id `pagerduty:<id>`. */
export function writePagerdutyIncident(
  db: Database,
  f: PagerdutyFixture,
  resolver?: ServiceIdentityResolver,
): string {
  const resolved = f.status === "resolved";
  const row: Record<string, unknown> = {
    id: f.id,
    title: f.title ?? `Incident ${f.id}`,
    status: f.status ?? "triggered",
    created_at: iso(f.openedAtMs),
    updated_at: iso(f.updatedAtMs ?? f.resolvedAtMs ?? f.openedAtMs),
    service: { id: f.pagerdutyServiceId ?? "PSVC1" },
  };
  if (f.priority !== undefined) row["priority"] = { name: f.priority };
  if (resolved) row["last_status_change_at"] = iso(f.resolvedAtMs ?? f.openedAtMs);
  syncPagerdutyIncidentItems(
    fixtureCtx(db, "pagerduty", resolver),
    [row],
    "",
    f.updatedAtMs ?? f.openedAtMs,
    new Map(),
  );
  return `pagerduty:${f.id}`;
}

export type JsmFixture = {
  readonly id: string;
  readonly message?: string;
  readonly status?: string;
  readonly priority?: string;
  readonly openedAtMs: number;
  readonly updatedAtMs?: number;
  readonly tags?: readonly string[];
  readonly closeTimeMs?: number;
};

/** Item id `jira:<id>`. */
export function writeJsmAlert(
  db: Database,
  f: JsmFixture,
  resolver?: ServiceIdentityResolver,
): string {
  const row = mapJsmAlertToItem(
    {
      id: f.id,
      message: f.message ?? `Alert ${f.id}`,
      status: f.status ?? "open",
      priority: f.priority,
      createdAt: iso(f.openedAtMs),
      updatedAt: iso(f.updatedAtMs ?? f.openedAtMs),
      tags: f.tags ?? [],
      ...(f.closeTimeMs === undefined ? {} : { report: { closeTime: f.closeTimeMs } }),
    },
    { syncedAt: f.updatedAtMs ?? f.openedAtMs },
  );
  if (row === null) throw new Error("jsm fixture rejected");
  fixtureCtx(db, "jira", resolver).upsertItem(row);
  return `jira:${f.id}`;
}

export type SentryFixture = {
  readonly id: string;
  readonly title?: string;
  readonly status?: string;
  readonly level?: string;
  readonly firstSeenMs: number;
  readonly lastSeenMs?: number;
  readonly project?: string;
};

/** Item id `sentry:<id>`. */
export function writeSentryIssue(
  db: Database,
  f: SentryFixture,
  resolver?: ServiceIdentityResolver,
): string {
  const row = mapSentryIssueToItem(
    {
      id: f.id,
      title: f.title ?? `Issue ${f.id}`,
      status: f.status ?? "unresolved",
      level: f.level,
      firstSeen: iso(f.firstSeenMs),
      lastSeen: iso(f.lastSeenMs ?? f.firstSeenMs),
      project: { slug: f.project ?? "payments-api" },
    },
    { org: "acme", syncedAt: f.lastSeenMs ?? f.firstSeenMs },
  );
  if (row === null) throw new Error("sentry fixture rejected");
  fixtureCtx(db, "sentry", resolver).upsertItem(row);
  return `sentry:${f.id}`;
}

export type MonteCarloFixture = {
  readonly id: string;
  readonly status?: string;
  readonly severity?: string;
  readonly table?: string;
  readonly firstSeenMs: number;
  readonly syncedAtMs?: number;
};

/** Item id `montecarlo:<id>` (the mapper's external id carries its own prefix). */
export function writeMonteCarloIncident(
  db: Database,
  f: MonteCarloFixture,
  resolver?: ServiceIdentityResolver,
): string {
  const row = mapMonteCarloIncidentToItem(
    {
      incidentId: f.id,
      status: f.status ?? "open",
      severity: f.severity,
      monitoredTable: f.table ?? "analytics.payments.orders",
      firstSeenAt: iso(f.firstSeenMs),
    },
    { syncedAt: f.syncedAtMs ?? f.firstSeenMs },
  );
  if (row === null) throw new Error("montecarlo fixture rejected");
  fixtureCtx(db, "montecarlo", resolver).upsertItem(row);
  return `montecarlo:${f.id}`;
}

export type BigeyeFixture = {
  readonly id: string;
  readonly slaStatus?: string;
  readonly table?: string;
  readonly syncedAtMs: number;
};

/** Item id `bigeye:<id>`. */
export function writeBigeyeIssue(
  db: Database,
  f: BigeyeFixture,
  resolver?: ServiceIdentityResolver,
): string {
  const row = mapBigeyeIssueToItem(
    {
      issueId: f.id,
      slaStatus: f.slaStatus,
      anomaly: "a",
      monitoredTable: f.table ?? "analytics.payments.orders",
    },
    { syncedAt: f.syncedAtMs },
  );
  if (row === null) throw new Error("bigeye fixture rejected");
  fixtureCtx(db, "bigeye", resolver).upsertItem(row);
  return `bigeye:${f.id}`;
}
