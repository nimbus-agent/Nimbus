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
import { pruneOrphanedMedia } from "./orphan-prune.ts";
import { sweepStaleScratchFiles } from "./stt/ffmpeg-bin.ts";
import { writeUnderstanding } from "./understanding-item.ts";

/**
 * The collaborators `resolveCloudByteUrl` and `fetchCloudBytes` need, shared by both since a
 * bearer-carrying URL round-trip and the byte fetch itself both go through the same transport, the
 * same credential resolver and the same `sync`-class ledger appender — two REAL outbound requests
 * per Photos/OneDrive candidate, each of which appends its own row before it fires (I29), under
 * distinct `method`s (`media.resolveByteUrl` and `media.fetchBytes`).
 * Named for its OWN module rather than re-exporting `CloudBytesDeps`
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
  /** The vendor named by `[multimodal] remote_vlm`, when configured. See spec § 19.1. */
  readonly remoteVendor?: string | undefined;
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
  /**
   * The numbers behind a PRE-FLIGHT refusal, or `null` when the run was not refused up front.
   *
   * NOT optional, and that is deliberate: the pre-flight refusal is a permanent wedge by design —
   * it touches neither the cursor nor a single byte, so the SAME page is refused on every
   * subsequent run until a human raises the budget or asks for renditions. The numbers that tell
   * them which knob to move are exactly `priceRun`'s output, and until this field existed they were
   * computed and thrown away: the CLI printed generic guidance over an all-zero summary, so the one
   * screen a user sees when the pass wedges carried none of the evidence for the decision it was
   * asking them to make. An optional field would let a caller forget it and silently reproduce
   * that, which is why every disclosure field on this pass is required (spec § 16.9).
   */
  readonly preflightRefusal: PreflightRefusal | null;
}

/**
 * What a pre-flight budget refusal priced, and against what.
 *
 * `candidateCount` covers the WHOLE page, not just its cloud subset, because the refusal blocks
 * every candidate in it — a local file that needs no network at all is refused alongside the cloud
 * ones, since the pass returns before the loop starts. Reporting only the cloud count would let a
 * reader conclude their local media was still being processed.
 */
export interface PreflightRefusal {
  /** Every candidate in the refused page, local ones included. */
  readonly candidateCount: number;
  /** How many of those are cloud-backed (`sourcePath === null`) — the only ones that cost bytes. */
  readonly cloudCount: number;
  /** Summed `sourceBytes` over the cloud candidates that declare one. */
  readonly knownBytes: number;
  /** How many cloud candidates declared a size. */
  readonly knownCount: number;
  /** How many did not — priced as UNKNOWN, never folded into `knownBytes` as zero. */
  readonly unknownCount: number;
  /** The budget `knownBytes` exceeded (`[multimodal] fetch_budget_bytes`, or `--budget`). */
  readonly budgetBytes: number;
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
    describe_failed: 0,
    not_configured: 0,
    rate_limited: 0,
    unsupported_image_format: 0,
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

/**
 * What resolving a CLOUD candidate's bytes produced — a usable source, a per-item skip, or a
 * run-ending stop. Pulled out of {@link runMediaPass}'s loop so the cognitive load of the
 * resolve-then-fetch-then-classify sequence lives in one place, in the order it actually runs.
 */
type CloudResolution =
  | {
      readonly kind: "source";
      readonly source: MediaSource;
      readonly rendition: RenditionMode;
      readonly cloudScratch?: string;
    }
  | { readonly kind: "skip"; readonly reason: SkipReason }
  | { readonly kind: "stop"; readonly reason: MediaPassStopReason };

/**
 * Re-resolves a cloud candidate's provider URL, then fetches it under the run's remaining byte
 * budget. `budget` is mutated in place — `cloudBytesFetched`/`remainingBudget` must be debited
 * from EVERY arm (ok, per-item skip, AND run-stop alike), since an artifact refused at a cap
 * still pulled bytes down the wire before the refusal (spec § 16.9).
 */
async function resolveCloudSource(
  candidate: MediaCandidate,
  deps: MediaPassDeps,
  budget: { remainingBudget: number; cloudBytesFetched: number },
): Promise<CloudResolution> {
  // A cloud candidate has no usable URL until re-resolved: a Photos `baseUrl` expires in about an
  // hour, and OneDrive's download URL is never indexed at all. Runs BEFORE fetchCloudBytes for
  // exactly that reason.
  const resolvedUrl = await resolveCloudByteUrl(candidate, deps.preferRenditions, {
    bearerFor: deps.cloudBytes.bearerFor,
    fetchFn: deps.cloudBytes.fetchFn,
    appendEgress: deps.cloudBytes.appendEgress,
  } satisfies CloudUrlResolverDeps);
  if ("error" in resolvedUrl) {
    // A 429 at RESOLVE is the same provider-wide signal as a 429 at FETCH, and must end the run
    // the same way — treating it as an ordinary per-item skip is how a rate limit burns a whole
    // page, since every remaining candidate would resolve to the same 429.
    if (resolvedUrl.error === "rate_limited") return { kind: "stop", reason: "rate_limited" };
    return { kind: "skip", reason: resolvedUrl.error };
  }

  // Captured BEFORE the call, and before this fetch's own debit below: this is the budget as it
  // stood walking INTO this artifact, which is what "nothing spent yet this run" means below.
  const budgetBeforeThisFetch = budget.remainingBudget;
  const fetched: CloudBytes = await fetchCloudBytes(candidate, resolvedUrl, {
    scratchDir: requireCloudScratchDir(deps),
    maxBytes: deps.maxBytes,
    remainingBudget: budget.remainingBudget,
    bearerFor: deps.cloudBytes.bearerFor,
    appendEgress: deps.cloudBytes.appendEgress,
    fetchFn: deps.cloudBytes.fetchFn,
    sleep: deps.cloudBytes.sleep,
  });

  budget.cloudBytesFetched += fetched.fetched;
  budget.remainingBudget -= fetched.fetched;

  if (!fetched.ok) {
    if ("stop" in fetched) {
      // TWO DIFFERENT SHAPES hide behind one `CloudBytes` stop, and treating them alike is how a
      // single oversized artifact wedges the pass PERMANENTLY:
      //
      //  - TRANSIENT: some EARLIER candidate this run already spent part of the budget, and THIS
      //    artifact simply didn't fit in what was left. A future run, starting with a fresh
      //    budget, may well get past it — so the caller stops here and leaves the cursor on the
      //    last COMPLETED item.
      //  - PERMANENT: `budgetBeforeThisFetch === deps.fetchBudgetBytes` means NOTHING was spent
      //    before this attempt — the artifact was offered the ENTIRE run budget and still could
      //    not fit (an unknown-size candidate, e.g. Google Photos, is the reachable case:
      //    `priceRun`'s pre-flight admits it since it contributes nothing to `knownBytes`). No
      //    FUTURE run using this same budget can ever do better, so stopping here would make
      //    `runMediaPass` return the identical page and stop on the identical candidate forever —
      //    starving every artifact that sorts after it. So this case is a PER-ITEM refusal
      //    instead: skip it, `over_byte_cap` (the same reason the local arm uses for the same
      //    shape of problem), and keep going.
      //
      // Scoped to `budget_exhausted` only — a `rate_limited` stop says nothing about the
      // artifact's SIZE, so applying the same reasoning to it would record a dishonest skip
      // reason for an artifact that may fetch fine on the very next attempt.
      if (fetched.stop === "budget_exhausted" && budgetBeforeThisFetch === deps.fetchBudgetBytes) {
        return { kind: "skip", reason: "over_byte_cap" };
      }
      return { kind: "stop", reason: fetched.stop };
    }
    return { kind: "skip", reason: fetched.reason };
  }

  const rendition = renditionModeFor(candidate, deps.preferRenditions);
  if (fetched.kind === "path") {
    return {
      kind: "source",
      source: { kind: "path", path: fetched.path },
      rendition,
      cloudScratch: fetched.path,
    };
  }
  return {
    kind: "source",
    source: { kind: "bytes", bytes: fetched.bytes, mime: candidate.sourceMime },
    rendition,
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
  pruneOrphanedMedia(deps.db, deps.nowMs());

  // An explicit afterItemId always wins (a caller override); otherwise resume from the stored
  // cursor for this passId, which is what makes an interrupted run resumable at all (spec § 6.2).
  const afterItemId = deps.afterItemId ?? readCursor(deps.db, deps.passId) ?? undefined;

  const candidates = findCandidates(deps.db, {
    limit: deps.limit,
    ...(deps.service === undefined ? {} : { service: deps.service }),
    ...(deps.modality === undefined ? {} : { modality: deps.modality }),
    ...(deps.sinceMs === undefined ? {} : { sinceMs: deps.sinceMs }),
    ...(afterItemId === undefined ? {} : { afterItemId }),
    ...(deps.remoteVendor === undefined ? {} : { remoteVendor: deps.remoteVendor }),
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
        // Carried out, not discarded. See {@link PreflightRefusal}: this refusal repeats every run
        // until a human acts, and these are the numbers that say which knob to move.
        preflightRefusal: {
          candidateCount: candidates.length,
          cloudCount: cloudCandidates.length,
          knownBytes: priced.knownBytes,
          knownCount: priced.knownCount,
          unknownCount: priced.unknownCount,
          budgetBytes: deps.fetchBudgetBytes,
        },
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
        const budget = { remainingBudget, cloudBytesFetched };
        const resolution = await resolveCloudSource(candidate, deps, budget);
        // Debited from EVERY arm — ok, per-item skip, AND run-stop alike — by resolveCloudSource
        // itself; copy its result back regardless of which arm this turned out to be.
        remainingBudget = budget.remainingBudget;
        cloudBytesFetched = budget.cloudBytesFetched;

        if (resolution.kind === "stop") {
          stopReason = resolution.reason;
          // The STOPPING candidate was never fetched to completion — it must be RETRIED on the
          // next run, not skipped past. So `lastItemId`/the cursor are deliberately left at
          // whatever the previous iteration (or the resumed-from cursor, if this was the first
          // candidate this run) already set them to; neither is advanced onto this candidate.
          break;
        }
        if (resolution.kind === "skip") {
          reasons[resolution.reason] += 1;
          skipped += 1;
          lastItemId = candidate.itemId;
          advance(deps, lastItemId, understood + skipped);
          continue;
        }
        source = resolution.source;
        rendition = resolution.rendition;
        cloudScratch = resolution.cloudScratch;
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
    // A run that actually ran was not refused up front, whatever else stopped it — a MID-RUN
    // `budget_exhausted` has different guidance (it leaves the cursor on the last completed item
    // and resumes) and must not borrow the pre-flight refusal's numbers.
    preflightRefusal: null,
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
