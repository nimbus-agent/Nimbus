import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { decodeGitlabCursor, encodeGitlabCursor } from "./_lib/gitlab/cursor.ts";
import {
  normalisedApiBase,
  syncGitlabEventsPages,
  webOriginFromApiBase,
} from "./_lib/gitlab/events.ts";
import { syncGitlabPipelinesForIndexedProjects } from "./_lib/gitlab/pipelines.ts";
import { readConnectorSecret } from "./connector-vault.ts";

const SERVICE_ID = "gitlab";

export type GitlabSyncableOptions = {
  ensureGitlabMcpRunning: () => Promise<void>;
};

export function createGitlabSyncable(options: GitlabSyncableOptions): Syncable {
  const initialSyncDepthDays = 30;
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 60 * 1000,
    initialSyncDepthDays,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureGitlabMcpRunning();
      const pat = await readConnectorSecret(ctx.vault, "gitlab", "pat");
      if (pat === null || pat === "") {
        return syncNoopResult(cursor, t0);
      }

      const apiBase = normalisedApiBase(await readConnectorSecret(ctx.vault, "gitlab", "api_base"));
      const webOrigin = webOriginFromApiBase(apiBase);

      const prev = decodeGitlabCursor(cursor);
      const nowMs = Date.now();
      const initialAfter =
        prev === null
          ? new Date(nowMs - initialSyncDepthDays * 86_400_000).toISOString()
          : prev.after;
      const page = prev === null ? 1 : prev.page;
      const floorAfter = prev === null ? initialAfter : prev.after;
      const pipelinesIn = prev === null ? {} : prev.pipelines;
      const floorMs = nowMs - initialSyncDepthDays * 86_400_000;

      const ev = await syncGitlabEventsPages(ctx, pat, apiBase, webOrigin, floorAfter, page, t0);
      const pipe = await syncGitlabPipelinesForIndexedProjects(
        ctx,
        pat,
        apiBase,
        webOrigin,
        pipelinesIn,
        floorMs,
      );

      const durationMs = Math.round(performance.now() - t0);
      return {
        cursor: encodeGitlabCursor({
          v: 2,
          after: ev.cursorAfter,
          page: ev.cursorPage,
          pipelines: pipe.pipelines,
        }),
        itemsUpserted: ev.itemsUpserted + pipe.upserted,
        itemsDeleted: 0,
        hasMore: ev.hasMore,
        durationMs,
        bytesTransferred: ev.bytesTransferred + pipe.bytes,
      };
    },
  };
}
