import { extensionProcessEnv } from "../extensions/spawn-env.ts";
import { upsertIndexedItemForSync } from "../index/item-store.ts";
import {
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { mapCloudLoggingSinkToItem } from "./cloud-logging-sink-mapping.ts";
import { readConnectorSecret } from "./connector-vault.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";

const SERVICE_ID = "cloud_logging";
const CURSOR_PREFIX = "nimbus-gcplog1:";

// Page cap — `gcloud logging sinks list` returns a single JSON array (not a
// token-paginated stream), so a single forward pass emits up to MAX_SINKS.
const MAX_SINKS = 500;

type CloudLoggingCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies CloudLoggingCursorV1);
}

/**
 * Mints nothing — `gcloud logging` is a native CLI that reads Application
 * Default Credentials from `GOOGLE_APPLICATION_CREDENTIALS`. Shells
 * `gcloud logging sinks list --project <p> --format json` and returns the raw
 * stdout. Returns `{ ok: false }` when gcloud is missing or exits non-zero —
 * the caller degrades gracefully (no throw past the Syncable boundary),
 * mirroring gcp-sync's `!res.ok` posture.
 */
async function gcloudLoggingSinksList(
  credPath: string,
  project: string,
): Promise<{ ok: boolean; text: string }> {
  try {
    const proc = Bun.spawn(
      ["gcloud", "logging", "sinks", "list", "--project", project, "--format", "json"],
      {
        env: extensionProcessEnv({ GOOGLE_APPLICATION_CREDENTIALS: credPath }),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const code = await proc.exited;
    const out = await new Response(proc.stdout).text();
    return { ok: code === 0, text: out };
  } catch {
    return { ok: false, text: "" };
  }
}

/**
 * Injectable gcloud runner — defaults to the shared spawn; tests pass a stub.
 * Mirrors cloudwatch-sync's `RunAwsCli` dependency-injection shape.
 */
export type RunGcloud = (
  credPath: string,
  project: string,
) => Promise<{ ok: boolean; text: string }>;

export type CloudLoggingSyncableOptions = {
  ensureCloudLoggingMcpRunning: () => Promise<void>;
  /** Override the gcloud runner (dependency injection for tests). */
  runGcloud?: RunGcloud;
};

interface CloudLoggingCreds {
  readonly credPath: string;
  readonly project: string;
}

async function loadCreds(ctx: SyncContext): Promise<CloudLoggingCreds | null> {
  const credPath =
    (await readConnectorSecret(ctx.vault, "gcp", "credentials_json_path"))?.trim() ?? "";
  const project = (await readConnectorSecret(ctx.vault, "gcp", "project_id"))?.trim() ?? "";
  if (credPath === "" || project === "") {
    return null;
  }
  return { credPath, project };
}

function parseJsonArray(text: string): unknown[] {
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function createCloudLoggingSyncable(options: CloudLoggingSyncableOptions): Syncable {
  const run = options.runGcloud ?? gcloudLoggingSinksList;
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureCloudLoggingMcpRunning();

      // Cloud Logging (Tier-3, metadata-only) reuses the existing GCP credentials.
      const creds = await loadCreds(ctx);
      if (creds === null) {
        return syncNoopResult(cursor, t0);
      }

      await ctx.rateLimiter.acquire(SERVICE_ID);
      const res = await run(creds.credPath, creds.project);
      const totalBytes = res.text.length;
      if (!res.ok) {
        ctx.logger.warn({ serviceId: SERVICE_ID }, "cloud_logging sync: gcloud sinks list failed");
        // Graceful empty pass — no throw past the Syncable boundary, cursor preserved.
        return syncPassCursorParseEmpty(t0, totalBytes, pass1Cursor());
      }

      const now = Date.now();
      let totalUpserted = 0;
      let seen = 0;
      for (const entry of parseJsonArray(res.text)) {
        if (seen >= MAX_SINKS) {
          break;
        }
        seen += 1;
        const mapped = mapCloudLoggingSinkToItem(entry, { project: creds.project, syncedAt: now });
        if (mapped !== null) {
          upsertIndexedItemForSync(ctx, mapped);
          totalUpserted += 1;
        }
      }

      return syncPassCursorSuccess(t0, totalBytes, pass1Cursor(), totalUpserted);
    },
  };
}
