import { upsertIndexedItemForSync } from "../index/item-store.ts";
import {
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { connectorFetch } from "./_lib/fetch-outcome.ts";
import { mapFlagsmithFeatureToItem } from "./flagsmith-feature-mapping.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { asRecord, numberField, stringField } from "./unknown-record.ts";

const SERVICE_ID = "flagsmith";
const CURSOR_PREFIX = "nimbus-flagsmith1:";
const DEFAULT_API_BASE = "https://api.flagsmith.com";
const PAGE_SIZE = 100;
const MAX_PAGES_PER_PROJECT = 20;

type FlagsmithCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies FlagsmithCursorV1);
}

export type FlagsmithSyncableOptions = {
  ensureFlagsmithMcpRunning: () => Promise<void>;
};

interface FlagsmithCreds {
  readonly token: string;
  readonly apiBase: string;
}

async function loadCreds(ctx: SyncContext): Promise<FlagsmithCreds | null> {
  const token = (await ctx.getSecret("token"))?.trim() ?? "";
  if (token === "") {
    return null;
  }
  const baseRaw = (await ctx.getSecret("api_base"))?.trim() ?? "";
  return {
    token,
    apiBase: baseRaw === "" ? DEFAULT_API_BASE : baseRaw,
  };
}

function fsGet(ctx: SyncContext, creds: FlagsmithCreds, path: string) {
  return connectorFetch(ctx, SERVICE_ID, `${creds.apiBase}/api/v1${path}`, {
    headers: { Authorization: `Token ${creds.token}`, Accept: "application/json" },
  });
}

function extractArray(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) {
    return parsed;
  }
  const root = asRecord(parsed) ?? {};
  const results = root["results"];
  if (Array.isArray(results)) {
    return results;
  }
  const items = root["items"];
  return Array.isArray(items) ? items : [];
}

interface FlagsmithProject {
  readonly id: number;
  readonly name: string;
}

function extractProjects(parsed: unknown): FlagsmithProject[] {
  const out: FlagsmithProject[] = [];
  for (const p of extractArray(parsed)) {
    const row = asRecord(p);
    if (row === undefined) {
      continue;
    }
    const id = numberField(row, "id");
    if (id === undefined) {
      continue;
    }
    out.push({ id, name: stringField(row, "name") ?? "" });
  }
  return out;
}

function extractTagMap(parsed: unknown): Record<number, string> {
  const map: Record<number, string> = {};
  for (const t of extractArray(parsed)) {
    const row = asRecord(t);
    if (row === undefined) {
      continue;
    }
    const id = numberField(row, "id");
    const label = stringField(row, "label");
    if (id !== undefined && label !== undefined && label !== "") {
      map[id] = label;
    }
  }
  return map;
}

function featuresPath(projectId: number, page: number): string {
  const params = new URLSearchParams({
    page_size: String(PAGE_SIZE),
    page: String(page),
  });
  return `/projects/${encodeURIComponent(String(projectId))}/features/?${params.toString()}`;
}

function tagsPath(projectId: number): string {
  return `/projects/${encodeURIComponent(String(projectId))}/tags/`;
}

function extractFeaturesPage(parsed: unknown): { features: unknown[]; hasNext: boolean } {
  const root = asRecord(parsed) ?? {};
  const results = root["results"];
  const features = Array.isArray(results) ? results : [];
  const hasNext = root["next"] !== null && root["next"] !== undefined;
  return { features, hasNext };
}

function upsertFeatures(
  ctx: SyncContext,
  creds: FlagsmithCreds,
  project: FlagsmithProject,
  tagMap: Record<number, string>,
  features: readonly unknown[],
  now: number,
): number {
  let upserted = 0;
  for (const f of features) {
    const mapped = mapFlagsmithFeatureToItem(f, {
      apiBase: creds.apiBase,
      projectId: project.id,
      projectName: project.name,
      tagMap,
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

type ProjectsOutcome =
  | { readonly projects: FlagsmithProject[]; readonly bytes: number }
  | { readonly error: "http_error" | "parse_error"; readonly bytes: number };

async function resolveProjects(ctx: SyncContext, creds: FlagsmithCreds): Promise<ProjectsOutcome> {
  const outcome = await fsGet(ctx, creds, "/projects/");
  if (outcome.kind === "ok") {
    return { projects: extractProjects(outcome.parsed), bytes: outcome.bytes };
  }
  return { error: outcome.kind, bytes: outcome.bytes };
}

async function syncProjectFeatures(
  ctx: SyncContext,
  creds: FlagsmithCreds,
  project: FlagsmithProject,
  now: number,
): Promise<{ upserted: number; bytes: number }> {
  let upserted = 0;
  let bytes = 0;

  const tagsOutcome = await fsGet(ctx, creds, tagsPath(project.id));
  bytes += tagsOutcome.bytes;
  const tagMap = tagsOutcome.kind === "ok" ? extractTagMap(tagsOutcome.parsed) : {};

  for (let page = 1; page <= MAX_PAGES_PER_PROJECT; page += 1) {
    const outcome = await fsGet(ctx, creds, featuresPath(project.id, page));
    bytes += outcome.bytes;
    if (outcome.kind !== "ok") {
      break;
    }
    const { features, hasNext } = extractFeaturesPage(outcome.parsed);
    upserted += upsertFeatures(ctx, creds, project, tagMap, features, now);
    if (!hasNext || features.length < PAGE_SIZE) {
      break;
    }
  }
  return { upserted, bytes };
}

export function createFlagsmithSyncable(options: FlagsmithSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureFlagsmithMcpRunning();
      const creds = await loadCreds(ctx);
      if (creds === null) {
        return syncNoopResult(cursor, t0);
      }

      const resolved = await resolveProjects(ctx, creds);
      let totalBytes = resolved.bytes;
      if ("error" in resolved) {
        return resolved.error === "http_error"
          ? syncPassCursorHttpEmpty(t0, totalBytes, cursor, pass1Cursor())
          : syncPassCursorParseEmpty(t0, totalBytes, pass1Cursor());
      }

      const now = Date.now();
      let totalUpserted = 0;
      for (const project of resolved.projects) {
        const result = await syncProjectFeatures(ctx, creds, project, now);
        totalUpserted += result.upserted;
        totalBytes += result.bytes;
      }

      return syncPassCursorSuccess(t0, totalBytes, pass1Cursor(), totalUpserted);
    },
  };
}
