import {
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { connectorFetch } from "./_lib/fetch-outcome.ts";
import { upsertMapped } from "./_lib/paginated-sync.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { asRecord, stringField } from "./unknown-record.ts";
import { mapUnleashFeatureToItem } from "./unleash-feature-mapping.ts";

const SERVICE_ID = "unleash";
const CURSOR_PREFIX = "nimbus-unleash1:";
/** Projects a pass walks at most, and flags indexed per project (Unleash's list is not paginated). */
export const UNLEASH_MAX_PROJECTS = 100;
export const UNLEASH_MAX_FEATURES_PER_PROJECT = 2000;

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

type UnleashCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies UnleashCursorV1);
}

export type UnleashSyncableOptions = {
  ensureUnleashMcpRunning: () => Promise<void>;
};

interface UnleashCreds {
  readonly root: string;
  readonly token: string;
}

/**
 * The instance root from the stored `unleash.api_url`, by the connector's own rule
 * (`unleashInstanceRoot`): https, or plain http only to a loopback host; no credentials, query or
 * fragment; a sub-path kept and a trailing `/api` dropped. `null` refuses it: the sync then does
 * nothing, so the token never travels in clear text or to a URL the connector would refuse.
 */
export function unleashSyncRoot(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const loopbackHttp = u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname);
  if (u.protocol !== "https:" && !loopbackHttp) return null;
  if (u.username !== "" || u.password !== "") return null;
  if (u.search !== "" || u.hash !== "" || raw.includes("?") || raw.includes("#")) return null;
  const path = u.pathname.replace(/\/+$/, "").replace(/\/api$/, "");
  return `${u.origin}${path}`;
}

async function loadCreds(ctx: SyncContext): Promise<UnleashCreds | null> {
  const url = (await ctx.getSecret("api_url"))?.trim() ?? "";
  const token = (await ctx.getSecret("token"))?.trim() ?? "";
  if (url === "" || token === "") return null;
  const root = unleashSyncRoot(url);
  if (root === null) {
    ctx.logger.warn({ serviceId: SERVICE_ID }, "unleash.api_url is not an https URL; sync skipped");
    return null;
  }
  return { root, token };
}

function unGet(ctx: SyncContext, creds: UnleashCreds, path: string) {
  // The bare token with no scheme, as the connector and Unleash's Admin API examples send it.
  return connectorFetch(ctx, SERVICE_ID, `${creds.root}/api/admin${path}`, {
    headers: { Authorization: creds.token, Accept: "application/json" },
  });
}

interface UnleashProject {
  readonly id: string;
  readonly name: string;
}

function extractProjects(parsed: unknown): UnleashProject[] {
  const list = asRecord(parsed)?.["projects"];
  const out: UnleashProject[] = [];
  for (const p of Array.isArray(list) ? list : []) {
    const row = asRecord(p);
    const id = row === undefined ? undefined : stringField(row, "id");
    if (row === undefined || id === undefined || id === "") continue;
    out.push({ id, name: stringField(row, "name") ?? id });
    if (out.length === UNLEASH_MAX_PROJECTS) break;
  }
  return out;
}

function extractFeatures(parsed: unknown): unknown[] {
  const list = asRecord(parsed)?.["features"];
  return Array.isArray(list) ? list.slice(0, UNLEASH_MAX_FEATURES_PER_PROJECT) : [];
}

export function createUnleashSyncable(options: UnleashSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureUnleashMcpRunning();
      const creds = await loadCreds(ctx);
      if (creds === null) return syncNoopResult(cursor, t0);

      const projects = await unGet(ctx, creds, "/projects");
      let totalBytes = projects.bytes;
      if (projects.kind !== "ok") {
        return projects.kind === "http_error"
          ? syncPassCursorHttpEmpty(t0, totalBytes, cursor, pass1Cursor())
          : syncPassCursorParseEmpty(t0, totalBytes, pass1Cursor());
      }

      const now = Date.now();
      let totalUpserted = 0;
      for (const project of extractProjects(projects.parsed)) {
        const path = `/projects/${encodeURIComponent(project.id)}/features`;
        const outcome = await unGet(ctx, creds, path); // NOSONAR S9382: one project at a time through the shared Unleash rate limiter; the project list is capped at UNLEASH_MAX_PROJECTS
        totalBytes += outcome.bytes;
        if (outcome.kind !== "ok") continue;
        totalUpserted += upsertMapped(ctx, extractFeatures(outcome.parsed), (f) =>
          mapUnleashFeatureToItem(f, {
            root: creds.root,
            projectId: project.id,
            projectName: project.name,
            syncedAt: now,
          }),
        );
      }
      return syncPassCursorSuccess(t0, totalBytes, pass1Cursor(), totalUpserted);
    },
  };
}
