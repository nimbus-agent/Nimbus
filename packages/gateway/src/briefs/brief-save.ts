import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { itemPrimaryKey, upsertIndexedItem } from "../index/item-store.ts";
import type { BriefRun, Report } from "./brief-types.ts";

/** Leaves headroom under RAW_META_MAX_BYTES (64 KB) for the non-report metadata fields. */
const META_BUDGET_BYTES = 60 * 1024;
const TITLE_MAX = 120;

export class ReportTooLargeError extends Error {
  constructor() {
    super("report exceeds the item metadata ceiling");
    this.name = "ReportTooLargeError";
  }
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
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

  let effective = report;
  if (Buffer.byteLength(JSON.stringify(effective), "utf8") > META_BUDGET_BYTES) {
    effective = withoutQuotes(effective);
    if (Buffer.byteLength(JSON.stringify(effective), "utf8") > META_BUDGET_BYTES) {
      throw new ReportTooLargeError();
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
    bodyPreview: effective.summary,
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
