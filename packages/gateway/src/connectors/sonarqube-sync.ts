import { upsertIndexedItemForSync } from "../index/item-store.ts";
import {
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { connectorFetch } from "./_lib/fetch-outcome.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { mapSonarIssueToItem, stripTrailingSlashes } from "./sonarqube-issue-mapping.ts";
import { asRecord, stringField } from "./unknown-record.ts";

const SERVICE_ID = "sonarqube";
const CURSOR_PREFIX = "nimbus-sonarqube1:";
const DEFAULT_API = "https://sonarcloud.io";
const PAGE_SIZE = 100;
const MAX_PAGES_PER_PROJECT = 20;
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

function sonarGet(ctx: SyncContext, token: string, base: string, path: string) {
  return connectorFetch(ctx, SERVICE_ID, `${base}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
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
  const token = (await ctx.getSecret("token"))?.trim() ?? "";
  if (token === "") {
    return null;
  }
  const urlRaw = await ctx.getSecret("url");
  const base = stripTrailingSlashes(urlRaw?.trim() ?? "") || DEFAULT_API;
  const organization = ((await ctx.getSecret("organization")) ?? "").trim();
  return { token, base, organization };
}

interface ProjectSyncOutcome {
  readonly upserted: number;
  readonly bytes: number;
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}

async function syncProjects(
  ctx: SyncContext,
  creds: SonarCreds,
  projectKeys: string[],
  now: number,
): Promise<ProjectSyncOutcome> {
  let upserted = 0;
  let bytes = 0;
  for (let page = 1; page <= MAX_PAGES_PER_PROJECT; page += 1) {
    const issuesParams = new URLSearchParams({
      componentKeys: projectKeys.join(","),
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
      const allProjectKeys = extractProjectKeys(projectsOutcome.parsed);
      const batches = chunkArray(allProjectKeys, 50);

      for (const batch of batches) {
        const projectOutcome = await syncProjects(ctx, creds, batch, now);
        totalUpserted += projectOutcome.upserted;
        totalBytes += projectOutcome.bytes;
      }

      return syncPassCursorSuccess(t0, totalBytes, pass1Cursor(), totalUpserted);
    },
  };
}
