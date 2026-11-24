import { byCodeUnit } from "../../util/canonical-json.ts";
import type { GapNote, IncidentRecordV1 } from "../incident-record-types.ts";

/**
 * Caps and text hygiene shared by the incident lanes (Phase 10 IC3). Provider text enters a record capped and
 * single-lined, and is rendered only through the hardening helpers (`hardenedTitleLink`, `hardenedPlain`).
 */

/** A title stored in a record: at most this many code points. */
export const TITLE_MAX_CODEPOINTS = 200;
export const CHAT_CAP = 50;
export const PRIOR_CAP = 10;
export const CONCURRENT_CAP = 10;
export const DATA_LIST_CAP = 10;
export const HISTORY_CAP = 20;
export const CONCURRENT_WINDOW_MS = 30 * 60_000;
export const CHAT_WINDOW_BEFORE_MS = 24 * 3_600_000;
/** A record's JSON must stay under this many bytes; the SQL CHECK backstop is twice this. */
export const RECORD_JSON_SOFT_CAP_BYTES = 64 * 1024;

// Format characters (bidi overrides and isolates, zero-width, BOM) are removed so a stored title reads the
// same as its bytes; controls and line or paragraph separators collapse to one space so a title cannot
// forge a line.
const FORMAT_RE = /\p{Cf}/gu;
const BREAK_RE = /[\p{Cc}\p{Zl}\p{Zp}]+/gu;

/** One display line of at most `max` code points (an ellipsis marks a cut). */
export function oneLine(s: string, max: number = TITLE_MAX_CODEPOINTS): string {
  const flat = s.replace(FORMAT_RE, "").replace(BREAK_RE, " ").trim();
  const cps = Array.from(flat);
  return cps.length <= max ? flat : `${cps.slice(0, max - 1).join("")}…`;
}

/** Compare by code unit (never by locale), the one comparator every lane sort uses. */
export const codeUnitCompare = byCodeUnit;

export type GapCategory = GapNote["category"];

export function gap(category: GapCategory, detail: string, remediation?: string): GapNote {
  return remediation === undefined ? { category, detail } : { category, detail, remediation };
}

function dbtCount(data: { readonly dbtTests?: readonly unknown[] }): number {
  return data.dbtTests?.length ?? 0;
}

export type CapStep = {
  readonly lane: "chat" | "concurrent" | "prior" | "history" | "data";
  readonly before: number;
  readonly after: number;
};

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function jsonBytes(record: IncidentRecordV1): number {
  return new TextEncoder().encode(JSON.stringify(record)).length;
}

/**
 * Share `n` retained entries across lists of the given sizes, one at a time round-robin over the lists that
 * still have entries, so a short list never wastes its share and the retained total is `min(n, sum)`.
 */
export function allocate(n: number, sizes: readonly number[]): number[] {
  const out = sizes.map(() => 0);
  let left = n;
  let progressed = true;
  while (left > 0 && progressed) {
    progressed = false;
    for (let i = 0; i < sizes.length && left > 0; i += 1) {
      if ((out[i] ?? 0) < (sizes[i] ?? 0)) {
        out[i] = (out[i] ?? 0) + 1;
        left -= 1;
        progressed = true;
      }
    }
  }
  return out;
}

/**
 * Cut lists until `record_json` fits the soft cap, in a fixed order (chat, concurrent, prior, history, data):
 * each lane's list is halved, then emptied, before the next lane is touched. Returns the record and the cuts
 * made; the caller adds a `truncated` gap naming them, so a cut is never silent. A record that already fits is
 * returned unchanged.
 */
export function capRecordSize(
  record: IncidentRecordV1,
  maxBytes: number = RECORD_JSON_SOFT_CAP_BYTES,
): { readonly record: IncidentRecordV1; readonly cuts: readonly CapStep[] } {
  if (jsonBytes(record) <= maxBytes) return { record, cuts: [] };
  const work: Mutable<IncidentRecordV1> = { ...record };
  const cuts: CapStep[] = [];
  const shrink = (lane: CapStep["lane"], length: () => number, keep: (n: number) => void): void => {
    for (const target of [Math.floor(length() / 2), 0]) {
      if (jsonBytes(work) <= maxBytes || length() === 0) return;
      const before = length();
      keep(target);
      cuts.push({ lane, before, after: length() });
    }
  };
  shrink(
    "chat",
    () => work.chat.messages.length,
    (n) => {
      work.chat = { ...work.chat, messages: work.chat.messages.slice(0, n) };
    },
  );
  shrink(
    "concurrent",
    () => work.concurrent.records.length,
    (n) => {
      work.concurrent = { ...work.concurrent, records: work.concurrent.records.slice(0, n) };
    },
  );
  shrink(
    "prior",
    () => work.prior.incidents.length,
    (n) => {
      work.prior = { ...work.prior, incidents: work.prior.incidents.slice(0, n) };
    },
  );
  shrink(
    "history",
    () => work.history.rows.length,
    (n) => {
      const rows = work.history.rows.slice(0, n);
      work.history = {
        ...work.history,
        rows,
        truncated: work.history.total - rows.length,
      };
    },
  );
  const data = work.data;
  if (data !== null) {
    shrink(
      "data",
      () => data.orchestration.length + data.prs.length + data.lineage.length + dbtCount(data),
      (n) => {
        const [lin, orch, prs, dbt] = allocate(n, [
          data.lineage.length,
          data.orchestration.length,
          data.prs.length,
          dbtCount(data),
        ]);
        work.data = {
          ...data,
          lineage: data.lineage.slice(0, lin),
          orchestration: data.orchestration.slice(0, orch),
          prs: data.prs.slice(0, prs),
          ...(data.dbtTests === undefined ? {} : { dbtTests: data.dbtTests.slice(0, dbt) }),
        };
      },
    );
  }
  return { record: work, cuts };
}
