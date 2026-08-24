import type { Syncable, SyncContext, SyncResult } from "../sync/types.ts";
import { isSafeCliArg, runSinglePassCliShellSync } from "./_lib/cli-shell-sync.ts";
import { runGcloudCommand } from "./_lib/gcloud-runner.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { mapVertexAiModelToItem } from "./vertex-ai-model-mapping.ts";

const SERVICE_ID = "vertex_ai";
const CURSOR_PREFIX = "nimbus-vertex1:";

// Vertex AI is regional; this is the default when `gcp.region` is unset.
const DEFAULT_REGION = "us-central1";

// Page cap — `gcloud ai models list` returns a single JSON array (not a
// token-paginated stream), so a single forward pass emits up to MAX_MODELS.
const MAX_MODELS = 500;

type VertexAiCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies VertexAiCursorV1);
}

/**
 * Mints nothing — `gcloud ai` is a native CLI that reads Application Default
 * Credentials from `GOOGLE_APPLICATION_CREDENTIALS`. Shells
 * `gcloud ai models list --region <r> --project <p> --format json` and returns
 * the raw stdout. Returns `{ ok: false }` when gcloud is missing or exits
 * non-zero — the caller degrades gracefully (no throw past the Syncable
 * boundary), mirroring cloud-logging-sync's posture. The `<region>` is guarded
 * by the caller before this runs.
 */
function gcloudAiModelsList(
  credPath: string,
  project: string,
  region: string,
): Promise<{ ok: boolean; text: string }> {
  const argv = [
    "gcloud",
    "ai",
    "models",
    "list",
    "--region",
    region,
    "--project",
    project,
    "--format",
    "json",
  ];
  return runGcloudCommand(argv, credPath);
}

/**
 * Injectable gcloud runner — defaults to the shared spawn; tests pass a stub.
 * Mirrors cloud-logging-sync's `RunGcloud` dependency-injection shape, with the
 * regional Vertex AI surface adding a `region` parameter.
 */
export type RunGcloud = (
  credPath: string,
  project: string,
  region: string,
) => Promise<{ ok: boolean; text: string }>;

export type VertexAiSyncableOptions = {
  ensureVertexAiMcpRunning: () => Promise<void>;
  /** Override the gcloud runner (dependency injection for tests). */
  runGcloud?: RunGcloud;
};

interface VertexAiCreds {
  readonly credPath: string;
  readonly project: string;
  readonly region: string;
}

async function loadCreds(ctx: SyncContext): Promise<VertexAiCreds | null> {
  const credPath = (await ctx.getSharedSecret("gcp", "credentials_json_path"))?.trim() ?? "";
  const project = (await ctx.getSharedSecret("gcp", "project_id"))?.trim() ?? "";
  if (credPath === "" || project === "") {
    return null;
  }
  // Region is an OPTIONAL non-secret gcp config key; default + flag-guard it.
  const rawRegion = (await ctx.getSharedSecret("gcp", "region"))?.trim() ?? "";
  const region = rawRegion === "" ? DEFAULT_REGION : rawRegion;
  if (!isSafeCliArg(region)) {
    return null;
  }
  return { credPath, project, region };
}

export function createVertexAiSyncable(options: VertexAiSyncableOptions): Syncable {
  const run = options.runGcloud ?? gcloudAiModelsList;
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      return runSinglePassCliShellSync(ctx, cursor, {
        ensureRunning: () => options.ensureVertexAiMcpRunning(),
        loadCreds: () => loadCreds(ctx),
        pass1Cursor,
        maxPages: 1,
        runCliPage: async (creds) => {
          await ctx.rateLimiter.acquire(SERVICE_ID);
          const res = await run(creds.credPath, creds.project, creds.region);
          if (!res.ok) {
            ctx.logger.warn(
              { serviceId: SERVICE_ID },
              "vertex_ai sync: gcloud ai models list failed",
            );
          }
          return { ok: res.ok, text: res.text };
        },
        parsePage: (text) => {
          let items: unknown[] = [];
          try {
            const parsed = JSON.parse(text) as unknown;
            items = Array.isArray(parsed) ? parsed.slice(0, MAX_MODELS) : [];
          } catch {
            // empty
          }
          return { items, hasMore: false };
        },
        map: (raw, creds, now) =>
          mapVertexAiModelToItem(raw, {
            project: creds.project,
            region: creds.region,
            syncedAt: now,
          }),
      });
    },
  };
}
