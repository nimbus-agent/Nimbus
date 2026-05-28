import { upsertIndexedItemForSync } from "../index/item-store.ts";
import {
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { readConnectorSecret } from "./connector-vault.ts";
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

type FetchOutcome =
  | { kind: "ok"; parsed: unknown; bytes: number }
  | { kind: "http_error"; bytes: number }
  | { kind: "parse_error"; bytes: number };

async function snykGet(ctx: SyncContext, token: string, path: string): Promise<FetchOutcome> {
  await ctx.rateLimiter.acquire(SERVICE_ID);
  const res = await fetch(`${SNYK_API}${path}`, {
    headers: { Authorization: `token ${token}`, Accept: "application/json" },
  });
  const text = await res.text();
  if (!res.ok) {
    ctx.logger.warn({ serviceId: SERVICE_ID, status: res.status, path }, "snyk GET failed");
    return { kind: "http_error", bytes: text.length };
  }
  try {
    return { kind: "ok", parsed: JSON.parse(text) as unknown, bytes: text.length };
  } catch {
    return { kind: "parse_error", bytes: text.length };
  }
}

async function snykPost(
  ctx: SyncContext,
  token: string,
  path: string,
  body: unknown,
): Promise<FetchOutcome> {
  await ctx.rateLimiter.acquire(SERVICE_ID);
  const res = await fetch(`${SNYK_API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    ctx.logger.warn({ serviceId: SERVICE_ID, status: res.status, path }, "snyk POST failed");
    return { kind: "http_error", bytes: text.length };
  }
  try {
    return { kind: "ok", parsed: JSON.parse(text) as unknown, bytes: text.length };
  } catch {
    return { kind: "parse_error", bytes: text.length };
  }
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

export function createSnykSyncable(options: SnykSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureSnykMcpRunning();
      const token = (await readConnectorSecret(ctx.vault, "snyk", "token"))?.trim() ?? "";
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

      const orgIds = extractOrgIds(orgsOutcome.parsed);
      const now = Date.now();
      let upserted = 0;
      let totalBytes = orgsOutcome.bytes;

      for (const orgId of orgIds) {
        const projectsOutcome = await snykGet(
          ctx,
          token,
          `/v1/org/${encodeURIComponent(orgId)}/projects`,
        );
        totalBytes += projectsOutcome.bytes;
        if (projectsOutcome.kind !== "ok") {
          continue;
        }
        const projectIds = extractProjectIds(projectsOutcome.parsed);
        for (const projectId of projectIds) {
          const issuesOutcome = await snykPost(
            ctx,
            token,
            `/v1/org/${encodeURIComponent(orgId)}/project/${encodeURIComponent(projectId)}/aggregated-issues`,
            DEFAULT_AGG_ISSUES_BODY,
          );
          totalBytes += issuesOutcome.bytes;
          if (issuesOutcome.kind !== "ok") {
            continue;
          }
          for (const issue of extractIssues(issuesOutcome.parsed)) {
            const mapped = mapSnykAggregatedIssueToItem(issue, {
              orgId,
              projectId,
              syncedAt: now,
            });
            if (mapped === null) {
              continue;
            }
            upsertIndexedItemForSync(ctx, mapped);
            upserted += 1;
          }
        }
      }

      return syncPassCursorSuccess(t0, totalBytes, pass1Cursor(), upserted);
    },
  };
}
