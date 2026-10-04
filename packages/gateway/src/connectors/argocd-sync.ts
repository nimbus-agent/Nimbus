import {
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { connectorFetch } from "./_lib/fetch-outcome.ts";
import { trimTrailingSlash } from "./_lib/field-helpers.ts";
import { upsertMapped } from "./_lib/paginated-sync.ts";
import { mapArgocdApplicationToItem } from "./argocd-application-mapping.ts";
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

async function loadCreds(ctx: SyncContext): Promise<ArgocdCreds | null> {
  const url = (await ctx.getSecret("url"))?.trim() ?? "";
  const token = (await ctx.getSecret("token"))?.trim() ?? "";
  if (url === "" || token === "") {
    return null;
  }
  return { url: trimTrailingSlash(url), token };
}

function extractApplications(parsed: unknown): unknown[] {
  const items = asRecord(parsed)?.["items"];
  return Array.isArray(items) ? items : [];
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

      const outcome = await connectorFetch(ctx, SERVICE_ID, `${creds.url}/api/v1/applications`, {
        headers: { Authorization: `Bearer ${creds.token}`, Accept: "application/json" },
      });
      if (outcome.kind !== "ok") {
        return outcome.kind === "http_error"
          ? syncPassCursorHttpEmpty(t0, outcome.bytes, cursor, pass1Cursor())
          : syncPassCursorParseEmpty(t0, outcome.bytes, pass1Cursor());
      }

      const now = Date.now();
      const upserted = upsertMapped(ctx, extractApplications(outcome.parsed), (raw) =>
        mapArgocdApplicationToItem(raw, { baseUrl: creds.url, syncedAt: now }),
      );

      return syncPassCursorSuccess(t0, outcome.bytes, pass1Cursor(), upserted);
    },
  };
}
