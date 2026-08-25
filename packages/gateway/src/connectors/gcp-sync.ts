import { extensionProcessEnv } from "../extensions/spawn-env.ts";
import {
  clampSyncTitle,
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { asRecord, stringField } from "./unknown-record.ts";

const SERVICE_ID = "gcp";
const CURSOR_PREFIX = "nimbus-gcp1:";

type GcpCursorV1 = { pass: number };

function encodeCursor(c: GcpCursorV1): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, c);
}

function pass1Cursor(): string {
  return encodeCursor({ pass: 1 });
}

async function gcloudJson(
  ctx: SyncContext,
  args: string[],
): Promise<{ ok: boolean; text: string }> {
  const credPath = (await ctx.getSecret("credentials_json_path"))?.trim() ?? "";
  if (credPath === "") {
    return { ok: false, text: "" };
  }
  const proc = Bun.spawn(["gcloud", ...args, "--format", "json"], {
    env: extensionProcessEnv({ GOOGLE_APPLICATION_CREDENTIALS: credPath }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  const out = await new Response(proc.stdout).text();
  return { ok: code === 0, text: out };
}

export type GcpSyncableOptions = {
  ensureGcpMcpRunning: () => Promise<void>;
};

export function createGcpSyncable(options: GcpSyncableOptions): Syncable {
  const initialSyncDepthDays = 1;
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 120 * 1000,
    initialSyncDepthDays,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureGcpMcpRunning();
      const credPath = await ctx.getSecret("credentials_json_path");
      if (credPath === null || credPath.trim() === "") {
        return syncNoopResult(cursor, t0);
      }
      const projectRaw = await ctx.getSecret("project_id");
      const projectId = projectRaw !== null && projectRaw.trim() !== "" ? projectRaw.trim() : null;
      if (projectId === null) {
        return syncNoopResult(cursor, t0);
      }

      await ctx.rateLimiter.acquire("gcp");
      const res = await gcloudJson(ctx, ["projects", "describe", projectId]);
      if (!res.ok) {
        ctx.logger.warn({ serviceId: SERVICE_ID }, "gcp sync: projects describe failed");
        return syncPassCursorHttpEmpty(t0, res.text.length, cursor, pass1Cursor());
      }
      let root: unknown;
      try {
        root = JSON.parse(res.text) as unknown;
      } catch {
        return syncPassCursorParseEmpty(t0, res.text.length, pass1Cursor());
      }
      const rec = asRecord(root);
      const name = stringField(rec ?? {}, "name") ?? projectId;
      const now = Date.now();
      ctx.upsertItem({
        service: SERVICE_ID,
        type: "project",
        externalId: projectId,
        title: clampSyncTitle(name),
        bodyPreview: projectId,
        url: null,
        canonicalUrl: null,
        modifiedAt: now,
        authorId: null,
        metadata: { projectId },
        pinned: false,
        syncedAt: now,
      });

      return syncPassCursorSuccess(t0, res.text.length, pass1Cursor(), 1);
    },
  };
}
