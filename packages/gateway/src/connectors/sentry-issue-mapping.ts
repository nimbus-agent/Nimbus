import { clampSyncTitle } from "../sync/pass-cursor-sync-result.ts";
import { asRecord, numberField, stringField } from "./unknown-record.ts";

// `sentry:error_issue` deliberately stays OFF `PROSE_HEAVY_TYPES` (local
// MiniLM 384-dim; see embedding/routing.ts). `buildBody` below is
// `metadata.value` (the exception message, e.g. "TypeError: cannot read
// property 'x' of undefined") plus `culprit` (a code location string, e.g.
// "some/file.py in some_function") — a short, structured error signature,
// not paragraph-shaped natural-language prose. It is also absent from
// `LONG_BODY_TYPES` (index/body-caps.ts), which uses the same short/prose
// distinction for the 512-char-vs-16-KiB body cap and agrees with this call.

export type SentryIssueMappingContext = {
  readonly org: string;
  readonly syncedAt: number;
};

/**
 * Deliberately NOT `MappedRow<"sentry", "error_issue">`: that interface declares
 * `bodyPreview` as required, and `IndexedItemBodyInput` forbids supplying both
 * `body` and `bodyPreview`. This mapper supplies `body` and lets
 * `upsertIndexedItemForSync` clamp it to the connector's configured depth.
 */
export type SentryIssueMappedRow = {
  readonly service: "sentry";
  readonly type: "error_issue";
  readonly externalId: string;
  readonly title: string;
  readonly body: string;
  readonly url: string | null;
  readonly canonicalUrl: string | null;
  readonly modifiedAt: number;
  readonly authorId: null;
  readonly metadata: Record<string, unknown>;
  readonly syncedAt: number;
  readonly pinned: false;
};

function parseIsoMs(v: string | undefined): number | null {
  if (v === undefined) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

/** `metadata.value` over `culprit`, either side omitted when absent. */
function buildBody(row: Record<string, unknown>): string {
  const meta = asRecord(row["metadata"]);
  const value = meta === undefined ? undefined : stringField(meta, "value");
  const culprit = stringField(row, "culprit");
  return [value, culprit].filter((s): s is string => s !== undefined && s !== "").join("\n\n");
}

export function mapSentryIssueToItem(
  raw: unknown,
  ctx: SentryIssueMappingContext,
): SentryIssueMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) return null;

  const id = stringField(row, "id");
  if (id === undefined || id === "") return null;

  // Skipped, never defaulted: a defaulted timestamp corrupts the cursor.
  const lastSeenMs = parseIsoMs(stringField(row, "lastSeen"));
  if (lastSeenMs === null) return null;

  const shortId = stringField(row, "shortId");
  const title = stringField(row, "title") ?? shortId ?? id;
  const permalink = stringField(row, "permalink") ?? null;
  const project = asRecord(row["project"]);
  const projectSlug = project === undefined ? null : (stringField(project, "slug") ?? null);

  // `assignedTo` is stored RAW and UNRESOLVED. Spec B resolves it to a person
  // from rows already indexed, with no re-sync. `?? null` rather than a
  // conditional key, so "not assigned" is recorded rather than indistinguishable
  // from "this connector version did not capture assignment".
  const metadata: Record<string, unknown> = {
    org: ctx.org,
    project: projectSlug,
    status: stringField(row, "status") ?? null,
    level: stringField(row, "level") ?? null,
    shortId: shortId ?? null,
    count: row["count"] ?? null,
    userCount: numberField(row, "userCount") ?? null,
    firstSeen: parseIsoMs(stringField(row, "firstSeen")),
    lastSeen: lastSeenMs,
    assignedTo: row["assignedTo"] ?? null,
  };

  return {
    service: "sentry",
    type: "error_issue",
    externalId: id,
    title: clampSyncTitle(title),
    body: buildBody(row),
    url: permalink,
    canonicalUrl: permalink,
    modifiedAt: lastSeenMs,
    authorId: null,
    metadata,
    syncedAt: ctx.syncedAt,
    pinned: false,
  };
}
