import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { itemPrimaryKey, upsertIndexedItem } from "../index/item-store.ts";
import type { BriefRun, Report } from "./brief-types.ts";

/** Leaves headroom under RAW_META_MAX_BYTES (64 KB) for the non-report metadata fields. */
const META_BUDGET_BYTES = 60 * 1024;
const TITLE_MAX = 120;

function overBudget(report: Report): boolean {
  return Buffer.byteLength(JSON.stringify(report), "utf8") > META_BUDGET_BYTES;
}

export class ReportTooLargeError extends Error {
  constructor() {
    super("report exceeds the item metadata ceiling");
    this.name = "ReportTooLargeError";
  }
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * Drops `itemId` on any citation whose `itemId` is byte-identical to its `clipId`.
 *
 * The FIRST rung of the ladder, deliberately above quote-stripping: on a `web_clip` citation
 * the two fields carry the SAME `nimbus:clip:<sha256>` string, so removing one loses the user
 * nothing — `clipId` still resolves the item and `itemType` still says what it is. Across the
 * worst case the count caps allow (MAX_FINDINGS 25 x MAX_CITATIONS_PER_ITEM 8, plus the same
 * again for conflicts = 400 citations) that duplicate is tens of KB against a 60 KB budget,
 * which is enough on its own to push a brief that used to save into ReportTooLargeError.
 *
 * A duplicated id is worth less to the user than their supporting quotes, so this runs first
 * and carries no gap line: nothing recoverable was lost, so there is nothing to disclose.
 */
function withoutRedundantItemIds(report: Report): Report {
  const dedupe = (items: Report["findings"]): Report["findings"] =>
    items.map((i) => ({
      ...i,
      citations: i.citations.map((c) => {
        if (c.itemId === undefined || c.itemId !== c.clipId) return c;
        const { itemId: _itemId, ...rest } = c;
        return rest;
      }),
    }));
  return {
    ...report,
    findings: dedupe(report.findings),
    conflicts: dedupe(report.conflicts),
  };
}

/** Strips every quote — the largest field, and the most recoverable (the citation still names its source). */
function withoutQuotes(report: Report): Report {
  const strip = (items: Report["findings"]): Report["findings"] =>
    items.map((i) => ({
      text: i.text,
      citations: i.citations.map(({ quote: _quote, ...rest }) => rest),
    }));
  return {
    ...report,
    findings: strip(report.findings),
    conflicts: strip(report.conflicts),
    gaps: [...report.gaps, "Supporting quotes were omitted from the saved copy (size limit)."],
  };
}

/**
 * Persists a finished report as a first-class indexed item.
 *
 * The report is bounded at synthesis (brief-report.ts), so the degradation path
 * below should be unreachable; it exists because that bound is reasoning rather
 * than a proof, and silently shredding a research artifact the user believes
 * they saved would be worse than either alternative.
 */
export function saveBriefReport(
  db: Database,
  run: BriefRun,
  scheduleEmbedding?: (id: string) => void,
): { itemId: string } {
  const report = run.report;
  if (report === null) throw new ReportTooLargeError();

  // Degradation ladder, cheapest loss first: shed the duplicated ids, THEN the quotes.
  let effective = report;
  if (overBudget(effective)) {
    effective = withoutRedundantItemIds(effective);
    if (overBudget(effective)) {
      effective = withoutQuotes(effective);
      if (overBudget(effective)) {
        throw new ReportTooLargeError();
      }
    }
  }

  const briefFingerprint = `${run.brief} ${run.createdAtMs}`;
  const externalId = `brief:${sha256(briefFingerprint)}`;
  const itemId = itemPrimaryKey("nimbus", externalId);

  upsertIndexedItem(db, {
    service: "nimbus",
    type: "research_brief",
    externalId,
    title: run.brief.slice(0, TITLE_MAX),
    body: effective.summary,
    url: null,
    canonicalUrl: null,
    modifiedAt: run.createdAtMs,
    syncedAt: run.createdAtMs,
    metadata: {
      source: "research_brief",
      report: effective,
      synthesis: effective.synthesis,
      sourceCount: run.declared.size,
      usedIndex: run.useIndex,
      generatedAt: run.createdAtMs,
    },
  });

  scheduleEmbedding?.(itemId);
  return { itemId };
}
