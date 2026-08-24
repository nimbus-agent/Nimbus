import type { Syncable, SyncContext } from "../sync/types.ts";
import { connectorFetch } from "./_lib/fetch-outcome.ts";
import { runSinglePassPaginatedSync } from "./_lib/paginated-sync.ts";
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

async function loadCreds(ctx: SyncContext): Promise<VercelCreds | null> {
  const token = (await ctx.getSecret("token"))?.trim() ?? "";
  if (token === "") {
    return null;
  }
  const teamRaw = (await ctx.getSecret("team_id"))?.trim() ?? "";
  return { token, teamId: teamRaw === "" ? null : teamRaw };
}

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

function vercelGet(ctx: SyncContext, creds: VercelCreds, path: string) {
  return connectorFetch(ctx, SERVICE_ID, `${BASE}${path}`, {
    headers: { Authorization: `Bearer ${creds.token}`, Accept: "application/json" },
  });
}

function parseVercelPage(parsed: unknown): {
  items: unknown[];
  hasMore: boolean;
  nextPageCursor: string;
} {
  const deployments = (() => {
    const v = asRecord(parsed)?.["deployments"];
    return Array.isArray(v) ? v : [];
  })();
  const pagination = asRecord(asRecord(parsed)?.["pagination"]);
  const next = pagination === undefined ? null : (numberField(pagination, "next") ?? null);
  return {
    items: deployments,
    hasMore: next !== null && deployments.length > 0,
    nextPageCursor: next === null ? "" : String(next),
  };
}

export function createVercelSyncable(options: VercelSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    sync: (ctx, cursor) =>
      runSinglePassPaginatedSync(ctx, cursor, {
        ensureRunning: options.ensureVercelMcpRunning,
        loadCreds: () => loadCreds(ctx),
        pass1Cursor,
        maxPages: MAX_PAGES,
        startPage: 0,
        fetchPage: (creds, _page, pageCursor) =>
          vercelGet(
            ctx,
            creds,
            deploymentsPath(creds, pageCursor === "" ? null : Number(pageCursor)),
          ),
        parsePage: (parsed) => parseVercelPage(parsed),
        map: (raw, _creds, now) => mapVercelDeploymentToItem(raw, { syncedAt: now }),
      }),
  };
}
