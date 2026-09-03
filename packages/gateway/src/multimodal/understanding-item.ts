/**
 * The derived understanding item (spec § 4).
 *
 * Writes via `upsertIndexedItem` DIRECTLY, not `upsertIndexedItemForSync`: that wrapper exists to
 * apply a CONNECTOR's configured index depth, and a Nimbus-derived item has no connector and so no
 * depth to apply. Every existing derived writer does the same — `glossary/glossary-project.ts`,
 * `briefs/brief-save.ts`, `clips/clip-ingest.ts`.
 *
 * The consequence to remember: only the sync wrapper calls `scheduleItemEmbedding`, so a derived
 * item that is not scheduled here is never embedded and never found by semantic search.
 */
import type { Database } from "bun:sqlite";
import { itemPrimaryKey, upsertIndexedItem } from "../index/item-store.ts";
import {
  type MediaCandidate,
  UNDERSTANDING_VERSION,
  type UnderstandOutcome,
} from "./media-types.ts";

const SERVICE = "nimbus";

export interface UnderstandingRow {
  readonly service: string;
  readonly type: string;
  readonly externalId: string;
  readonly title: string;
  readonly body: string;
  readonly url: string | null;
  readonly modifiedAt: number;
  readonly syncedAt: number;
  readonly metadata: Record<string, unknown>;
}

/**
 * STABLE — the version is deliberately NOT in the id.
 *
 * `item` is UNIQUE(service, external_id) and upserts ON CONFLICT(id), so `…:understanding:v1` and
 * `…:understanding:v2` would be two rows, not one replaced: a stale duplicate per artifact per
 * version, producing duplicate FTS hits and duplicate agent context (spec § 4.1). The version lives
 * in metadata and discovery compares it there.
 */
export function understandingExternalId(sourceItemId: string): string {
  return `${sourceItemId}:understanding`;
}

export function buildUnderstandingRow(
  candidate: MediaCandidate,
  outcome: UnderstandOutcome,
  nowMs: number,
): UnderstandingRow {
  const isAv = candidate.modality === "av";
  return {
    service: SERVICE,
    type: isAv ? "video_understanding" : "image_understanding",
    externalId: understandingExternalId(candidate.itemId),
    // Matches `zoom:transcript`'s existing house style (`Transcript — <topic>`) so a derived row is
    // distinguishable from its source in a result list without a bracketed tag.
    title: `${isAv ? "Transcript" : "Caption"} — ${candidate.title}`,
    body: outcome.text,
    url: candidate.url,
    modifiedAt: nowMs,
    syncedAt: nowMs,
    metadata: {
      derivedFrom: candidate.itemId,
      model: outcome.model,
      // A caption or transcript is a model's ASSERTION, not an observation. This flag is what lets
      // a brief present it as such rather than citing it as authoritative (spec § 12.3).
      modelDerived: true,
      understandingVersion: UNDERSTANDING_VERSION,
      isLocal: outcome.isLocal,
      sourceMime: candidate.sourceMime,
      sourceBytes: candidate.sourceBytes,
      // Conditional spread, not `?? 0`: writing a zero for an artifact that never reached sampling
      // would be indistinguishable from one whose every frame failed.
      ...(outcome.framesSampled === undefined ? {} : { framesSampled: outcome.framesSampled }),
      ...(outcome.framesCaptioned === undefined
        ? {}
        : { framesCaptioned: outcome.framesCaptioned }),
    },
  };
}

export function writeUnderstanding(
  db: Database,
  candidate: MediaCandidate,
  outcome: UnderstandOutcome,
  nowMs: number,
  scheduleEmbedding?: (itemId: string) => void,
): string {
  const row = buildUnderstandingRow(candidate, outcome, nowMs);
  upsertIndexedItem(db, {
    service: row.service,
    type: row.type,
    externalId: row.externalId,
    title: row.title,
    // `body` (not `bodyPreview`) declares a FULL body, so `bodyCapForItemType` applies the 16 KiB
    // prose cap instead of the 512-char default. Both understanding types are prose-capped via
    // their membership in LOCAL_ONLY_PROSE_TYPES, which `body-caps.ts` unions in.
    body: row.body,
    url: row.url,
    canonicalUrl: row.url,
    modifiedAt: row.modifiedAt,
    syncedAt: row.syncedAt,
    metadata: row.metadata,
  });
  const id = itemPrimaryKey(row.service, row.externalId);
  scheduleEmbedding?.(id);
  return id;
}
