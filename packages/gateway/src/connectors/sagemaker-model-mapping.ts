import type { MappedRow } from "./mapped-row.ts";
import { asRecord, stringField } from "./unknown-record.ts";

export interface SagemakerMappingContext {
  readonly syncedAt: number;
  /** Optional container image ref from a `describe-model` enrichment pass. */
  readonly containerImage?: string;
  /** Optional model-data S3 URL pointer from `describe-model` (a URI, not bytes). */
  readonly modelDataUrl?: string;
  /** Optional execution-role ARN from `describe-model`. */
  readonly executionRoleArn?: string;
}

export type SagemakerMappedRow = MappedRow<"sagemaker", "model">;

const TITLE_MAX = 256;
const BODY_MAX = 512;

/**
 * SageMaker `CreationTime` arrives as either an ISO-8601 string or epoch SECONDS
 * (the AWS CLI may render it as a unix-seconds float). Parse defensively to unix
 * MILLIS, else null. A bare number < 1e12 is treated as seconds; a larger number
 * is assumed to already be millis.
 */
function parseTimestampMs(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) {
    return v < 1e12 ? Math.round(v * 1000) : Math.round(v);
  }
  if (typeof v === "string" && v.trim() !== "") {
    const trimmed = v.trim();
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      const n = Number(trimmed);
      if (Number.isFinite(n)) {
        return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
      }
    }
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function clamp(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Pure mapper: SageMaker `list-models` entry → IndexedItem. Stores model-REGISTRY
 * metadata ONLY — model name, ARN, creation time, and (optionally, from a
 * `describe-model` enrichment) the primary-container image reference, the
 * model-data S3 URL POINTER (a URI string, NOT the model bytes), and the
 * execution-role ARN. NEVER stores inference, training, or model-artifact data.
 * Returns null when the model name is missing.
 */
export function mapSagemakerModelToItem(
  raw: unknown,
  ctx: SagemakerMappingContext,
): SagemakerMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) {
    return null;
  }

  const modelName = stringField(row, "ModelName");
  if (modelName === undefined || modelName === "") {
    return null;
  }

  const modelArn = stringField(row, "ModelArn") ?? null;
  const creationTime = parseTimestampMs(row["CreationTime"]);

  const title = clamp(modelName, TITLE_MAX);

  const bodyParts: string[] = [];
  if (ctx.containerImage !== undefined && ctx.containerImage !== "") {
    bodyParts.push(`image:${ctx.containerImage}`);
  }
  if (modelArn !== null) {
    bodyParts.push(modelArn);
  }
  const bodyPreview = clamp(bodyParts.length > 0 ? bodyParts.join(", ") : modelName, BODY_MAX);

  const modifiedAt = creationTime ?? ctx.syncedAt;

  const metadata: Record<string, unknown> = {
    modelName,
    ...(modelArn !== null ? { modelArn } : {}),
    ...(ctx.containerImage !== undefined && ctx.containerImage !== ""
      ? { containerImage: ctx.containerImage }
      : {}),
    ...(ctx.modelDataUrl !== undefined && ctx.modelDataUrl !== ""
      ? { modelDataUrl: ctx.modelDataUrl }
      : {}),
    ...(ctx.executionRoleArn !== undefined && ctx.executionRoleArn !== ""
      ? { executionRoleArn: ctx.executionRoleArn }
      : {}),
    ...(creationTime !== null ? { creationTime } : {}),
  };

  return {
    service: "sagemaker",
    type: "model",
    externalId: modelArn ?? modelName,
    title,
    bodyPreview,
    url: null,
    canonicalUrl: null,
    modifiedAt,
    metadata,
    syncedAt: ctx.syncedAt,
  };
}
