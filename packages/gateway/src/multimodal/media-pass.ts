/**
 * The budgeted, resumable understanding pass (spec § 8).
 *
 * Owner-invoked, never scheduled and never agent-callable in this slice. Shaped after
 * `nimbus index rebody`, which solved the same problem: a large recovery pass over an existing
 * index that must survive interruption.
 *
 * Two properties the tests pin, because both are easy to lose:
 *  - a per-artifact failure the gate CATEGORIZES (any `SkipReason`) never aborts the pass; it is
 *    recorded so a re-run retries exactly it. This is narrower than "nothing aborts the pass": an
 *    UNCAUGHT throw from a collaborator — e.g. `MediaGateDeps.understanderFor` itself, which
 *    `understandArtifact` does not wrap in try/catch the way it wraps `provider.understand()` —
 *    propagates out of `runMediaPass` and DOES abort the run. The per-iteration `finally` below
 *    still runs on that path (a cloud scratch file is still released), but no `SkipReason` is
 *    recorded and no later candidate is attempted;
 *  - the summary discloses skips BY REASON. "understood 42 of 108" with no breakdown is the
 *    disclosure failure this pass exists not to commit.
 *
 * PR 3 adds a THIRD property, just as easy to lose: a budget stop is not a drained queue. The
 * short-page rule below (`candidates.length < deps.limit` -> clear the cursor) means "discovery
 * reached the end"; an early stop mid-page means the opposite, and clearing there would restart
 * the next run from the top and re-fetch everything this run already understood.
 */

import type { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { type CloudBytes, type CloudBytesDeps, fetchCloudBytes } from "./cloud-bytes.ts";
import { type CloudUrlResolverDeps, resolveCloudByteUrl } from "./cloud-url-resolver.ts";
import { resolveLocalMediaPath } from "./media-bytes.ts";
import { findCandidates } from "./media-discovery.ts";
import { type MediaGateDeps, understandArtifact } from "./media-gate.ts";
import { clearCursor, readCursor, writeCursor } from "./media-pass-state.ts";
import type {
  MediaCandidate,
  MediaModality,
  MediaSource,
  RenditionMode,
  SkipReason,
} from "./media-types.ts";
import { pruneOrphanedUnderstandings } from "./orphan-prune.ts";
import { sweepStaleScratchFiles } from "./stt/ffmpeg-bin.ts";
import { writeUnderstanding } from "./understanding-item.ts";

/**
 * The collaborators `resolveCloudByteUrl` and `fetchCloudBytes` need, shared by both since a
 * bearer-carrying URL round-trip and the byte fetch itself both go through the same transport and
 * the same credential resolver. Named for its OWN module rather than re-exporting `CloudBytesDeps`
 * unchanged: `scratchDir`/`maxBytes`/`remainingBudget` vary PER CANDIDATE (the last two per CHUNK,
 * inside `fetchCloudBytes` itself), so they cannot live on a pass-wide deps object — only the
 * PICK below is pass-wide.
 */
export type MediaCloudDeps = Pick<
  CloudBytesDeps,
  "bearerFor" | "fetchFn" | "appendEgress" | "sleep"
>;

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
  /**
   * Where transcodes AND cloud downloads land. Omitted, no start-of-pass sweep runs (unit tests
   * that never transcode) — but a cloud candidate reaching `fetchCloudBytes` with no scratchDir is
   * a genuine caller error (production always supplies one, since it is required on
   * `BuildMediaPassDepsInput`), so `runMediaPass` throws rather than guessing a directory.
   */
  readonly scratchDir?: string;
  /** Bytes still permitted THIS RUN, across every cloud fetch (spec § 16.9). */
  readonly fetchBudgetBytes: number;
  /** Ask a cloud provider for a downsized rendition rather than the original (spec § 16.8). */
  readonly preferRenditions: boolean;
  /** The cloud arm's shared collaborators. See {@link MediaCloudDeps}. */
  readonly cloudBytes: MediaCloudDeps;
}

export type MediaPassStopReason = "completed" | "budget_exhausted" | "rate_limited";

export interface MediaPassSummary {
  readonly understood: number;
  readonly skipped: number;
  readonly skippedByReason: Readonly<Record<SkipReason, number>>;
  readonly lastItemId: string | null;
  /**
   * Why the run ended. Without this a truncated pass is indistinguishable from a finished one,
   * and the CLI cannot print resume guidance (spec § 17.3).
   *
   * `budget_exhausted` is deliberately NOT a `SkipReason`: a budget stop ends the run, and
   * recording it per-item would report artifacts that were never attempted as artifacts that
   * failed (spec § 16.10).
   */
  readonly stopReason: MediaPassStopReason;
  /** Bytes actually fetched from a connected service this run. Always 0 for a local-only pass. */
  readonly cloudBytesFetched: number;
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
    not_configured: 0,
    rate_limited: 0,
  };
}

export interface RunPricing {
  readonly knownBytes: number;
  readonly knownCount: number;
  readonly unknownCount: number;
}

/**
 * A pure fold over `sourceBytes` — no network, no db, no clock. `google_photos` indexes no byte
 * size at all (`media-source-registry.ts`'s `SOURCE_BYTES_KEY` has no entry for it), so folding a
 * `null` into the total as `0` would present an ESTIMATE as a MEASUREMENT: a batch of ten unsized
 * Photos items would price as "0 bytes", not "unknown". `knownCount`/`unknownCount` are reported
 * separately from the byte total for the same reason — a caller must be able to say "priced N of M
 * candidates" rather than silently treating the unpriced ones as free (spec § 16.9).
 */
export function priceRun(candidates: readonly MediaCandidate[]): RunPricing {
  let knownBytes = 0;
  let knownCount = 0;
  let unknownCount = 0;
  for (const candidate of candidates) {
    if (candidate.sourceBytes === null) {
      unknownCount += 1;
    } else {
      knownBytes += candidate.sourceBytes;
      knownCount += 1;
    }
  }
  return { knownBytes, knownCount, unknownCount };
}

/**
 * What rendition a cloud fetch actually used. Only a Google Photos fetch with `preferRenditions`
 * on ever differs from `"original"` — Drive and OneDrive always serve the original regardless of
 * this flag, since `cloud-renditions.ts`'s `driveByteUrl`/`onedriveByteUrl` take no rendition
 * argument at all. Deriving this per-service (rather than from `preferRenditions` alone) is what
 * keeps the recorded value honest: claiming a downsized rendition for a service that never offers
 * one would misstate what was actually fetched.
 */
function renditionModeFor(candidate: MediaCandidate, preferRenditions: boolean): RenditionMode {
  if (!preferRenditions || candidate.service !== "google_photos") {
    return "original";
  }
  return candidate.modality === "image" ? "w2048-h2048" : "dv";
}

/**
 * A cloud candidate reaching `fetchCloudBytes` with no `scratchDir` is a caller-configuration
 * error, not a per-artifact skip: production always supplies one (`scratchDir` is required on
 * `BuildMediaPassDepsInput`), so only a test that exercises the cloud arm without setting it up
 * could reach this, and it should fail loudly rather than guess a directory.
 */
function requireCloudScratchDir(deps: MediaPassDeps): string {
  if (deps.scratchDir === undefined) {
    throw new Error("runMediaPass: a cloud candidate needs deps.scratchDir, but none was supplied");
  }
  return deps.scratchDir;
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

  // Pre-flight pricing (spec § 16.9): refuse the WHOLE batch before fetching a single byte when
  // its known cost already exceeds the run budget. Scoped to the cloud-backed subset only — a
  // local-only batch has nothing to price against a byte budget that exists to bound cloud
  // transfer, and must never be refused for one. Nothing was fetched and nothing was attempted, so
  // this returns before the cursor is touched at all — an untouched cursor is not a cleared one.
  const cloudCandidates = candidates.filter((c) => c.sourcePath === null);
  if (cloudCandidates.length > 0) {
    const priced = priceRun(cloudCandidates);
    if (priced.knownBytes > deps.fetchBudgetBytes) {
      return {
        understood: 0,
        skipped: 0,
        skippedByReason: emptyReasons(),
        lastItemId: null,
        stopReason: "budget_exhausted",
        cloudBytesFetched: 0,
      };
    }
  }

  const reasons = emptyReasons();
  let understood = 0;
  let skipped = 0;
  let lastItemId: string | null = null;
  let cloudBytesFetched = 0;
  let remainingBudget = deps.fetchBudgetBytes;
  let stopReason: MediaPassStopReason = "completed";

  for (const candidate of candidates) {
    // Ownership of a cloud scratch file passes to THIS loop on success: `fetchCloudBytes` removes
    // it on its own failure paths but *returns* the path when it succeeds, since the understanding
    // step below is what actually consumes it. Without this `finally`, every successfully
    // understood cloud video would sit on disk until the next pass's hour-old sweep — one run over
    // twenty videos could hold twenty full downloads at once. Covers the throwing path too, not
    // just `continue`/`break`: a `finally` always runs before control leaves the `try`.
    let cloudScratch: string | undefined;
    try {
      let source: MediaSource;
      let rendition: RenditionMode = "original";

      if (candidate.sourcePath === null) {
        // A cloud candidate has no usable URL until re-resolved: a Photos `baseUrl` expires in
        // about an hour, and OneDrive's download URL is never indexed at all. Runs BEFORE
        // fetchCloudBytes for exactly that reason.
        const resolvedUrl = await resolveCloudByteUrl(candidate, deps.preferRenditions, {
          bearerFor: deps.cloudBytes.bearerFor,
          fetchFn: deps.cloudBytes.fetchFn,
        } satisfies CloudUrlResolverDeps);
        if ("error" in resolvedUrl) {
          reasons[resolvedUrl.error] += 1;
          skipped += 1;
          lastItemId = candidate.itemId;
          advance(deps, lastItemId, understood + skipped);
          continue;
        }

        const fetched: CloudBytes = await fetchCloudBytes(candidate, resolvedUrl, {
          scratchDir: requireCloudScratchDir(deps),
          maxBytes: deps.maxBytes,
          remainingBudget,
          bearerFor: deps.cloudBytes.bearerFor,
          appendEgress: deps.cloudBytes.appendEgress,
          fetchFn: deps.cloudBytes.fetchFn,
          sleep: deps.cloudBytes.sleep,
        });

        // Debited from EVERY arm — ok, per-item skip, AND run-stop alike. An artifact refused at
        // the per-artifact cap or the run budget still pulled `fetched` bytes down the wire before
        // it was refused; under-counting any arm is how the run budget stops binding.
        cloudBytesFetched += fetched.fetched;
        remainingBudget -= fetched.fetched;

        if (!fetched.ok) {
          if ("stop" in fetched) {
            stopReason = fetched.stop;
            // The STOPPING candidate was never fetched to completion — it must be RETRIED on the
            // next run, not skipped past. So `lastItemId`/the cursor are deliberately left at
            // whatever the previous iteration (or the resumed-from cursor, if this was the first
            // candidate this run) already set them to; neither is advanced onto this candidate.
            // Advancing here — the original design — self-heals only when a LATER run drains the
            // whole queue and clears the cursor, which on a growing library may be never, so each
            // budget/rate-limit stop would silently lose exactly one artifact forever.
            break;
          }
          reasons[fetched.reason] += 1;
          skipped += 1;
          lastItemId = candidate.itemId;
          advance(deps, lastItemId, understood + skipped);
          continue;
        }

        if (fetched.kind === "path") {
          cloudScratch = fetched.path;
          source = { kind: "path", path: fetched.path };
        } else {
          source = { kind: "bytes", bytes: fetched.bytes, mime: candidate.sourceMime };
        }
        rendition = renditionModeFor(candidate, deps.preferRenditions);
      } else {
        const resolved = resolveLocalMediaPath(candidate, deps.roots, deps.maxBytes);
        if (!resolved.ok) {
          reasons[resolved.reason] += 1;
          skipped += 1;
          lastItemId = candidate.itemId;
          advance(deps, lastItemId, understood + skipped);
          continue;
        }
        source = resolved.source;
      }

      const result = await understandArtifact(candidate, source, deps.gate);
      if (!result.ok) {
        reasons[result.reason] += 1;
        skipped += 1;
        lastItemId = candidate.itemId;
        advance(deps, lastItemId, understood + skipped);
        continue;
      }

      writeUnderstanding(
        deps.db,
        candidate,
        result.outcome,
        deps.nowMs(),
        deps.scheduleEmbedding,
        rendition,
      );
      understood += 1;
      lastItemId = candidate.itemId;
      advance(deps, lastItemId, understood + skipped);
    } finally {
      if (cloudScratch !== undefined) {
        try {
          rmSync(cloudScratch, { force: true });
        } catch {
          // A failed unlink must not end the pass — best-effort, matching fetchCloudBytes's own
          // cleanup paths.
        }
      }
    }
  }

  // Fewer candidates than the limit means discovery reached the end of the queue: nothing more
  // sorts after this point. Clear the cursor so the NEXT run starts from the top rather than
  // resuming forward forever — that is what gives a SKIPPED artifact (as opposed to one already
  // understood, which discovery's version comparison filters out cheaply) another chance. Do
  // this at the END, after the loop: clearing before drain-completion would let an interruption
  // mid-drain lose the cursor a resume still needs.
  //
  // Guarded on `stopReason === "completed"`: a budget or rate-limit stop is NOT a drained queue —
  // clearing here would restart the next run from the top and re-fetch everything this run already
  // understood, even though a short page (fewer candidates than the limit) can coincide with an
  // early stop when the stopping item is near the end of what discovery returned.
  if (stopReason === "completed" && candidates.length < deps.limit) {
    clearCursor(deps.db, deps.passId);
  }

  return {
    understood,
    skipped,
    skippedByReason: reasons,
    lastItemId,
    stopReason,
    cloudBytesFetched,
  };
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
