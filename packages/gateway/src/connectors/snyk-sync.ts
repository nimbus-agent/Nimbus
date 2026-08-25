import {
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { connectorFetch } from "./_lib/fetch-outcome.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { mapSnykAggregatedIssueToItem } from "./snyk-issue-mapping.ts";
import { asRecord, stringField } from "./unknown-record.ts";

const SERVICE_ID = "snyk";
const CURSOR_PREFIX = "nimbus-snyk1:";
const SNYK_API = "https://api.snyk.io";
const DEFAULT_AGG_ISSUES_BODY = {
  filters: {
    severities: ["critical", "high", "medium", "low"],
    types: ["vuln", "license"],
    ignored: false,
    patched: false,
  },
};

type SnykCursorV1 = { pass: number };

function encodeCursor(c: SnykCursorV1): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, c);
}

function pass1Cursor(): string {
  return encodeCursor({ pass: 1 });
}

export type SnykSyncableOptions = {
  ensureSnykMcpRunning: () => Promise<void>;
};

function snykGet(ctx: SyncContext, token: string, path: string) {
  return connectorFetch(ctx, SERVICE_ID, `${SNYK_API}${path}`, {
    headers: { Authorization: `token ${token}`, Accept: "application/json" },
  });
}

function snykPost(ctx: SyncContext, token: string, path: string, body: unknown) {
  return connectorFetch(ctx, SERVICE_ID, `${SNYK_API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function extractOrgIds(parsed: unknown): string[] {
  const root = asRecord(parsed) ?? {};
  const orgs = root["orgs"];
  if (!Array.isArray(orgs)) {
    return [];
  }
  const ids: string[] = [];
  for (const o of orgs) {
    const row = asRecord(o);
    if (row === undefined) {
      continue;
    }
    const id = stringField(row, "id");
    if (id !== undefined && id !== "") {
      ids.push(id);
    }
  }
  return ids;
}

function extractProjectIds(parsed: unknown): string[] {
  const root = asRecord(parsed) ?? {};
  const projects = root["projects"];
  if (!Array.isArray(projects)) {
    return [];
  }
  const ids: string[] = [];
  for (const p of projects) {
    const row = asRecord(p);
    if (row === undefined) {
      continue;
    }
    const id = stringField(row, "id");
    if (id !== undefined && id !== "") {
      ids.push(id);
    }
  }
  return ids;
}

function extractIssues(parsed: unknown): unknown[] {
  const root = asRecord(parsed) ?? {};
  const issues = root["issues"];
  return Array.isArray(issues) ? issues : [];
}

type IngestTally = { upserted: number; bytes: number };

async function ingestProjectIssues(
  ctx: SyncContext,
  token: string,
  orgId: string,
  projectId: string,
  now: number,
): Promise<IngestTally> {
  const issuesOutcome = await snykPost(
    ctx,
    token,
    `/v1/org/${encodeURIComponent(orgId)}/project/${encodeURIComponent(projectId)}/aggregated-issues`,
    DEFAULT_AGG_ISSUES_BODY,
  );
  if (issuesOutcome.kind !== "ok") {
    return { upserted: 0, bytes: issuesOutcome.bytes };
  }
  let upserted = 0;
  for (const issue of extractIssues(issuesOutcome.parsed)) {
    const mapped = mapSnykAggregatedIssueToItem(issue, { orgId, projectId, syncedAt: now });
    if (mapped === null) {
      continue;
    }
    ctx.upsertItem(mapped);
    upserted += 1;
  }
  return { upserted, bytes: issuesOutcome.bytes };
}

async function ingestOrgProjects(
  ctx: SyncContext,
  token: string,
  orgId: string,
  now: number,
): Promise<IngestTally> {
  const projectsOutcome = await snykGet(
    ctx,
    token,
    `/v1/org/${encodeURIComponent(orgId)}/projects`,
  );
  if (projectsOutcome.kind !== "ok") {
    return { upserted: 0, bytes: projectsOutcome.bytes };
  }
  let upserted = 0;
  let bytes = projectsOutcome.bytes;
  for (const projectId of extractProjectIds(projectsOutcome.parsed)) {
    const tally = await ingestProjectIssues(ctx, token, orgId, projectId, now);
    upserted += tally.upserted;
    bytes += tally.bytes;
  }
  return { upserted, bytes };
}

export function createSnykSyncable(options: SnykSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureSnykMcpRunning();
      const token = (await ctx.getSecret("token"))?.trim() ?? "";
      if (token === "") {
        return syncNoopResult(cursor, t0);
      }

      const orgsOutcome = await snykGet(ctx, token, "/v1/orgs");
      if (orgsOutcome.kind === "http_error") {
        return syncPassCursorHttpEmpty(t0, orgsOutcome.bytes, cursor, pass1Cursor());
      }
      if (orgsOutcome.kind === "parse_error") {
        return syncPassCursorParseEmpty(t0, orgsOutcome.bytes, pass1Cursor());
      }

      const now = Date.now();
      let upserted = 0;
      let totalBytes = orgsOutcome.bytes;

      for (const orgId of extractOrgIds(orgsOutcome.parsed)) {
        const tally = await ingestOrgProjects(ctx, token, orgId, now);
        upserted += tally.upserted;
        totalBytes += tally.bytes;
      }

      return syncPassCursorSuccess(t0, totalBytes, pass1Cursor(), upserted);
    },
  };
}
