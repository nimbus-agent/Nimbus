import type { Database } from "bun:sqlite";

import { affectedServicesForEpic } from "./epic-services.ts";
import { type DiscoveredEpic, discoverClosedEpics } from "./theme-discover.ts";
import { extractThemes, type ThemeLlm } from "./theme-llm-adapter.ts";
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
};

const DEFAULT_BATCH_SIZE = 20;

/**
 * discover -> extract -> reconcile, checkpointing the watermark PER BATCH.
 *
 * The watermark advances even when no model is available and zero themes are
 * written. That is deliberate: the alternative re-scans the whole corpus on
 * every tick forever, and the batch genuinely has been examined — there was
 * simply nothing this configuration could extract from it.
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

  for (;;) {
    if (opts.signal?.aborted === true) break;
    if (llmCalls >= opts.maxLlmCalls && opts.llm !== undefined) break;

    const batch: DiscoveredEpic[] = discoverClosedEpics(db, {
      watermarkMs,
      watermarkId,
      batchSize,
    });
    if (batch.length === 0) break;

    if (opts.llm !== undefined) {
      llmCalls += 1;
      const themes = await extractThemes(batch, { llm: opts.llm });
      const byId = new Map(batch.map((e) => [e.itemId, e]));

      // A theme's service is the AFFECTED service its attesting epics touched
      // (`billing-api`), never the connector that owns the row (`jira`). PR B
      // matches themes against a cohort's affected services, so writing the
      // connector service here would leave every lookup returning zero rows
      // while both halves looked individually correct.
      const servicesByEpic = new Map<string, string[]>();
      for (const e of batch) {
        servicesByEpic.set(e.itemId, affectedServicesForEpic(db, e.itemId, e.epicKey));
      }

      for (const t of themes) {
        // One theme row per affected service, each carrying only the evidence
        // that actually touched that service.
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
          upsertTheme(db, { service, label: t.label, nowMs: opts.nowMs, evidence });
          themesWritten += 1;
        }
      }
    }

    const last = batch[batch.length - 1];
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
  return { scanned, themesWritten, demoted, prunedEvidence, llmCalls };
}
