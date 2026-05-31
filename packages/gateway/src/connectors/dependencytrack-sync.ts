import { upsertIndexedItemForSync } from "../index/item-store.ts";
import {
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { connectorFetch } from "./_lib/fetch-outcome.ts";
import { readConnectorSecret } from "./connector-vault.ts";
import { mapDependencyTrackProjectToItem } from "./dependencytrack-project-mapping.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";

const SERVICE_ID = "dependencytrack";
const CURSOR_PREFIX = "nimbus-dependencytrack1:";
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

type DependencyTrackCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies DependencyTrackCursorV1);
}

export type DependencyTrackSyncableOptions = {
  ensureDependencytrackMcpRunning: () => Promise<void>;
};

interface DependencyTrackCreds {
  readonly baseUrl: string;
  readonly apiKey: string;
}

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

async function loadCreds(ctx: SyncContext): Promise<DependencyTrackCreds | null> {
  const baseUrl =
    (await readConnectorSecret(ctx.vault, "dependencytrack", "base_url"))?.trim() ?? "";
  const apiKey = (await readConnectorSecret(ctx.vault, "dependencytrack", "api_key"))?.trim() ?? "";
  if (baseUrl === "" || apiKey === "") {
    return null;
  }
  return { baseUrl: trimTrailingSlash(baseUrl), apiKey };
}

function projectsPath(pageNumber: number): string {
  const params = new URLSearchParams({
    pageSize: String(PAGE_SIZE),
    pageNumber: String(pageNumber),
    excludeInactive: "false",
  });
  return `/api/v1/project?${params.toString()}`;
}

function dtGet(ctx: SyncContext, creds: DependencyTrackCreds, path: string) {
  return connectorFetch(ctx, SERVICE_ID, `${creds.baseUrl}${path}`, {
    headers: { "X-Api-Key": creds.apiKey, Accept: "application/json" },
  });
}

function extractProjects(parsed: unknown): unknown[] {
  return Array.isArray(parsed) ? parsed : [];
}

function upsertProjects(
  ctx: SyncContext,
  creds: DependencyTrackCreds,
  projects: readonly unknown[],
  now: number,
): number {
  let upserted = 0;
  for (const p of projects) {
    const mapped = mapDependencyTrackProjectToItem(p, { baseUrl: creds.baseUrl, syncedAt: now });
    if (mapped === null) {
      continue;
    }
    upsertIndexedItemForSync(ctx, mapped);
    upserted += 1;
  }
  return upserted;
}

export function createDependencytrackSyncable(options: DependencyTrackSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureDependencytrackMcpRunning();
      const creds = await loadCreds(ctx);
      if (creds === null) {
        return syncNoopResult(cursor, t0);
      }

      const now = Date.now();
      let totalBytes = 0;
      let totalUpserted = 0;

      // Dependency-Track paginates by pageNumber (1-based); walk a single
      // forward pass per cycle, stopping on a short/empty page or the page cap.
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const outcome = await dtGet(ctx, creds, projectsPath(page));
        totalBytes += outcome.bytes;
        if (outcome.kind !== "ok") {
          if (page === 1) {
            return outcome.kind === "http_error"
              ? syncPassCursorHttpEmpty(t0, totalBytes, cursor, pass1Cursor())
              : syncPassCursorParseEmpty(t0, totalBytes, pass1Cursor());
          }
          break;
        }

        const projects = extractProjects(outcome.parsed);
        totalUpserted += upsertProjects(ctx, creds, projects, now);

        if (projects.length < PAGE_SIZE) {
          break;
        }
      }

      return syncPassCursorSuccess(t0, totalBytes, pass1Cursor(), totalUpserted);
    },
  };
}
