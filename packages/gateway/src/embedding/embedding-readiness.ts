/**
 * Typed readiness for the local embedding runtime (issue #928).
 *
 * The gateway binds its IPC socket BEFORE the embedding model is loaded, so every
 * embedding-dependent surface has to answer one question honestly: is the absence of
 * a vector PERMANENT for this process (`disabled` / `unavailable`) or TEMPORARY
 * (`warming`)?
 *
 * Handing back a `null` vector while the model is still loading is the false green
 * this module exists to make impossible: a hybrid search with no query vector silently
 * degrades to BM25, and a query with no lexical overlap then returns `[]` — which the
 * caller reports as "nothing matched". A warming runtime therefore NEVER yields `null`.
 * It throws `EmbeddingWarmingError`, which carries the live readiness so a client can
 * render real progress instead of a generic spinner.
 *
 * The contract, in one line: `null` means "no vectors, and waiting will not help";
 * `EmbeddingWarmingError` means "no vectors YET".
 */

import type { EmbeddingDualVectors } from "./types.ts";

export type EmbeddingReadinessState =
  /** The model is loading (possibly downloading). Vectors are not available YET. */
  | "warming"
  /** The model is loaded; semantic search is live. */
  | "ready"
  /** Init failed (fetch error, missing native dep, timeout). No vectors this process. */
  | "unavailable"
  /** Embeddings are switched off by config/env/schema. No vectors, by design. */
  | "disabled";

/** Model-download progress, normalised from the backend's own progress events. */
export type EmbeddingModelDownload = {
  file: string;
  loadedBytes: number;
  totalBytes: number;
  /** 0-100, clamped. `0` when the backend reports no byte totals. */
  percent: number;
};

export type EmbeddingReadiness = {
  state: EmbeddingReadinessState;
  /** Milliseconds spent warming: climbs while `warming`, frozen once the state settles. */
  elapsedMs: number;
  model: string | null;
  dims: number | null;
  /** Live model-download progress while `warming`; `null` when the backend reports none. */
  download: EmbeddingModelDownload | null;
  /** Human-readable cause. Set for `unavailable`; may explain a `disabled` state too. */
  reason: string | null;
};

/** Stable machine-readable code carried by the warming error and by the JSON-RPC error data. */
export const EMBEDDING_WARMING_CODE = "embedding_warming";

/** JSON-RPC error code for "this method needs vectors and the model is still loading". */
export const EMBEDDING_WARMING_RPC_CODE = -32021;

export const NO_DUAL_VECTORS: EmbeddingDualVectors = {
  vec384: null,
  vec1536: null,
  model384: null,
  model1536: null,
};

export function describeEmbeddingWarming(readiness: EmbeddingReadiness): string {
  const secs = Math.round(readiness.elapsedMs / 1000);
  const model = readiness.model ?? "the local embedding model";
  const dl = readiness.download;
  const progress =
    dl === null ? "" : ` — downloading ${dl.file} (${String(Math.round(dl.percent))}%)`;
  return (
    `the embedding runtime is still warming up (${model}, ${String(secs)}s)${progress}. ` +
    `Semantic results are not available yet; retry shortly, or re-run without semantic search ` +
    `to get keyword-only matches.`
  );
}

/**
 * Thrown INSTEAD of returning a null vector while the runtime is warming. Callers that
 * genuinely want to degrade must say so explicitly via the `*BestEffort` helpers below —
 * degradation is never the accidental default.
 */
export class EmbeddingWarmingError extends Error {
  readonly code = EMBEDDING_WARMING_CODE;
  readonly readiness: EmbeddingReadiness;

  constructor(readiness: EmbeddingReadiness) {
    super(describeEmbeddingWarming(readiness));
    this.name = "EmbeddingWarmingError";
    this.readiness = readiness;
  }
}

/**
 * Brand check rather than a bare `instanceof`: the embedding runtime crosses a Worker
 * realm, and a duplicated module instance would defeat `instanceof`. The brand travels.
 */
export function isEmbeddingWarmingError(err: unknown): err is EmbeddingWarmingError {
  if (err instanceof EmbeddingWarmingError) {
    return true;
  }
  if (typeof err !== "object" || err === null) {
    return false;
  }
  return (err as { code?: unknown }).code === EMBEDDING_WARMING_CODE;
}

/**
 * Narrows the progress event @xenova/transformers emits while fetching model files. Every field
 * is optional on the wire, so it enters as `unknown` (non-negotiable #7). Lives here rather than
 * next to its only caller because that caller is coverage-floor-excluded.
 */
export function normalizeModelProgress(raw: unknown): EmbeddingModelDownload | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const rec = raw as Record<string, unknown>;
  if (rec["status"] !== "progress") {
    return null;
  }
  const file = typeof rec["file"] === "string" ? rec["file"] : "model";
  const loaded = typeof rec["loaded"] === "number" ? rec["loaded"] : 0;
  const total = typeof rec["total"] === "number" ? rec["total"] : 0;
  const reported = rec["progress"];
  return {
    file,
    loadedBytes: loaded,
    totalBytes: total,
    percent:
      typeof reported === "number" && Number.isFinite(reported)
        ? Math.min(100, Math.max(0, reported))
        : downloadPercent(loaded, total),
  };
}

/** Percent of a download, clamped to 0-100. `0` when the total is unknown. */
export function downloadPercent(loadedBytes: number, totalBytes: number): number {
  if (!Number.isFinite(loadedBytes) || !Number.isFinite(totalBytes) || totalBytes <= 0) {
    return 0;
  }
  const pct = (loadedBytes / totalBytes) * 100;
  return Math.min(100, Math.max(0, pct));
}

type EmbedQueryLike = { embedQuery: (text: string) => Promise<Float32Array | null> };
type EmbedQueryDualLike = { embedQueryDual: (text: string) => Promise<EmbeddingDualVectors> };

/**
 * Explicit opt-in to silent degradation for callers that ADD optional context and never
 * report "zero results" to a human (session-memory recall, tribal clustering). Named and
 * greppable on purpose: every silent-degrade site must be visible in a code search.
 */
export async function embedQueryBestEffort(
  rt: EmbedQueryLike,
  text: string,
): Promise<Float32Array | null> {
  try {
    return await rt.embedQuery(text);
  } catch (err) {
    if (isEmbeddingWarmingError(err)) {
      return null;
    }
    throw err;
  }
}

/** `embedQueryDual` counterpart of {@link embedQueryBestEffort}. */
export async function embedQueryDualBestEffort(
  rt: EmbedQueryDualLike,
  text: string,
): Promise<EmbeddingDualVectors> {
  try {
    return await rt.embedQueryDual(text);
  } catch (err) {
    if (isEmbeddingWarmingError(err)) {
      return { ...NO_DUAL_VECTORS };
    }
    throw err;
  }
}
