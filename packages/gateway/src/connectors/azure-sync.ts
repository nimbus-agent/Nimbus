import { extensionProcessEnv } from "../extensions/spawn-env.ts";
import { upsertIndexedItemForSync } from "../index/item-store.ts";
import {
  clampSyncTitle,
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { asRecord, stringField } from "./unknown-record.ts";

const SERVICE_ID = "azure";
const CURSOR_PREFIX = "nimbus-az1:";

type AzCursorV1 = { pass: number };

function encodeCursor(c: AzCursorV1): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, c);
}

function pass1Cursor(): string {
  return encodeCursor({ pass: 1 });
}

async function azureCliJson(
  ctx: SyncContext,
  args: string[],
): Promise<{ ok: boolean; text: string }> {
  const tenant = (await ctx.getSecret("tenant_id"))?.trim() ?? "";
  const clientId = (await ctx.getSecret("client_id"))?.trim() ?? "";
  const secret = (await ctx.getSecret("client_secret"))?.trim() ?? "";
  if (tenant === "" || clientId === "" || secret === "") {
    return { ok: false, text: "" };
  }
  const proc = Bun.spawn(["az", ...args, "-o", "json"], {
    env: extensionProcessEnv({
      AZURE_TENANT_ID: tenant,
      AZURE_CLIENT_ID: clientId,
      AZURE_CLIENT_SECRET: secret,
    }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  const out = await new Response(proc.stdout).text();
  return { ok: code === 0, text: out };
}

export type AzureSyncableOptions = {
  ensureAzureMcpRunning: () => Promise<void>;
};

export function createAzureSyncable(options: AzureSyncableOptions): Syncable {
  const initialSyncDepthDays = 1;
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 120 * 1000,
    initialSyncDepthDays,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureAzureMcpRunning();
      const tenant = await ctx.getSecret("tenant_id");
      if (tenant === null || tenant.trim() === "") {
        return syncNoopResult(cursor, t0);
      }

      await ctx.rateLimiter.acquire("azure");
      const res = await azureCliJson(ctx, ["account", "show"]);
      if (!res.ok) {
        ctx.logger.warn({ serviceId: SERVICE_ID }, "azure sync: account show failed");
        return syncPassCursorHttpEmpty(t0, res.text.length, cursor, pass1Cursor());
      }
      let root: unknown;
      try {
        root = JSON.parse(res.text) as unknown;
      } catch {
        return syncPassCursorParseEmpty(t0, res.text.length, pass1Cursor());
      }
      const rec = asRecord(root);
      const subId = stringField(rec ?? {}, "id");
      const name = stringField(rec ?? {}, "name");
      const id = subId ?? "default";
      const now = Date.now();
      const titleRaw = name ?? id;
      upsertIndexedItemForSync(ctx, {
        service: SERVICE_ID,
        type: "subscription",
        externalId: id,
        title: clampSyncTitle(titleRaw),
        bodyPreview: subId ?? "",
        url: null,
        canonicalUrl: null,
        modifiedAt: now,
        authorId: null,
        metadata: { subscriptionId: subId ?? null },
        pinned: false,
        syncedAt: now,
      });

      return syncPassCursorSuccess(t0, res.text.length, pass1Cursor(), 1);
    },
  };
}
