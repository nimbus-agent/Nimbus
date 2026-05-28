import type { Database } from "bun:sqlite";
import { join } from "node:path";
import type { Logger } from "pino";
import { createLocalEmbedder } from "../embedding/model.ts";
import { createOpenAIEmbedder } from "../embedding/openai-embedder.ts";
import { SqliteEmbeddingPipeline } from "../embedding/pipeline.ts";
import type { Embedder, IndexedItem } from "../embedding/types.ts";
import { processEnvGet } from "../platform/env-access.ts";
import type { PlatformPaths } from "../platform/paths.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { dispatchByMethod, type RpcMissOrHit } from "./_lib/dispatch-by-method.ts";

export class IndexReembedRpcError extends Error {
  readonly rpcCode: number;
  constructor(rpcCode: number, message: string) {
    super(message);
    this.name = "IndexReembedRpcError";
    this.rpcCode = rpcCode;
  }
}

export type IndexReembedRpcContext = {
  db: Database;
  vault: NimbusVault;
  paths: Pick<PlatformPaths, "dataDir">;
  logger: Logger;
  notify: (method: string, params: unknown) => void;
};

type ReembedParams = {
  model: string;
  itemType?: string;
  service?: string;
  limit?: number;
  batchSize?: number;
  dryRun?: boolean;
};

const activeReembeds = new Map<string, AbortController>();

const MIN_BATCH = 1;
const MAX_BATCH = 256;
const DEFAULT_BATCH = 100;
const FALLBACK_RETRY_AFTER_MS = 2000;

function clampBatchSize(raw: number | undefined): number {
  const n = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : DEFAULT_BATCH;
  return Math.min(MAX_BATCH, Math.max(MIN_BATCH, n));
}

function newJobId(): string {
  return `reembed_${String(Date.now())}_${crypto.randomUUID().slice(0, 8)}`;
}

function parseReembedParams(params: unknown): ReembedParams {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new IndexReembedRpcError(-32602, "params must be an object");
  }
  const rec = params as Record<string, unknown>;
  const model = rec["model"];
  if (typeof model !== "string" || model === "") {
    throw new IndexReembedRpcError(-32602, "params.model is required");
  }
  const out: ReembedParams = { model };
  if (typeof rec["itemType"] === "string" && rec["itemType"] !== "") {
    out.itemType = rec["itemType"];
  }
  if (typeof rec["service"] === "string" && rec["service"] !== "") {
    out.service = rec["service"];
  }
  const rawLimit = rec["limit"];
  if (typeof rawLimit === "number" && Number.isFinite(rawLimit) && rawLimit > 0) {
    out.limit = Math.floor(rawLimit);
  }
  if (typeof rec["batchSize"] === "number") {
    out.batchSize = rec["batchSize"] as number;
  }
  if (rec["dryRun"] === true) {
    out.dryRun = true;
  }
  return out;
}

async function resolveEmbedder(model: string, ctx: IndexReembedRpcContext): Promise<Embedder> {
  if (model.startsWith("openai:")) {
    const envKey = processEnvGet("OPENAI_API_KEY")?.trim() ?? "";
    let apiKey = envKey;
    if (apiKey === "") {
      const v = await ctx.vault.get("openai.api_key");
      apiKey = typeof v === "string" ? v.trim() : "";
    }
    if (apiKey === "") {
      throw new IndexReembedRpcError(
        -32603,
        "openai.api_key missing in vault. Run `nimbus vault set openai.api_key <key>`.",
      );
    }
    const openaiModel = model.slice("openai:".length);
    return createOpenAIEmbedder({ apiKey, model: openaiModel, dimensions: 1536 });
  }
  if (model === "Xenova/all-MiniLM-L6-v2" || model === "local") {
    return createLocalEmbedder({ cacheDir: join(ctx.paths.dataDir, "models") });
  }
  throw new IndexReembedRpcError(-32602, `Unsupported model: ${model}`);
}

function buildCandidateSql(p: ReembedParams): {
  sql: string;
  params: Array<string | number>;
} {
  const params: Array<string | number> = [p.model];
  let sql = `SELECT i.id AS id, i.service AS service, i.type AS type,
                    i.title AS title, i.body_preview AS body_preview
             FROM item i WHERE NOT EXISTS (
               SELECT 1 FROM embedding_chunk c
               WHERE c.item_id = i.id AND c.model = ?
             )`;
  if (p.service !== undefined) {
    sql += ` AND i.service = ?`;
    params.push(p.service);
  }
  if (p.itemType !== undefined) {
    if (p.itemType.includes(":")) {
      sql += ` AND (i.service || ':' || i.type) = ?`;
      params.push(p.itemType);
    } else {
      sql += ` AND i.type = ?`;
      params.push(p.itemType);
    }
  }
  sql += ` ORDER BY i.modified_at DESC`;
  if (p.limit !== undefined) {
    sql += ` LIMIT ?`;
    params.push(p.limit);
  }
  return { sql, params };
}

async function runReembedJob(
  jobId: string,
  p: ReembedParams,
  ctx: IndexReembedRpcContext,
  controller: AbortController,
): Promise<void> {
  const startedAt = Date.now();
  const batchSize = clampBatchSize(p.batchSize);
  let succeeded = 0;
  let skipped = 0;
  try {
    if (p.model.startsWith("openai:")) {
      const envKey = processEnvGet("OPENAI_API_KEY")?.trim() ?? "";
      if (envKey === "") {
        const v = await ctx.vault.get("openai.api_key");
        const vaultKey = typeof v === "string" ? v.trim() : "";
        if (vaultKey === "") {
          throw new IndexReembedRpcError(
            -32603,
            "openai.api_key missing in vault. Run `nimbus vault set openai.api_key <key>`.",
          );
        }
      }
    } else if (p.model !== "Xenova/all-MiniLM-L6-v2" && p.model !== "local") {
      throw new IndexReembedRpcError(-32602, `Unsupported model: ${p.model}`);
    }

    const { sql, params } = buildCandidateSql(p);
    const candidates = ctx.db.query(sql).all(...params) as IndexedItem[];
    const total = candidates.length;
    if (p.dryRun === true) {
      ctx.notify("index.reembedDone", {
        jobId,
        succeeded: 0,
        skipped: 0,
        durationMs: Date.now() - startedAt,
        planned: total,
        dryRun: true,
      });
      return;
    }
    const embedder = await resolveEmbedder(p.model, ctx);
    const pipeline = new SqliteEmbeddingPipeline({
      db: ctx.db,
      embedder,
      logger: ctx.logger,
    });

    for (let i = 0; i < candidates.length; i += batchSize) {
      if (controller.signal.aborted) {
        break;
      }
      const slice = candidates.slice(i, i + batchSize);
      try {
        for (const row of slice) {
          await pipeline.embedItem(row);
          succeeded += 1;
        }
      } catch (err) {
        const status = (err as { status?: number } | undefined)?.status;
        if (status === 429 || (typeof status === "number" && status >= 500 && status < 600)) {
          const retryAfterMs =
            (err as { retryAfterMs?: number }).retryAfterMs ?? FALLBACK_RETRY_AFTER_MS;
          await new Promise((r) => setTimeout(r, retryAfterMs));
          try {
            for (const row of slice) {
              await pipeline.embedItem(row);
              succeeded += 1;
            }
          } catch (retryErr) {
            ctx.logger.warn(
              {
                errName: retryErr instanceof Error ? retryErr.name : "Error",
                errMessage: retryErr instanceof Error ? retryErr.message : String(retryErr),
                batchStart: i,
                batchSize: slice.length,
              },
              "reembed batch failed after retry; skipping",
            );
            skipped += slice.length;
          }
        } else if (status === 401 || status === 403) {
          throw new IndexReembedRpcError(
            -32603,
            `Fatal: OpenAI returned ${String(status)}. Check openai.api_key validity.`,
          );
        } else {
          throw err;
        }
      }
      ctx.notify("index.reembedProgress", {
        jobId,
        done: succeeded + skipped,
        total,
        skipped,
      });
    }

    ctx.notify("index.reembedDone", {
      jobId,
      succeeded,
      skipped,
      durationMs: Date.now() - startedAt,
    });
  } catch (err) {
    ctx.notify("index.reembedError", {
      jobId,
      code: err instanceof IndexReembedRpcError ? err.rpcCode : -32603,
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    activeReembeds.delete(jobId);
  }
}

function handleReembed(params: unknown, ctx: IndexReembedRpcContext): { jobId: string } {
  const p = parseReembedParams(params);
  const jobId = newJobId();
  const controller = new AbortController();
  activeReembeds.set(jobId, controller);
  void runReembedJob(jobId, p, ctx, controller);
  return { jobId };
}

function handleReembedCancel(params: unknown): { cancelled: boolean } {
  const rec =
    params !== null && typeof params === "object" ? (params as Record<string, unknown>) : {};
  const jobId = rec["jobId"];
  if (typeof jobId !== "string") {
    throw new IndexReembedRpcError(-32602, "params.jobId is required");
  }
  const controller = activeReembeds.get(jobId);
  if (controller === undefined) {
    return { cancelled: false };
  }
  controller.abort();
  return { cancelled: true };
}

export async function dispatchIndexReembedRpc(
  method: string,
  params: unknown,
  ctx: IndexReembedRpcContext,
): Promise<RpcMissOrHit> {
  return dispatchByMethod<IndexReembedRpcContext>(method, params, ctx, {
    "index.reembed": handleReembed,
    "index.reembedCancel": (p) => handleReembedCancel(p),
  });
}
