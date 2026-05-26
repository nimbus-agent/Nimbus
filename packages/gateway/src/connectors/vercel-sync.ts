import { upsertIndexedItemForSync } from "../index/item-store.ts";
import {
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { readConnectorSecret } from "./connector-vault.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { asRecord, numberField } from "./unknown-record.ts";
import { mapVercelDeploymentToItem } from "./vercel-deployment-mapping.ts";

const SERVICE_ID = "vercel";
const CURSOR_PREFIX = "nimbus-vercel1:";
const BASE = "https://api.vercel.com";
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

type VercelCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies VercelCursorV1);
}

export type VercelSyncableOptions = {
  ensureVercelMcpRunning: () => Promise<void>;
};

interface VercelCreds {
  readonly token: string;
  readonly teamId: string | null;
}

/**
 * `vercel.token` is required; `vercel.team_id` is optional. Vercel's API host
 * is a fixed SaaS host (`api.vercel.com`) — there is no host override key. The
 * connector no-ops unless the token is non-empty after trim.
 */
async function loadCreds(ctx: SyncContext): Promise<VercelCreds | null> {
  const token = (await readConnectorSecret(ctx.vault, "vercel", "token"))?.trim() ?? "";
  if (token === "") {
    return null;
  }
  const teamRaw = (await readConnectorSecret(ctx.vault, "vercel", "team_id"))?.trim() ?? "";
  return { token, teamId: teamRaw === "" ? null : teamRaw };
}

type FetchOutcome =
  | { kind: "ok"; parsed: unknown; bytes: number }
  | { kind: "http_error"; bytes: number }
  | { kind: "parse_error"; bytes: number };

/** Build `/v6/deployments?limit=…` (+ optional `until` + `teamId`). */
function deploymentsPath(creds: VercelCreds, until: number | null): string {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (until !== null) {
    params.set("until", String(until));
  }
  if (creds.teamId !== null) {
    params.set("teamId", creds.teamId);
  }
  return `/v6/deployments?${params.toString()}`;
}

async function vercelGet(
  ctx: SyncContext,
  creds: VercelCreds,
  path: string,
): Promise<FetchOutcome> {
  await ctx.rateLimiter.acquire(SERVICE_ID);
  // Vercel uses a standard `Authorization: Bearer <token>` header.
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${creds.token}`, Accept: "application/json" },
  });
  const text = await res.text();
  if (!res.ok) {
    ctx.logger.warn({ serviceId: SERVICE_ID, status: res.status, path }, "vercel GET failed");
    return { kind: "http_error", bytes: text.length };
  }
  try {
    return { kind: "ok", parsed: JSON.parse(text) as unknown, bytes: text.length };
  } catch {
    return { kind: "parse_error", bytes: text.length };
  }
}

function extractDeployments(parsed: unknown): unknown[] {
  const v = asRecord(parsed)?.["deployments"];
  return Array.isArray(v) ? v : [];
}

/**
 * Read `pagination.next` — an epoch-ms timestamp to pass as the next page's
 * `until`. Returns null when absent / not a finite number (= last page).
 */
function nextUntil(parsed: unknown): number | null {
  const pagination = asRecord(asRecord(parsed)?.["pagination"]);
  if (pagination === undefined) {
    return null;
  }
  return numberField(pagination, "next") ?? null;
}

function upsertDeployments(ctx: SyncContext, deployments: readonly unknown[], now: number): number {
  let upserted = 0;
  for (const d of deployments) {
    const mapped = mapVercelDeploymentToItem(d, { syncedAt: now });
    if (mapped === null) {
      continue;
    }
    upsertIndexedItemForSync(ctx, mapped);
    upserted += 1;
  }
  return upserted;
}

export function createVercelSyncable(options: VercelSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureVercelMcpRunning();
      const creds = await loadCreds(ctx);
      if (creds === null) {
        return syncNoopResult(cursor, t0);
      }

      const now = Date.now();
      let totalBytes = 0;
      let totalUpserted = 0;
      let until: number | null = null;

      // The deployments walk is the gating call: a FIRST-page http/parse error
      // maps to the pass-cursor-empty result. Later-page errors just break,
      // preserving whatever was already collected.
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const outcome = await vercelGet(ctx, creds, deploymentsPath(creds, until));
        totalBytes += outcome.bytes;
        if (outcome.kind !== "ok") {
          if (page === 0) {
            return outcome.kind === "http_error"
              ? syncPassCursorHttpEmpty(t0, totalBytes, cursor, pass1Cursor())
              : syncPassCursorParseEmpty(t0, totalBytes, pass1Cursor());
          }
          break;
        }

        const deployments = extractDeployments(outcome.parsed);
        totalUpserted += upsertDeployments(ctx, deployments, now);

        const next = nextUntil(outcome.parsed);
        if (next === null || deployments.length === 0) {
          break;
        }
        until = next;
      }

      return syncPassCursorSuccess(t0, totalBytes, pass1Cursor(), totalUpserted);
    },
  };
}
