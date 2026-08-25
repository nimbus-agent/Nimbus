import {
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { connectorFetch } from "./_lib/fetch-outcome.ts";
import { mapLaunchDarklyFlagToItem } from "./launchdarkly-flag-mapping.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { asRecord, stringField } from "./unknown-record.ts";

const SERVICE_ID = "launchdarkly";
const CURSOR_PREFIX = "nimbus-launchdarkly1:";
const DEFAULT_BASE = "https://app.launchdarkly.com";
const PAGE_SIZE = 100;
const MAX_PAGES_PER_PROJECT = 20;

type LaunchdarklyCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies LaunchdarklyCursorV1);
}

export type LaunchdarklySyncableOptions = {
  ensureLaunchdarklyMcpRunning: () => Promise<void>;
};

interface LaunchdarklyCreds {
  readonly token: string;
  readonly baseUrl: string;
  readonly projectKey: string | null;
}

async function loadCreds(ctx: SyncContext): Promise<LaunchdarklyCreds | null> {
  const token = (await ctx.getSecret("token"))?.trim() ?? "";
  if (token === "") {
    return null;
  }
  const baseRaw = (await ctx.getSecret("base_url"))?.trim() ?? "";
  const projectRaw = (await ctx.getSecret("project_key"))?.trim() ?? "";
  return {
    token,
    baseUrl: baseRaw === "" ? DEFAULT_BASE : baseRaw,
    projectKey: projectRaw === "" ? null : projectRaw,
  };
}

function ldGet(ctx: SyncContext, creds: LaunchdarklyCreds, path: string) {
  return connectorFetch(ctx, SERVICE_ID, `${creds.baseUrl}/api/v2${path}`, {
    headers: { Authorization: creds.token, Accept: "application/json" },
  });
}

function extractItems(parsed: unknown): unknown[] {
  const root = asRecord(parsed) ?? {};
  const items = root["items"];
  return Array.isArray(items) ? items : [];
}

function extractProjectKeys(parsed: unknown): string[] {
  const out: string[] = [];
  for (const p of extractItems(parsed)) {
    const row = asRecord(p);
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

function flagsPath(projectKey: string, offset: number): string {
  const params = new URLSearchParams({
    summary: "true",
    limit: String(PAGE_SIZE),
    offset: String(offset),
  });
  return `/flags/${encodeURIComponent(projectKey)}?${params.toString()}`;
}

function upsertFlags(
  ctx: SyncContext,
  creds: LaunchdarklyCreds,
  projectKey: string,
  flags: readonly unknown[],
  now: number,
): number {
  let upserted = 0;
  for (const f of flags) {
    const mapped = mapLaunchDarklyFlagToItem(f, {
      baseUrl: creds.baseUrl,
      projectKey,
      syncedAt: now,
    });
    if (mapped === null) {
      continue;
    }
    ctx.upsertItem(mapped);
    upserted += 1;
  }
  return upserted;
}

type ProjectKeysOutcome =
  | { readonly keys: string[]; readonly bytes: number }
  | { readonly error: "http_error" | "parse_error"; readonly bytes: number };

async function resolveProjectKeys(
  ctx: SyncContext,
  creds: LaunchdarklyCreds,
): Promise<ProjectKeysOutcome> {
  if (creds.projectKey === null) {
    const outcome = await ldGet(ctx, creds, "/projects");
    if (outcome.kind === "ok") {
      return { keys: extractProjectKeys(outcome.parsed), bytes: outcome.bytes };
    }
    return { error: outcome.kind, bytes: outcome.bytes };
  }
  return { keys: [creds.projectKey], bytes: 0 };
}

async function syncProjectFlags(
  ctx: SyncContext,
  creds: LaunchdarklyCreds,
  projectKey: string,
  now: number,
): Promise<{ upserted: number; bytes: number }> {
  let upserted = 0;
  let bytes = 0;
  for (let page = 0; page < MAX_PAGES_PER_PROJECT; page += 1) {
    const outcome = await ldGet(ctx, creds, flagsPath(projectKey, page * PAGE_SIZE));
    bytes += outcome.bytes;
    if (outcome.kind !== "ok") {
      break;
    }
    const flags = extractItems(outcome.parsed);
    upserted += upsertFlags(ctx, creds, projectKey, flags, now);
    if (flags.length < PAGE_SIZE) {
      break;
    }
  }
  return { upserted, bytes };
}

export function createLaunchdarklySyncable(options: LaunchdarklySyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureLaunchdarklyMcpRunning();
      const creds = await loadCreds(ctx);
      if (creds === null) {
        return syncNoopResult(cursor, t0);
      }

      const resolved = await resolveProjectKeys(ctx, creds);
      let totalBytes = resolved.bytes;
      if ("error" in resolved) {
        return resolved.error === "http_error"
          ? syncPassCursorHttpEmpty(t0, totalBytes, cursor, pass1Cursor())
          : syncPassCursorParseEmpty(t0, totalBytes, pass1Cursor());
      }

      const now = Date.now();
      let totalUpserted = 0;
      for (const projectKey of resolved.keys) {
        const result = await syncProjectFlags(ctx, creds, projectKey, now);
        totalUpserted += result.upserted;
        totalBytes += result.bytes;
      }

      return syncPassCursorSuccess(t0, totalBytes, pass1Cursor(), totalUpserted);
    },
  };
}
