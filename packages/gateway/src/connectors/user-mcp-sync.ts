import type { Syncable } from "../sync/types.ts";
import { syncNoopResult } from "../sync/types.ts";

export function createUserMcpSyncable(
  serviceId: string,
  ensureRunning: () => Promise<void>,
): Syncable {
  return {
    serviceId,
    defaultIntervalMs: 86_400_000,
    initialSyncDepthDays: 0,
    async sync(ctx, cursor) {
      const t0 = performance.now();
      try {
        await ensureRunning();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        ctx.logger.warn({ serviceId, err: msg }, "user_mcp: ensureRunning failed");
      }
      return syncNoopResult(cursor ?? "user_mcp", t0);
    },
  };
}
