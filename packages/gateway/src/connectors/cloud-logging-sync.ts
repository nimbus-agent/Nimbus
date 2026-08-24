import type { Syncable, SyncContext, SyncResult } from "../sync/types.ts";
import { runSinglePassCliShellSync } from "./_lib/cli-shell-sync.ts";
import { runGcloudCommand } from "./_lib/gcloud-runner.ts";
import { mapCloudLoggingSinkToItem } from "./cloud-logging-sink-mapping.ts";
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
function gcloudLoggingSinksList(
  credPath: string,
  project: string,
): Promise<{ ok: boolean; text: string }> {
  return runGcloudCommand(
    ["gcloud", "logging", "sinks", "list", "--project", project, "--format", "json"],
    credPath,
  );
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
  const credPath = (await ctx.getSharedSecret("gcp", "credentials_json_path"))?.trim() ?? "";
  const project = (await ctx.getSharedSecret("gcp", "project_id"))?.trim() ?? "";
  if (credPath === "" || project === "") {
    return null;
  }
  return { credPath, project };
}

export function createCloudLoggingSyncable(options: CloudLoggingSyncableOptions): Syncable {
  const run = options.runGcloud ?? gcloudLoggingSinksList;
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      return runSinglePassCliShellSync(ctx, cursor, {
        ensureRunning: () => options.ensureCloudLoggingMcpRunning(),
        loadCreds: () => loadCreds(ctx),
        pass1Cursor,
        maxPages: 1,
        runCliPage: async (creds) => {
          await ctx.rateLimiter.acquire(SERVICE_ID);
          const res = await run(creds.credPath, creds.project);
          if (!res.ok) {
            ctx.logger.warn(
              { serviceId: SERVICE_ID },
              "cloud_logging sync: gcloud sinks list failed",
            );
          }
          return { ok: res.ok, text: res.text };
        },
        parsePage: (text) => {
          let items: unknown[] = [];
          try {
            const parsed = JSON.parse(text) as unknown;
            items = Array.isArray(parsed) ? parsed.slice(0, MAX_SINKS) : [];
          } catch {
            // empty
          }
          return { items, hasMore: false };
        },
        map: (raw, creds, now) =>
          mapCloudLoggingSinkToItem(raw, { project: creds.project, syncedAt: now }),
      });
    },
  };
}
