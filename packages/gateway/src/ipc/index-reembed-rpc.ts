import type { Database } from "bun:sqlite";
import { join } from "node:path";
import type { Logger } from "pino";
import { wrapLedgeredEmbedder } from "../egress/embedding-egress.ts";
import { createLocalEmbedder } from "../embedding/model.ts";
import { createOpenAIEmbedder } from "../embedding/openai-embedder.ts";
import { SqliteEmbeddingPipeline } from "../embedding/pipeline.ts";
import type { Embedder, IndexedItem } from "../embedding/types.ts";
import { processEnvGet } from "../platform/env-access.ts";
import type { PlatformPaths } from "../platform/paths.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { dispatchByMethod, type RpcMissOrHit } from "./_lib/dispatch-by-method.ts";
import { LongRunningJobRegistry } from "./_lib/long-running.ts";

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
  /** @internal test seam: override pipeline construction in runReembed */
  _sinkFactory?: (embedder: Embedder) => ReembedSink;
};

type ReembedParams = {
  model: string;
  itemType?: string;
  service?: string;
  limit?: number;
  batchSize?: number;
  dryRun?: boolean;
};

const reembedRegistry = new LongRunningJobRegistry();

const MIN_BATCH = 1;
const MAX_BATCH = 256;
const DEFAULT_BATCH = 100;
const FALLBACK_RETRY_AFTER_MS = 2000;

export function clampBatchSize(raw: number | undefined): number {
  const n = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : DEFAULT_BATCH;
  return Math.min(MAX_BATCH, Math.max(MIN_BATCH, n));
}

export function parseReembedParams(params: unknown): ReembedParams {
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
    out.batchSize = rec["batchSize"];
  }
  if (rec["dryRun"] === true) {
    out.dryRun = true;
  }
  return out;
}

export async function resolveEmbedder(
  model: string,
  ctx: IndexReembedRpcContext,
): Promise<Embedder> {
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
    return wrapLedgeredEmbedder(
      ctx.db,
      await createOpenAIEmbedder({ apiKey, model: openaiModel, dimensions: 1536 }),
    );
  }
  if (model === "Xenova/all-MiniLM-L6-v2" || model === "local") {
    return createLocalEmbedder({ cacheDir: join(ctx.paths.dataDir, "models") });
  }
  throw new IndexReembedRpcError(-32602, `Unsupported model: ${model}`);
}

export function buildCandidateSql(p: ReembedParams): {
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

export async function assertModelUsable(
  p: ReembedParams,
  ctx: IndexReembedRpcContext,
): Promise<void> {
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
}

export function isRetryableStatus(status: number | undefined): boolean {
  return status === 429 || (typeof status === "number" && status >= 500 && status < 600);
}

type BatchCounters = { succeeded: number; skipped: number };

export type ReembedSink = Pick<SqliteEmbeddingPipeline, "embedItem">;

async function embedSlice(
  pipeline: ReembedSink,
  slice: readonly IndexedItem[],
  counters: BatchCounters,
): Promise<void> {
  for (const row of slice) {
    await pipeline.embedItem(row);
    counters.succeeded += 1;
  }
}

type EmbedErrorDecision =
  | { kind: "retry"; retryAfterMs: number }
  | { kind: "fatal-auth"; status: number }
  | { kind: "rethrow" };

function classifyEmbedError(err: unknown): EmbedErrorDecision {
  const status = (err as { status?: number } | undefined)?.status;
  if (isRetryableStatus(status)) {
    const retryAfterMs = (err as { retryAfterMs?: number }).retryAfterMs ?? FALLBACK_RETRY_AFTER_MS;
    return { kind: "retry", retryAfterMs };
  }
  if (status === 401 || status === 403) {
    return { kind: "fatal-auth", status };
  }
  return { kind: "rethrow" };
}

async function retryEmbedSliceOrSkip(
  pipeline: ReembedSink,
  ctx: IndexReembedRpcContext,
  slice: readonly IndexedItem[],
  batchStart: number,
  counters: BatchCounters,
): Promise<void> {
  try {
    await embedSlice(pipeline, slice, counters);
  } catch (retryErr) {
    ctx.logger.warn(
      {
        errName: retryErr instanceof Error ? retryErr.name : "Error",
        errMessage: retryErr instanceof Error ? retryErr.message : String(retryErr),
        batchStart,
        batchSize: slice.length,
      },
      "reembed batch failed after retry; skipping",
    );
    counters.skipped += slice.length;
  }
}

export async function embedBatchWithRetry(
  pipeline: ReembedSink,
  ctx: IndexReembedRpcContext,
  slice: readonly IndexedItem[],
  batchStart: number,
  counters: BatchCounters,
): Promise<void> {
  try {
    await embedSlice(pipeline, slice, counters);
    return;
  } catch (err) {
    const decision = classifyEmbedError(err);
    if (decision.kind === "fatal-auth") {
      throw new IndexReembedRpcError(
        -32603,
        `Fatal: OpenAI returned ${String(decision.status)}. Check openai.api_key validity.`,
      );
    }
    if (decision.kind === "rethrow") {
      throw err;
    }
    await new Promise((r) => setTimeout(r, decision.retryAfterMs));
    await retryEmbedSliceOrSkip(pipeline, ctx, slice, batchStart, counters);
  }
}

async function runReembed(
  p: ReembedParams,
  ctx: IndexReembedRpcContext,
  progress: (payload: Record<string, unknown>) => void,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const batchSize = clampBatchSize(p.batchSize);
  await assertModelUsable(p, ctx);

  const { sql, params } = buildCandidateSql(p);
  const candidates = ctx.db.query(sql).all(...params) as IndexedItem[];
  const total = candidates.length;
  if (p.dryRun === true) {
    return { succeeded: 0, skipped: 0, planned: total, dryRun: true };
  }
  const embedder = await resolveEmbedder(p.model, ctx);
  const pipeline: ReembedSink =
    ctx._sinkFactory === undefined
      ? new SqliteEmbeddingPipeline({ db: ctx.db, embedder, logger: ctx.logger })
      : ctx._sinkFactory(embedder);

  const counters: BatchCounters = { succeeded: 0, skipped: 0 };
  for (let i = 0; i < candidates.length; i += batchSize) {
    if (signal.aborted) {
      break;
    }
    const slice = candidates.slice(i, i + batchSize);
    await embedBatchWithRetry(pipeline, ctx, slice, i, counters);
    progress({ done: counters.succeeded + counters.skipped, total, skipped: counters.skipped });
  }

  return { succeeded: counters.succeeded, skipped: counters.skipped };
}

function handleReembed(params: unknown, ctx: IndexReembedRpcContext): { jobId: string } {
  const p = parseReembedParams(params);
  return reembedRegistry.start({
    jobIdPrefix: "reembed",
    progressMethod: "index.reembedProgress",
    doneMethod: "index.reembedDone",
    errorMethod: "index.reembedError",
    emit: (m, payload) => ctx.notify(m, payload),
    run: (progress, signal) => runReembed(p, ctx, progress, signal),
  });
}

function handleReembedCancel(params: unknown): { cancelled: boolean } {
  const rec =
    params !== null && typeof params === "object" ? (params as Record<string, unknown>) : {};
  const jobId = rec["jobId"];
  if (typeof jobId !== "string") {
    throw new IndexReembedRpcError(-32602, "params.jobId is required");
  }
  return { cancelled: reembedRegistry.cancel(jobId) };
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
