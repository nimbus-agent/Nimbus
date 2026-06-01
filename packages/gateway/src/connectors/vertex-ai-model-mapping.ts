import type { MappedRow } from "./mapped-row.ts";
import { asRecord, stringField } from "./unknown-record.ts";

export interface VertexAiMappingContext {
  readonly project: string;
  readonly region: string;
  readonly syncedAt: number;
}

export type VertexAiMappedRow = MappedRow<"vertex_ai", "model">;

const TITLE_MAX = 256;
const BODY_MAX = 512;

/**
 * Parse a `gcloud ai` RFC3339 ISO timestamp string (e.g. `createTime`,
 * `updateTime`) into unix millis, or null if absent/unparseable.
 */
export function parseIsoMs(raw: unknown): number | null {
  if (typeof raw !== "string" || raw.trim() === "") {
    return null;
  }
  const ms = Date.parse(raw.trim());
  return Number.isNaN(ms) ? null : ms;
}

function clamp(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Extract the trailing `<id>` segment of a Vertex AI model resource name
 * (`projects/<p>/locations/<r>/models/<id>`). Returns the input unchanged when
 * it has no `/`.
 */
function lastNameSegment(name: string): string {
  const idx = name.lastIndexOf("/");
  return idx >= 0 ? name.slice(idx + 1) : name;
}

/**
 * Pure mapper: a Vertex AI model REGISTRY entry (one element from
 * `gcloud ai models list --format json`) → IndexedItem. Stores model-REGISTRY
 * metadata ONLY — resource name, display name, version id, region, and
 * create/update timestamps. NEVER stores inference, predictions, batch outputs,
 * or any model output. Returns null when the resource name is missing and no
 * display name is present (nothing stable to key on).
 */
export function mapVertexAiModelToItem(
  raw: unknown,
  ctx: VertexAiMappingContext,
): VertexAiMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) {
    return null;
  }

  const modelName = stringField(row, "name") ?? "";
  const displayName = stringField(row, "displayName") ?? "";
  const versionId = stringField(row, "versionId");
  const createTime = parseIsoMs(row["createTime"]);
  const updateTime = parseIsoMs(row["updateTime"]);

  // external_id: prefer the resource name; fall back to `<region>/<displayName>`.
  const externalId =
    modelName !== "" ? modelName : displayName !== "" ? `${ctx.region}/${displayName}` : "";
  if (externalId === "") {
    return null;
  }

  // title: prefer displayName; fall back to the id segment of the resource name.
  const titleSource =
    displayName !== "" ? displayName : modelName !== "" ? lastNameSegment(modelName) : externalId;
  const title = clamp(titleSource, TITLE_MAX);

  const bodyParts: string[] = [`region:${ctx.region}`];
  if (versionId !== undefined && versionId !== "") {
    bodyParts.push(`version:${versionId}`);
  }
  if (modelName !== "") {
    bodyParts.push(modelName);
  }
  const bodyPreview = clamp(bodyParts.join(", "), BODY_MAX);

  const modifiedAt = updateTime ?? createTime ?? ctx.syncedAt;

  const metadata: Record<string, unknown> = {
    project: ctx.project,
    region: ctx.region,
    ...(modelName !== "" ? { modelName } : {}),
    ...(displayName !== "" ? { displayName } : {}),
    ...(versionId !== undefined && versionId !== "" ? { versionId } : {}),
    ...(createTime !== null ? { createTime } : {}),
    ...(updateTime !== null ? { updateTime } : {}),
  };

  return {
    service: "vertex_ai",
    type: "model",
    externalId,
    title,
    bodyPreview,
    url: null,
    canonicalUrl: null,
    modifiedAt,
    metadata,
    syncedAt: ctx.syncedAt,
  };
}
