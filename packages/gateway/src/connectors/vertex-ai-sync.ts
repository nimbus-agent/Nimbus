import { extensionProcessEnv } from "../extensions/spawn-env.ts";
import { upsertIndexedItemForSync } from "../index/item-store.ts";
import {
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { readConnectorSecret } from "./connector-vault.ts";
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
 * Inline argv flag-smuggling guard (the gateway package cannot import
 * `mcp-connectors/shared/safe-cli-arg.ts`). A region value beginning with `-`
 * would be parsed by gcloud as a FLAG; reject empty / over-long / `-`-prefixed /
 * control-char values before the value reaches a gcloud argv. Mirrors
 * sagemaker-sync's inline `isSafeCliArg`.
 */
function isSafeCliArg(value: string): boolean {
  if (value.length === 0 || value.length > 1024 || value.startsWith("-")) {
    return false;
  }
  for (let i = 0; i < value.length; i += 1) {
    const cp = value.codePointAt(i);
    if (cp !== undefined && cp < 0x20) {
      return false;
    }
  }
  return true;
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
async function gcloudAiModelsList(
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
  try {
    const proc = Bun.spawn(argv, {
      env: extensionProcessEnv({ GOOGLE_APPLICATION_CREDENTIALS: credPath }),
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    const out = await new Response(proc.stdout).text();
    return { ok: code === 0, text: out };
  } catch {
    return { ok: false, text: "" };
  }
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
  const credPath =
    (await readConnectorSecret(ctx.vault, "gcp", "credentials_json_path"))?.trim() ?? "";
  const project = (await readConnectorSecret(ctx.vault, "gcp", "project_id"))?.trim() ?? "";
  if (credPath === "" || project === "") {
    return null;
  }
  // Region is an OPTIONAL non-secret gcp config key; default + flag-guard it.
  const rawRegion = (await readConnectorSecret(ctx.vault, "gcp", "region"))?.trim() ?? "";
  const region = rawRegion === "" ? DEFAULT_REGION : rawRegion;
  if (!isSafeCliArg(region)) {
    return null;
  }
  return { credPath, project, region };
}

function parseJsonArray(text: string): unknown[] {
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function createVertexAiSyncable(options: VertexAiSyncableOptions): Syncable {
  const run = options.runGcloud ?? gcloudAiModelsList;
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureVertexAiMcpRunning();

      // Vertex AI (Tier-3, metadata-only) reuses the existing GCP credentials.
      const creds = await loadCreds(ctx);
      if (creds === null) {
        return syncNoopResult(cursor, t0);
      }

      await ctx.rateLimiter.acquire(SERVICE_ID);
      const res = await run(creds.credPath, creds.project, creds.region);
      const totalBytes = res.text.length;
      if (!res.ok) {
        ctx.logger.warn({ serviceId: SERVICE_ID }, "vertex_ai sync: gcloud ai models list failed");
        // Graceful empty pass — no throw past the Syncable boundary, cursor preserved.
        return syncPassCursorParseEmpty(t0, totalBytes, pass1Cursor());
      }

      const now = Date.now();
      let totalUpserted = 0;
      let seen = 0;
      for (const entry of parseJsonArray(res.text)) {
        if (seen >= MAX_MODELS) {
          break;
        }
        seen += 1;
        const mapped = mapVertexAiModelToItem(entry, {
          project: creds.project,
          region: creds.region,
          syncedAt: now,
        });
        if (mapped !== null) {
          upsertIndexedItemForSync(ctx, mapped);
          totalUpserted += 1;
        }
      }

      return syncPassCursorSuccess(t0, totalBytes, pass1Cursor(), totalUpserted);
    },
  };
}
