import { upsertIndexedItemForSync } from "../index/item-store.ts";
import {
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { mapArgocdApplicationToItem } from "./argocd-application-mapping.ts";
import { readConnectorSecret } from "./connector-vault.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { asRecord } from "./unknown-record.ts";

const SERVICE_ID = "argocd";
const CURSOR_PREFIX = "nimbus-argocd1:";

type ArgocdCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies ArgocdCursorV1);
}

export type ArgocdSyncableOptions = {
  ensureArgocdMcpRunning: () => Promise<void>;
};

interface ArgocdCreds {
  readonly url: string;
  readonly token: string;
}

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

async function loadCreds(ctx: SyncContext): Promise<ArgocdCreds | null> {
  const url = (await readConnectorSecret(ctx.vault, "argocd", "url"))?.trim() ?? "";
  const token = (await readConnectorSecret(ctx.vault, "argocd", "token"))?.trim() ?? "";
  if (url === "" || token === "") {
    return null;
  }
  return { url: trimTrailingSlash(url), token };
}

type FetchOutcome =
  | { kind: "ok"; parsed: unknown; bytes: number }
  | { kind: "http_error"; bytes: number }
  | { kind: "parse_error"; bytes: number };

async function agGet(ctx: SyncContext, creds: ArgocdCreds, path: string): Promise<FetchOutcome> {
  await ctx.rateLimiter.acquire(SERVICE_ID);
  const res = await fetch(`${creds.url}/api/v1${path}`, {
    headers: { Authorization: `Bearer ${creds.token}`, Accept: "application/json" },
  });
  const text = await res.text();
  if (!res.ok) {
    ctx.logger.warn({ serviceId: SERVICE_ID, status: res.status, path }, "argocd GET failed");
    return { kind: "http_error", bytes: text.length };
  }
  try {
    return { kind: "ok", parsed: JSON.parse(text) as unknown, bytes: text.length };
  } catch {
    return { kind: "parse_error", bytes: text.length };
  }
}

function extractApplications(parsed: unknown): unknown[] {
  const items = asRecord(parsed)?.["items"];
  return Array.isArray(items) ? items : [];
}

function upsertApplications(
  ctx: SyncContext,
  creds: ArgocdCreds,
  apps: readonly unknown[],
  now: number,
): number {
  let upserted = 0;
  for (const a of apps) {
    const mapped = mapArgocdApplicationToItem(a, { baseUrl: creds.url, syncedAt: now });
    if (mapped === null) {
      continue;
    }
    upsertIndexedItemForSync(ctx, mapped);
    upserted += 1;
  }
  return upserted;
}

export function createArgocdSyncable(options: ArgocdSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureArgocdMcpRunning();
      const creds = await loadCreds(ctx);
      if (creds === null) {
        return syncNoopResult(cursor, t0);
      }

      const outcome = await agGet(ctx, creds, "/applications");
      if (outcome.kind !== "ok") {
        return outcome.kind === "http_error"
          ? syncPassCursorHttpEmpty(t0, outcome.bytes, cursor, pass1Cursor())
          : syncPassCursorParseEmpty(t0, outcome.bytes, pass1Cursor());
      }

      const now = Date.now();
      const upserted = upsertApplications(ctx, creds, extractApplications(outcome.parsed), now);

      return syncPassCursorSuccess(t0, outcome.bytes, pass1Cursor(), upserted);
    },
  };
}
