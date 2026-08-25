import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";

const SERVICE_ID = "iac";
const CURSOR_PREFIX = "nimbus-iac1:";

type IacCursorV1 = { tick: number };

function encodeCursor(c: IacCursorV1): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, c);
}

export type IacSyncableOptions = {
  ensureIacMcpRunning: () => Promise<void>;
};

export function createIacSyncable(options: IacSyncableOptions): Syncable {
  const initialSyncDepthDays = 1;
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 120 * 1000,
    initialSyncDepthDays,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureIacMcpRunning();
      const en = await ctx.getSecret("enabled");
      if (en !== "1") {
        return syncNoopResult(cursor, t0);
      }
      await ctx.rateLimiter.acquire("iac");
      const now = Date.now();
      const lambdaCount = ctx.countItems("aws", "lambda_function");
      ctx.upsertItem({
        service: SERVICE_ID,
        type: "sync_heartbeat",
        externalId: "drift_baseline",
        title: "IaC connector index snapshot",
        bodyPreview: `AWS Lambda (indexed): ${String(lambdaCount)}`,
        url: null,
        canonicalUrl: null,
        modifiedAt: now,
        authorId: null,
        metadata: { awsLambdaIndexedCount: lambdaCount, tick: now },
        pinned: false,
        syncedAt: now,
      });
      return {
        cursor: encodeCursor({ tick: now }),
        itemsUpserted: 1,
        itemsDeleted: 0,
        hasMore: false,
        durationMs: Math.round(performance.now() - t0),
        bytesTransferred: 0,
      };
    },
  };
}
