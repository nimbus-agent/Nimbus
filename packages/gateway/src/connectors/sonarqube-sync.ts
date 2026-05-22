/**
 * SonarQube + SonarCloud REST sync handler. Walks
 * `/api/components/search?qualifiers=TRK` → `/api/issues/search` (paged)
 * and upserts each open issue into the unified `item` table as
 * `service = "sonarqube", type = "code_issue"` via
 * {@link mapSonarIssueToItem}.
 *
 * Single-pass cursor model (matches `snyk-sync.ts` / `bitrise-sync.ts`):
 * every successful run emits a fresh `nimbus-sonarqube1:{pass: 1}`
 * cursor so the scheduler does not re-queue immediately. SonarQube does
 * not expose a delta endpoint for issues; full-walk-per-cycle is
 * acceptable at the 10-minute default cadence because the issues
 * endpoint paginates and we cap pages per cycle.
 *
 * Self-hosted SonarQube users supply their own `sonarqube.url` vault
 * key; otherwise we default to `https://sonarcloud.io`. SonarCloud
 * additionally requires the `sonarqube.organization` vault key — when
 * missing the connector returns a noop result (consistent with Sentry's
 * `org_slug` handling).
 */

import { upsertIndexedItemForSync } from "../index/item-store.ts";
import {
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { readConnectorSecret } from "./connector-vault.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { mapSonarIssueToItem } from "./sonarqube-issue-mapping.ts";
import { asRecord, stringField } from "./unknown-record.ts";

const SERVICE_ID = "sonarqube";
const CURSOR_PREFIX = "nimbus-sonarqube1:";
const DEFAULT_API = "https://sonarcloud.io";
const PAGE_SIZE = 100;
const MAX_PAGES_PER_PROJECT = 20; // 2000 issues per project per cycle cap.
const ISSUE_TYPES = "BUG,VULNERABILITY,CODE_SMELL";
const OPEN_STATUSES = "OPEN,CONFIRMED,REOPENED";

type SonarCursorV1 = { pass: number };

function encodeCursor(c: SonarCursorV1): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, c);
}

function pass1Cursor(): string {
  return encodeCursor({ pass: 1 });
}

export type SonarqubeSyncableOptions = {
  ensureSonarqubeMcpRunning: () => Promise<void>;
};

type FetchOutcome =
  | { kind: "ok"; parsed: unknown; bytes: number }
  | { kind: "http_error"; bytes: number }
  | { kind: "parse_error"; bytes: number };

async function sonarGet(
  ctx: SyncContext,
  token: string,
  base: string,
  path: string,
): Promise<FetchOutcome> {
  await ctx.rateLimiter.acquire(SERVICE_ID);
  const res = await fetch(`${base}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  const text = await res.text();
  if (!res.ok) {
    ctx.logger.warn({ serviceId: SERVICE_ID, status: res.status, path }, "sonarqube GET failed");
    return { kind: "http_error", bytes: text.length };
  }
  try {
    return { kind: "ok", parsed: JSON.parse(text) as unknown, bytes: text.length };
  } catch {
    return { kind: "parse_error", bytes: text.length };
  }
}

function extractProjectKeys(parsed: unknown): string[] {
  const root = asRecord(parsed) ?? {};
  const components = root["components"];
  if (!Array.isArray(components)) {
    return [];
  }
  const out: string[] = [];
  for (const c of components) {
    const row = asRecord(c);
    if (row === undefined) {
      continue;
    }
    const key = stringField(row, "key");
    if (key !== undefined && key !== "") {
      out.push(key);
    }
  }
  return out;
}

function extractIssues(parsed: unknown): unknown[] {
  const root = asRecord(parsed) ?? {};
  const issues = root["issues"];
  return Array.isArray(issues) ? issues : [];
}

function extractTotal(parsed: unknown): number {
  const root = asRecord(parsed) ?? {};
  const paging = asRecord(root["paging"]) ?? {};
  const total = paging["total"];
  return typeof total === "number" && Number.isFinite(total) ? Math.trunc(total) : 0;
}

interface SonarCreds {
  readonly token: string;
  readonly base: string;
  readonly organization: string;
}

async function loadSonarCreds(ctx: SyncContext): Promise<SonarCreds | null> {
  const token = (await readConnectorSecret(ctx.vault, "sonarqube", "token"))?.trim() ?? "";
  if (token === "") {
    return null;
  }
  const urlRaw = await readConnectorSecret(ctx.vault, "sonarqube", "url");
  const base = (urlRaw?.trim() ?? "").replace(/\/+$/, "") || DEFAULT_API;
  const organization = (
    (await readConnectorSecret(ctx.vault, "sonarqube", "organization")) ?? ""
  ).trim();
  return { token, base, organization };
}

interface ProjectSyncOutcome {
  readonly upserted: number;
  readonly bytes: number;
}

async function syncOneProject(
  ctx: SyncContext,
  creds: SonarCreds,
  projectKey: string,
  now: number,
): Promise<ProjectSyncOutcome> {
  let upserted = 0;
  let bytes = 0;
  for (let page = 1; page <= MAX_PAGES_PER_PROJECT; page += 1) {
    const issuesParams = new URLSearchParams({
      componentKeys: projectKey,
      types: ISSUE_TYPES,
      statuses: OPEN_STATUSES,
      ps: String(PAGE_SIZE),
      p: String(page),
    });
    const outcome = await sonarGet(
      ctx,
      creds.token,
      creds.base,
      `/api/issues/search?${issuesParams.toString()}`,
    );
    bytes += outcome.bytes;
    if (outcome.kind !== "ok") {
      break;
    }
    const issues = extractIssues(outcome.parsed);
    upserted += upsertSonarIssues(ctx, creds, issues, now);
    const total = extractTotal(outcome.parsed);
    if (issues.length < PAGE_SIZE || page * PAGE_SIZE >= total) {
      break;
    }
  }
  return { upserted, bytes };
}

function upsertSonarIssues(
  ctx: SyncContext,
  creds: SonarCreds,
  issues: readonly unknown[],
  now: number,
): number {
  let upserted = 0;
  for (const issue of issues) {
    const mapped = mapSonarIssueToItem(issue, {
      baseUrl: creds.base,
      organization: creds.organization,
      syncedAt: now,
    });
    if (mapped === null) {
      continue;
    }
    upsertIndexedItemForSync(ctx, mapped);
    upserted += 1;
  }
  return upserted;
}

function buildComponentsPath(organization: string): string {
  // The components endpoint accepts `organization` optionally; SonarCloud
  // effectively requires it (returns empty otherwise), self-hosted ignores it.
  const params = new URLSearchParams({ qualifiers: "TRK", ps: String(PAGE_SIZE) });
  if (organization !== "") {
    params.set("organization", organization);
  }
  return `/api/components/search?${params.toString()}`;
}

export function createSonarqubeSyncable(options: SonarqubeSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureSonarqubeMcpRunning();
      const creds = await loadSonarCreds(ctx);
      if (creds === null) {
        return syncNoopResult(cursor, t0);
      }

      const projectsOutcome = await sonarGet(
        ctx,
        creds.token,
        creds.base,
        buildComponentsPath(creds.organization),
      );
      if (projectsOutcome.kind === "http_error") {
        return syncPassCursorHttpEmpty(t0, projectsOutcome.bytes, cursor, pass1Cursor());
      }
      if (projectsOutcome.kind === "parse_error") {
        return syncPassCursorParseEmpty(t0, projectsOutcome.bytes, pass1Cursor());
      }

      const now = Date.now();
      let totalUpserted = 0;
      let totalBytes = projectsOutcome.bytes;
      for (const projectKey of extractProjectKeys(projectsOutcome.parsed)) {
        const projectOutcome = await syncOneProject(ctx, creds, projectKey, now);
        totalUpserted += projectOutcome.upserted;
        totalBytes += projectOutcome.bytes;
      }

      return syncPassCursorSuccess(t0, totalBytes, pass1Cursor(), totalUpserted);
    },
  };
}
