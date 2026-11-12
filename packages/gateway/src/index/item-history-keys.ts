/**
 * The tracked set for `item_history` (Phase 10 IC1, incident-engine spec § 5.1).
 *
 * Which metadata keys of which `<service>:<type>` pairs are recorded when a sync changes them. The table
 * is DERIVED FROM THE WRITERS (each connector mapper), not from prose: `item-history-keys.test.ts` builds
 * real metadata with the real mapper and fails if a tracked key or a `born` key is one no writer produces.
 *
 * Status is metadata JSON, never an `item` column, so every tracked key is `json_extract(metadata, '$.<key>')`.
 * Titles, bodies and free text are in no list below, so they can never be recorded. Noisy counters
 * (`count`, `userCount`, `lastSeen`, `additions`, `labels`, `mergeable_state*`) are deliberately absent:
 * they change on most syncs and carry no state.
 */

/** A tracked key. `always`: the mapper writes it on EVERY upsert, so an absent key means null (a change). */
export type HistoryKey = { readonly key: string; readonly always?: true };

/** The metadata key holding the provider's creation time, and how to read it. */
export type HistoryBorn = { readonly key: string; readonly kind: "ms" | "iso" };

/** A change of `key` to `newValue` takes its `source_at_ms` from `metadataKey` of the new metadata. */
export type HistorySourceAt = {
  readonly key: string;
  readonly newValue: string;
  readonly metadataKey: string;
};

export type ItemHistorySpec = {
  readonly keys: readonly HistoryKey[];
  readonly born: HistoryBorn | null;
  /** True when `item.modified_at` is the provider's own change clock for this type. */
  readonly modifiedAtTracksChange: boolean;
  readonly sourceAt: readonly HistorySourceAt[];
};

const NO_SOURCE_AT: readonly HistorySourceAt[] = Object.freeze([]);
const PR_SOURCE_AT: readonly HistorySourceAt[] = Object.freeze([
  Object.freeze({ key: "state", newValue: "merged", metadataKey: "merged_at" }),
  Object.freeze({ key: "merged", newValue: "true", metadataKey: "merged_at" }),
]);

const PD_SOURCE_AT: readonly HistorySourceAt[] = Object.freeze([
  Object.freeze({ key: "status", newValue: "resolved", metadataKey: "resolved_at_ms" }),
  Object.freeze({ key: "status", newValue: "acknowledged", metadataKey: "status_changed_at_ms" }),
  Object.freeze({ key: "status", newValue: "triggered", metadataKey: "status_changed_at_ms" }),
]);

const JSM_ALERT_SOURCE_AT: readonly HistorySourceAt[] = Object.freeze([
  Object.freeze({ key: "status", newValue: "closed", metadataKey: "closed_at_ms" }),
  Object.freeze({ key: "acknowledged", newValue: "true", metadataKey: "acknowledged_at_ms" }),
]);

function spec(s: {
  keys: readonly HistoryKey[];
  born: HistoryBorn | null;
  tracks: boolean;
  sourceAt?: readonly HistorySourceAt[];
}): ItemHistorySpec {
  return Object.freeze({
    keys: Object.freeze(s.keys.map((k) => Object.freeze({ ...k }))),
    born: s.born === null ? null : Object.freeze({ ...s.born }),
    modifiedAtTracksChange: s.tracks,
    sourceAt: s.sourceAt ?? NO_SOURCE_AT,
  });
}

const TICKET_KEYS: readonly HistoryKey[] = [
  { key: "status" },
  { key: "status_category", always: true },
  { key: "resolved_at_ms" },
  { key: "due_at_ms" },
];

export const ITEM_HISTORY_SPECS: ReadonlyMap<string, ItemHistorySpec> = new Map([
  [
    "pagerduty:incident",
    spec({
      keys: [
        { key: "status", always: true },
        { key: "severity" },
        { key: "urgency" },
        { key: "assignee_emails", always: true },
        { key: "resolved_by_email", always: true },
      ],
      born: { key: "opened_at_ms", kind: "ms" },
      tracks: true,
      // `resolved_at_ms` is deliberately NOT a tracked key: a rewrite at the IC2 upgrade would log a change.
      sourceAt: PD_SOURCE_AT,
    }),
  ],
  [
    // JSM Operations alert (IC2). `updatedAt` moves with every acknowledgement, close and note, so
    // `modified_at` is the provider's change clock. `closed_at_ms` / `acknowledged_at_ms` are derived from
    // the alert's report durations and exist only when the reply carried them.
    "jira:alert",
    spec({
      keys: [
        { key: "status", always: true },
        { key: "priority", always: true },
        { key: "acknowledged", always: true },
      ],
      born: { key: "opened_at_ms", kind: "ms" },
      tracks: true,
      sourceAt: JSM_ALERT_SOURCE_AT,
    }),
  ],
  [
    "github:pr",
    spec({
      keys: [{ key: "state" }, { key: "merged" }, { key: "draft" }],
      born: { key: "opened_at_ms", kind: "ms" },
      tracks: true,
      sourceAt: PR_SOURCE_AT,
    }),
  ],
  [
    "gitlab:pr",
    spec({
      keys: [{ key: "state" }, { key: "merged" }],
      born: { key: "opened_at_ms", kind: "ms" },
      tracks: false,
      sourceAt: PR_SOURCE_AT,
    }),
  ],
  [
    "bitbucket:pr",
    // Bitbucket's PR resource carries no merge time, so `merged_at` is never written: no sourceAt rule.
    spec({
      keys: [{ key: "state" }, { key: "merged" }],
      born: { key: "opened_at_ms", kind: "ms" },
      tracks: false,
    }),
  ],
  [
    "github:issue",
    spec({ keys: [{ key: "state" }, { key: "due_at_ms" }], born: null, tracks: true }),
  ],
  [
    "jira:issue",
    spec({ keys: TICKET_KEYS, born: { key: "created_at_ms", kind: "ms" }, tracks: true }),
  ],
  [
    "linear:issue",
    spec({ keys: TICKET_KEYS, born: { key: "created_at_ms", kind: "ms" }, tracks: true }),
  ],
  [
    "sentry:error_issue",
    spec({
      keys: [
        { key: "status", always: true },
        { key: "level", always: true },
        { key: "assignedTo", always: true },
      ],
      born: { key: "firstSeen", kind: "ms" },
      tracks: false,
    }),
  ],
  [
    "montecarlo:data_quality_test",
    spec({
      keys: [
        { key: "status", always: true },
        { key: "severity", always: true },
      ],
      born: { key: "firstSeenAt", kind: "iso" },
      tracks: false,
    }),
  ],
  [
    "bigeye:data_quality_test",
    spec({
      keys: [
        { key: "slaStatus", always: true },
        { key: "anomaly", always: true },
      ],
      born: null,
      tracks: false,
    }),
  ],
]);

/** The spec for a pair, or `undefined` for an untracked one (the cost bound: one `Map.get`). */
export function specFor(service: string, type: string): ItemHistorySpec | undefined {
  return ITEM_HISTORY_SPECS.get(`${service}:${type}`);
}

export function historyKeysOf(s: ItemHistorySpec): string[] {
  return s.keys.map((k) => k.key);
}

/** Longest stored value, in code points. */
export const HISTORY_VALUE_MAX = 256;

function capCodePoints(s: string): string {
  if (s.length <= HISTORY_VALUE_MAX) return s;
  let out = "";
  let n = 0;
  for (const ch of s) {
    if (n === HISTORY_VALUE_MAX) break;
    out += ch;
    n += 1;
  }
  return out;
}

function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function isScalar(v: unknown): v is string | number | boolean {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

function normalizeObject(o: Record<string, unknown>): string | null {
  const id = o["id"];
  if (typeof id === "string" || typeof id === "number") return String(id);
  const name = o["name"];
  return typeof name === "string" ? name : null;
}

/**
 * A value as the TEXT stored in `item_history`, capped at 256 code points. `undefined` means "the metadata
 * did not carry the key" (the caller records nothing for it unless the key is `always`); SQL NULL is `null`.
 * An array of scalars is sorted and joined with `,` so a re-ordered list is not a change; an object is its
 * `id`, else its `name`; anything else (nested objects, arrays of objects) is NULL.
 */
export function normalizeHistoryValue(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (isScalar(v)) return capCodePoints(String(v));
  if (Array.isArray(v)) {
    if (!v.every(isScalar)) return null;
    return capCodePoints(v.map(String).sort(compareCodeUnits).join(","));
  }
  if (typeof v === "object") {
    const text = normalizeObject(v as Record<string, unknown>);
    return text === null ? null : capCodePoints(text);
  }
  return null;
}

/**
 * The provider's own time for a change of `key` to `newValue`, when the new metadata carries one (a PR's
 * `merged_at`), else null.
 */
export function sourceAtFor(
  s: ItemHistorySpec,
  key: string,
  newValue: string | null,
  newMetadata: Record<string, unknown>,
): number | null {
  for (const rule of s.sourceAt) {
    if (rule.key === key && rule.newValue === newValue) {
      const t = newMetadata[rule.metadataKey];
      return typeof t === "number" && Number.isFinite(t) ? t : null;
    }
  }
  return null;
}
