import type { MappedRow } from "./mapped-row.ts";
import { asRecord, stringField } from "./unknown-record.ts";
import { BODY_MAX, clamp, parseTimestampMs, TITLE_MAX } from "./warehouse-mapping-primitives.ts";

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
    ...(modelArn === null ? {} : { modelArn }),
    ...(ctx.containerImage !== undefined && ctx.containerImage !== ""
      ? { containerImage: ctx.containerImage }
      : {}),
    ...(ctx.modelDataUrl !== undefined && ctx.modelDataUrl !== ""
      ? { modelDataUrl: ctx.modelDataUrl }
      : {}),
    ...(ctx.executionRoleArn !== undefined && ctx.executionRoleArn !== ""
      ? { executionRoleArn: ctx.executionRoleArn }
      : {}),
    ...(creationTime === null ? {} : { creationTime }),
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
