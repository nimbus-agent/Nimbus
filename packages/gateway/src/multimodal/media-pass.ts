/**
 * The budgeted, resumable understanding pass (spec § 8).
 *
 * Owner-invoked, never scheduled and never agent-callable in this slice. Shaped after
 * `nimbus index rebody`, which solved the same problem: a large recovery pass over an existing
 * index that must survive interruption.
 *
 * Two properties the tests pin, because both are easy to lose:
 *  - a per-artifact failure NEVER aborts the pass; it is recorded so a re-run retries exactly it;
 *  - the summary discloses skips BY REASON. "understood 42 of 108" with no breakdown is the
 *    disclosure failure this pass exists not to commit.
 */
import type { Database } from "bun:sqlite";
import { resolveLocalMediaPath } from "./media-bytes.ts";
import { findCandidates } from "./media-discovery.ts";
import { type MediaGateDeps, understandArtifact } from "./media-gate.ts";
import { clearCursor, readCursor, writeCursor } from "./media-pass-state.ts";
import type { MediaModality, SkipReason } from "./media-types.ts";
import { pruneOrphanedUnderstandings } from "./orphan-prune.ts";
import { sweepStaleScratchFiles } from "./stt/ffmpeg-bin.ts";
import { writeUnderstanding } from "./understanding-item.ts";

export interface MediaPassDeps {
  readonly db: Database;
  readonly roots: readonly string[];
  readonly limit: number;
  readonly maxBytes: number;
  readonly nowMs: () => number;
  readonly passId: string;
  readonly gate: MediaGateDeps;
  readonly service?: string;
  readonly modality?: MediaModality;
  readonly sinceMs?: number;
  readonly afterItemId?: string;
  readonly scheduleEmbedding?: (itemId: string) => void;
  /** Where transcodes land. Omitted, no start-of-pass sweep runs (unit tests that never transcode). */
  readonly scratchDir?: string;
}

export interface MediaPassSummary {
  readonly understood: number;
  readonly skipped: number;
  readonly skippedByReason: Readonly<Record<SkipReason, number>>;
  readonly lastItemId: string | null;
}

function emptyReasons(): Record<SkipReason, number> {
  return {
    over_byte_cap: 0,
    no_local_model: 0,
    no_remote_grant: 0,
    unresolvable_modality: 0,
    fetch_miss: 0,
    path_outside_roots: 0,
    transcode_failed: 0,
    transcribe_failed: 0,
  };
}

export async function runMediaPass(deps: MediaPassDeps): Promise<MediaPassSummary> {
  // Reclaim scratch WAVs a previous gateway process died mid-write and never unwound (spec § 5.4).
  // Age-bounded, so a concurrently running pass's file is never removed under it.
  if (deps.scratchDir !== undefined) {
    sweepStaleScratchFiles(deps.scratchDir, deps.nowMs());
  }

  // Reclaim derived rows whose source has left the index (spec § 4.2). Cheap, indexed, and it
  // self-heals rows orphaned before this shipped.
  pruneOrphanedUnderstandings(deps.db);

  // An explicit afterItemId always wins (a caller override); otherwise resume from the stored
  // cursor for this passId, which is what makes an interrupted run resumable at all (spec § 6.2).
  const afterItemId = deps.afterItemId ?? readCursor(deps.db, deps.passId) ?? undefined;

  const candidates = findCandidates(deps.db, {
    limit: deps.limit,
    ...(deps.service === undefined ? {} : { service: deps.service }),
    ...(deps.modality === undefined ? {} : { modality: deps.modality }),
    ...(deps.sinceMs === undefined ? {} : { sinceMs: deps.sinceMs }),
    ...(afterItemId === undefined ? {} : { afterItemId }),
  });

  const reasons = emptyReasons();
  let understood = 0;
  let skipped = 0;
  let lastItemId: string | null = null;

  for (const candidate of candidates) {
    lastItemId = candidate.itemId;

    const resolved = resolveLocalMediaPath(candidate, deps.roots, deps.maxBytes);
    if (!resolved.ok) {
      reasons[resolved.reason] += 1;
      skipped += 1;
      advance(deps, lastItemId, understood + skipped);
      continue;
    }

    const result = await understandArtifact(candidate, resolved.path, deps.gate);
    if (!result.ok) {
      reasons[result.reason] += 1;
      skipped += 1;
      advance(deps, lastItemId, understood + skipped);
      continue;
    }

    writeUnderstanding(deps.db, candidate, result.outcome, deps.nowMs(), deps.scheduleEmbedding);
    understood += 1;
    advance(deps, lastItemId, understood + skipped);
  }

  // Fewer candidates than the limit means discovery reached the end of the queue: nothing more
  // sorts after this point. Clear the cursor so the NEXT run starts from the top rather than
  // resuming forward forever — that is what gives a SKIPPED artifact (as opposed to one already
  // understood, which discovery's version comparison filters out cheaply) another chance. Do
  // this at the END, after the loop: clearing before drain-completion would let an interruption
  // mid-drain lose the cursor a resume still needs.
  if (candidates.length < deps.limit) {
    clearCursor(deps.db, deps.passId);
  }

  return { understood, skipped, skippedByReason: reasons, lastItemId };
}

/**
 * The cursor advances on a SKIP as well as a success. A skip that did not advance would make the
 * next resume start on the same unprocessable artifact forever.
 */
function advance(deps: MediaPassDeps, lastItemId: string, processedCount: number): void {
  writeCursor(deps.db, deps.passId, {
    lastItemId,
    processedCount,
    nowMs: deps.nowMs(),
  });
}
