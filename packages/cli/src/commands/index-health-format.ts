/**
 * Renderer for `nimbus index health`. Pure — it takes the gateway's report and returns a string, so
 * the output can be tested without a socket.
 *
 * The wire shape is re-declared here rather than imported: `packages/cli` reaches the gateway over
 * IPC only and never imports gateway source (a repo dependency rule). The gateway-side type is
 * `IndexHealth` in `gateway/src/db/index-health.ts`; the seam between them is covered by the
 * `index.health` tests in `diagnostics-rpc.test.ts`.
 */

export type StaleReason = "never_synced" | "no_sync_record" | "threshold_exceeded";

export interface ConnectorReport {
  readonly service: string;
  readonly items: number;
  readonly embeddedItems: number;
  readonly embeddingCoveragePercent: number;
  readonly lastSyncMs: number | null;
  readonly staleDays: number | null;
  readonly stale: boolean;
  readonly staleReason: StaleReason | null;
}

export interface SparseTypeReport {
  readonly type: string;
  readonly items: number;
  readonly sparseItems: number;
  readonly missingUrl: number;
  readonly missingModifiedAt: number;
  readonly missingMetadata: number;
  readonly sparsePercent: number;
}

export interface IndexHealthReport {
  readonly totalItems: number;
  readonly embeddingCoveragePercent: number;
  readonly connectors: readonly ConnectorReport[];
  readonly sparseTypes: readonly SparseTypeReport[];
  readonly confidence: number | null;
  readonly confidenceUnavailableReason: "empty_index" | null;
  readonly confidenceInputs: {
    readonly embeddingCoveragePercent: number;
    readonly freshItemPercent: number;
    readonly coverageWeight: number;
    readonly freshnessWeight: number;
  };
  readonly staleThresholdDays: number;
  readonly generatedAtMs: number;
}

/** Mirrors `LOW_CONFIDENCE_THRESHOLD` in the gateway; the doctor warning uses the same number. */
export const LOW_CONFIDENCE_THRESHOLD = 60;

// Built from a code point on purpose: this file is mostly ANSI plumbing, and neither a raw
// control byte nor a backslash escape survives every editor and diff tool intact.
const ESC = String.fromCodePoint(27);
const RED = `${ESC}[1;31m`;
const YELLOW = `${ESC}[33m`;
const RESET = `${ESC}[0m`;

function num(n: number): string {
  return n.toLocaleString("en-US");
}

function pad(s: string, w: number): string {
  return s + " ".repeat(Math.max(0, w - s.length));
}

function padStart(s: string, w: number): string {
  return " ".repeat(Math.max(0, w - s.length)) + s;
}

/**
 * A null age renders as the REASON, never as an elapsed time. "0d ago" on a connector that has
 * never synced would claim the opposite of the truth.
 */
function ageLabel(c: ConnectorReport, nowMs: number): string {
  if (c.staleReason === "never_synced") return "never";
  if (c.staleReason === "no_sync_record") return "no sync record";
  if (c.lastSyncMs === null) return "unknown";
  const ms = Math.max(0, nowMs - c.lastSyncMs);
  const hours = ms / 3_600_000;
  if (hours < 1) return `${Math.max(1, Math.round(ms / 60_000))}m ago`;
  if (hours < 48) return `${Math.round(hours)}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function missingParts(t: SparseTypeReport): string {
  // Zero columns are omitted: printing "modified_at 0" is noise the reader must filter out.
  const parts: string[] = [];
  if (t.missingUrl > 0) parts.push(`url ${num(t.missingUrl)}`);
  if (t.missingModifiedAt > 0) parts.push(`modified_at ${num(t.missingModifiedAt)}`);
  if (t.missingMetadata > 0) parts.push(`metadata ${num(t.missingMetadata)}`);
  return parts.join(", ");
}

export interface FormatOptions {
  readonly nowMs: number;
  readonly noColor: boolean;
  /** List connectors holding zero items. Off by default — see `visibleConnectors`. */
  readonly all?: boolean;
}

/**
 * Hide connectors with no indexed items unless `--all`.
 *
 * Not cosmetic. The gateway registers a `sync_state` row for EVERY known connector at boot, so a
 * real install renders 97 rows of which ~90 are empty and were never configured — the handful that
 * matter are unreadable in the noise. Found by running the command against a live gateway; every
 * unit test used a hand-built two-connector report and could not see it.
 *
 * The omission is always DISCLOSED with a count, and `--json` is unaffected: the wire payload stays
 * complete, and only the human render is filtered.
 */
function visibleConnectors(
  connectors: readonly ConnectorReport[],
  all: boolean,
): { shown: readonly ConnectorReport[]; hidden: number } {
  if (all) return { shown: connectors, hidden: 0 };
  const shown = connectors.filter((c) => c.items > 0);
  return { shown, hidden: connectors.length - shown.length };
}

function confidenceBlock(r: IndexHealthReport, opts: FormatOptions): string[] {
  if (r.confidence === null) {
    // Never render null as 0. A brand-new install scoring "0/100" reads as a verdict on the
    // product, when the truth is that there is nothing indexed to judge yet.
    return ["  Confidence   —  (the index is empty; run `nimbus sync` first)", ""];
  }
  const low = r.confidence < LOW_CONFIDENCE_THRESHOLD;
  const score = `${r.confidence}/100`;
  const colored = opts.noColor || !low ? score : `${RED}${score}${RESET}`;
  const suffix = low ? "  LOW" : "";
  return [
    `  Confidence   ${colored}${suffix}` +
      `   (coverage ${r.confidenceInputs.embeddingCoveragePercent}%` +
      ` × ${r.confidenceInputs.coverageWeight}, ` +
      `freshness ${r.confidenceInputs.freshItemPercent}%` +
      ` × ${r.confidenceInputs.freshnessWeight})`,
    "",
  ];
}

export function formatIndexHealth(r: IndexHealthReport, opts: FormatOptions): string {
  const lines: string[] = ["", "Index health", ""];
  lines.push(
    ...confidenceBlock(r, opts),
    `  Items        ${num(r.totalItems)} across ${num(r.connectors.length)} connector(s)`,
    "",
  );

  const { shown, hidden } = visibleConnectors(r.connectors, opts.all === true);
  if (shown.length > 0) {
    const w = Math.max(9, ...shown.map((c) => c.service.length));
    lines.push(
      `  ${pad("CONNECTOR", w)}  ${padStart("ITEMS", 9)}  ${padStart("EMBEDDED", 9)}  LAST SYNC`,
    );
    for (const c of shown) {
      const flag = c.stale ? "  STALE" : "";
      const staleMark = opts.noColor || !c.stale ? flag : `  ${YELLOW}STALE${RESET}`;
      const coverage = padStart(`${c.embeddingCoveragePercent}%`, 9);
      lines.push(
        `  ${pad(c.service, w)}  ${padStart(num(c.items), 9)}  ` +
          `${coverage}  ${ageLabel(c, opts.nowMs)}${staleMark}`,
      );
    }
    lines.push("");
  }

  // OUTSIDE the `shown.length > 0` block on purpose. When every registered connector holds zero
  // items there is no table to attach it to, and that is exactly when the disclosure matters most:
  // without it the render would silently drop all of them and say nothing.
  if (hidden > 0) {
    lines.push(
      `  (${num(hidden)} connector(s) with no indexed items omitted — pass --all to list them)`,
      "",
    );
  }

  lines.push("  Sparse metadata");
  if (r.sparseTypes.length === 0) {
    lines.push("    none — every indexed type has url, modified_at and metadata populated");
  } else {
    for (const t of r.sparseTypes) {
      lines.push(
        `    ${t.type}: ${num(t.sparseItems)} of ${num(t.items)} items (${t.sparsePercent}%)` +
          ` — missing ${missingParts(t)}`,
      );
    }
  }
  // The stale threshold is always disclosed: without it "12d ago STALE" is unfalsifiable, because
  // the reader cannot tell whether the verdict came from the 7-day default or a tighter
  // `--stale-days`.
  lines.push("", `  Stale threshold: ${r.staleThresholdDays} days.`, "");
  return `${lines.join("\n")}\n`;
}
