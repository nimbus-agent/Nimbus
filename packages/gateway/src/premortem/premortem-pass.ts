import type { Database } from "bun:sqlite";

import { affectedServicesForEpics } from "./epic-services.ts";
import { type DiscoveredEpic, discoverClosedEpics } from "./theme-discover.ts";
import { type ExtractedTheme, extractThemes, type ThemeLlm } from "./theme-llm-adapter.ts";
import {
  demoteThemesWithNoLiveEvidence,
  pruneOrphanedEvidence,
  readPassState,
  type ThemeEvidenceInput,
  upsertTheme,
  writePassState,
} from "./theme-store.ts";

export type PremortemPassOptions = {
  nowMs: number;
  /** Rows pulled per iteration; also the model's prompt batch. */
  batchSize?: number;
  maxLlmCalls: number;
  llm?: ThemeLlm;
  signal?: AbortSignal;
};

export type PremortemPassResult = {
  scanned: number;
  themesWritten: number;
  demoted: number;
  prunedEvidence: number;
  llmCalls: number;
  /**
   * True when the pass stopped early because no local model was available for
   * a batch it needed to extract from (never configured, or a transient
   * failure) — distinct from `themesWritten === 0`, which can also mean a
   * working model genuinely found nothing. Mirrors the counter
   * `decisions/decision-extract.ts` carries for the same distinction; boolean
   * here rather than a count because a pass stops at the FIRST no-model batch
   * rather than tallying across many.
   */
  noModel: boolean;
};

// Lowered from 20: `theme-llm-adapter.ts` caps each epic body at 2 KiB
// (`EPIC_BODY_MAX`), and a batch of 4 keeps the rendered prompt (bodies +
// titles/ids + the wrapToolOutput envelope + INSTRUCTIONS) comfortably inside
// Ollama's default 4096-token (~16 KiB) `num_ctx` with headroom left for the
// completion — 20 uncapped bodies could reach ~320 KiB and get front-truncated
// past the instructions entirely. A smaller batch means more calls to cover
// the same corpus, bounded by `maxLlmCallsPerPass` (default 25) as before.
const DEFAULT_BATCH_SIZE = 4;

/**
 * Fan one batch of extracted themes out into `premortem_theme` rows, returning
 * how many rows were written.
 *
 * Split out of `runPremortemPass` for cognitive complexity (Sonar S3776, which
 * scored that function at 45). The surrounding loop is a linear
 * discover → extract → write → checkpoint sequence; this triple-nested fan-out
 * was the one deeply branchy region in it.
 *
 * A theme's service is the AFFECTED service its attesting epics touched
 * (`billing-api`), never the connector that owns the row (`jira`) — so ONE
 * theme yields one row per affected service, each carrying only the evidence
 * that actually touched that service.
 */
function writeThemeRows(
  db: Database,
  args: {
    themes: readonly ExtractedTheme[];
    byId: ReadonlyMap<string, DiscoveredEpic>;
    servicesByEpic: ReadonlyMap<string, readonly string[]>;
    nowMs: number;
  },
): number {
  const { themes, byId, servicesByEpic, nowMs } = args;
  let written = 0;
  for (const t of themes) {
    const evidenceByService = new Map<string, ThemeEvidenceInput[]>();
    for (const id of t.sourceItemIds) {
      const epic = byId.get(id);
      if (epic === undefined) continue;
      for (const service of servicesByEpic.get(id) ?? []) {
        const list = evidenceByService.get(service) ?? [];
        list.push({
          itemId: id,
          evidenceKey: id,
          label: epic.title,
          // Omit rather than default to 0 — `occurred_at` is nullable and
          // 1970 is a lie.
          ...(epic.resolvedAtMs === undefined ? {} : { occurredAt: epic.resolvedAtMs }),
        });
        evidenceByService.set(service, list);
      }
    }
    // An epic whose services could not be resolved contributes nothing.
    // That is correct, not a silent drop: with no service there is no key
    // under which PR B could ever find the theme.
    for (const [service, evidence] of evidenceByService) {
      upsertTheme(db, { service, label: t.label, nowMs, evidence });
      written += 1;
    }
  }
  return written;
}

/**
 * discover -> extract -> reconcile, checkpointing the watermark PER BATCH.
 *
 * The watermark advances only when a batch was actually examined by a model.
 * Two cases stop the loop WITHOUT advancing or checkpointing, both surfaced
 * as `noModel: true`:
 *
 *  - `opts.llm === undefined` (`[premortem].use_llm = false`) — there is no
 *    model to call at all, so the loop breaks before `discoverClosedEpics`
 *    even runs; no pointless query, no batch claimed as examined.
 *  - `extractThemes` reports `{ kind: "no-model" }` for an `opts.llm` that
 *    WAS supplied but could not complete this call (absent local provider,
 *    or a transient failure) — that batch was fetched but never actually
 *    examined.
 *
 * In both cases, advancing past the batch would permanently consume the
 * corpus the moment the gateway ever ran without a working local model —
 * flipping `use_llm` back on, or the provider recovering, would then find
 * nothing left to mine. The loop stops rather than trying the next batch,
 * since the condition (no model / a model that just failed) is expected to
 * hold for the rest of this pass too.
 *
 * The reconcile sweep (`pruneOrphanedEvidence` + `demoteThemesWithNoLiveEvidence`)
 * runs unconditionally after the loop, independent of whether any batch was
 * examined — a `noModel` pass still prunes/demotes themes written by an
 * earlier, working pass.
 */
export async function runPremortemPass(
  db: Database,
  opts: PremortemPassOptions,
): Promise<PremortemPassResult> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  let { watermarkMs, watermarkId } = readPassState(db);
  let scanned = 0;
  let themesWritten = 0;
  let llmCalls = 0;
  let noModel = false;

  for (;;) {
    if (opts.signal?.aborted === true) break;

    if (opts.llm === undefined) {
      // `use_llm = false`. Same rule as the `no-model` outcome below: a batch
      // whose model call never ran must not be marked mined, or flipping
      // `use_llm` back on later finds an empty corpus forever. Break BEFORE
      // discovery — with no model there is no work to do but the reconcile
      // sweep, which runs after this loop regardless.
      noModel = true;
      break;
    }

    if (llmCalls >= opts.maxLlmCalls) break;

    const batch: DiscoveredEpic[] = discoverClosedEpics(db, {
      watermarkMs,
      watermarkId,
      batchSize,
    });
    if (batch.length === 0) break;

    if (opts.llm !== undefined) {
      const outcome = await extractThemes(batch, { llm: opts.llm });
      if (outcome.kind === "no-model") {
        // The corpus was NOT examined this batch — stop without advancing or
        // checkpointing the watermark, and without charging a call that did
        // not produce a usable result. A later pass (this gateway restarted
        // against a working Ollama, or the same one once it recovers) resumes
        // here and re-tries these exact epics.
        noModel = true;
        break;
      }
      llmCalls += 1;
      const themes = outcome.themes;
      const byId = new Map(batch.map((e) => [e.itemId, e]));

      // A theme's service is the AFFECTED service its attesting epics touched
      // (`billing-api`), never the connector that owns the row (`jira`). PR B
      // matches themes against a cohort's affected services, so writing the
      // connector service here would leave every lookup returning zero rows
      // while both halves looked individually correct.
      //
      // Resolved for the WHOLE batch in one query, not once per epic: each
      // call scans `item` in full (no expression index on `metadata.parent_key`
      // exists anywhere in this repo), and this pass must not stall the
      // interactive gateway with up to `batchSize` back-to-back scans and no
      // `await` between them.
      const servicesByEpic = affectedServicesForEpics(
        db,
        batch.map((e) => e.itemId),
      );

      themesWritten += writeThemeRows(db, {
        themes,
        byId,
        servicesByEpic,
        nowMs: opts.nowMs,
      });
    }

    const last = batch.at(-1);
    if (last === undefined) break;
    watermarkMs = last.modifiedAt;
    watermarkId = last.itemId;
    scanned += batch.length;

    // Checkpoint per batch, so an abort or crash resumes here rather than at 0.
    writePassState(db, {
      watermarkMs,
      watermarkId,
      nowMs: opts.nowMs,
      newThemes: themesWritten,
      scanned,
    });

    if (batch.length < batchSize) break;
  }

  // Reconcile: prune first, then demote. Pruning removes evidence whose source
  // item has left the index, which both stops dead rows accumulating forever
  // and keeps confidence honest — corroboration the user can no longer see
  // should not still be counted. Demotion then reduces to "no evidence left".
  const prunedEvidence = pruneOrphanedEvidence(db);
  const demoted = demoteThemesWithNoLiveEvidence(db, opts.nowMs);
  return { scanned, themesWritten, demoted, prunedEvidence, llmCalls, noModel };
}
