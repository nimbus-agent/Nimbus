import { RAW_META_MAX_BYTES } from "../../index/constants.ts";
import { itemPrimaryKey } from "../../index/item-key.ts";
import type { BodyRow } from "../../index/item-store.ts";

/** Gateway-local mirror of the sync v1 request (the gateway never imports `@nimbus-dev/sdk`). */
export interface ExtensionSyncRequest {
  readonly cursor: string | null;
  readonly depth: "metadata_only" | "summary" | "full";
  readonly historyFloorMs?: number;
}

export interface ParsedSyncPage {
  readonly status: "ok";
  readonly rows: readonly BodyRow[];
  readonly cursor: string | null;
  readonly hasMore: boolean;
  readonly dropped: {
    readonly undeclaredType: number;
    readonly malformed: number;
    readonly oversized: number;
  };
}

export type ParsedSyncResponse =
  | ParsedSyncPage
  | { readonly status: "rate_limited"; readonly retryAfterMs?: number }
  | { readonly status: "unauthenticated" };

export interface ParseSyncContext {
  readonly indexServiceId: string;
  readonly itemTypes: readonly string[];
  readonly syncedAt: number;
}

/** A malformed RESPONSE (as opposed to a malformed item, which is dropped and counted). */
export class ExtensionSyncResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtensionSyncResponseError";
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

type ItemVerdict = { readonly row: BodyRow } | { readonly drop: "malformed" | "oversized" };

function optionalUrl(v: unknown): string | null | undefined | "bad" {
  if (v === undefined || v === null || typeof v === "string") {
    return v;
  }
  return "bad";
}

function validateBody(o: Record<string, unknown>): Record<string, unknown> | null {
  const { body, bodyPreview, bodyTruncated } = o;
  if (body !== undefined && bodyPreview !== undefined) {
    return null;
  }
  if (body !== undefined) {
    if (typeof body !== "string") {
      return null;
    }
    if (bodyTruncated !== undefined && typeof bodyTruncated !== "boolean") {
      return null;
    }
    return bodyTruncated === undefined ? { body } : { body, bodyTruncated };
  }
  if (bodyTruncated !== undefined) {
    return null;
  }
  if (bodyPreview === undefined) {
    return {};
  }
  return typeof bodyPreview === "string" ? { bodyPreview } : null;
}

function buildRow(o: Record<string, unknown>, ctx: ParseSyncContext): ItemVerdict {
  const { type, externalId, title, modifiedAt, metadata } = o;
  const url = optionalUrl(o["url"]);
  const canonicalUrl = optionalUrl(o["canonicalUrl"]);
  const bodyPart = validateBody(o);
  if (
    typeof type !== "string" ||
    type === "" ||
    typeof externalId !== "string" ||
    externalId === "" ||
    typeof title !== "string" ||
    typeof modifiedAt !== "number" ||
    !Number.isSafeInteger(modifiedAt) ||
    modifiedAt < 0 ||
    !isPlainObject(metadata) ||
    url === "bad" ||
    canonicalUrl === "bad" ||
    bodyPart === null
  ) {
    return { drop: "malformed" };
  }
  if (Buffer.byteLength(JSON.stringify(metadata), "utf8") > RAW_META_MAX_BYTES) {
    return { drop: "oversized" };
  }
  // service and syncedAt come from the gateway, never from the item.
  const row = {
    service: ctx.indexServiceId,
    type,
    externalId,
    title,
    modifiedAt,
    metadata,
    syncedAt: ctx.syncedAt,
    ...(url === undefined ? {} : { url }),
    ...(canonicalUrl === undefined ? {} : { canonicalUrl }),
    ...bodyPart,
    // Safe: validateBody returns exactly one arm of the body union, so the spread is a valid BodyRow.
  } as BodyRow;
  return { row };
}

function parseOk(raw: Record<string, unknown>, ctx: ParseSyncContext): ParsedSyncPage {
  const { items, cursor, hasMore } = raw;
  if (!Array.isArray(items)) {
    throw new ExtensionSyncResponseError("sync response: items must be an array");
  }
  if (cursor !== null && typeof cursor !== "string") {
    throw new ExtensionSyncResponseError("sync response: cursor must be a string or null");
  }
  if (typeof hasMore !== "boolean") {
    throw new ExtensionSyncResponseError("sync response: hasMore must be a boolean");
  }
  if (hasMore && (cursor === null || cursor === "")) {
    // A null/empty cursor would send the next call back to page 1 forever.
    throw new ExtensionSyncResponseError("sync response: hasMore requires a non-empty cursor");
  }
  const declared = new Set(ctx.itemTypes);
  const seen = new Set<string>();
  const rows: BodyRow[] = [];
  let undeclaredType = 0;
  let malformed = 0;
  let oversized = 0;
  for (const item of items) {
    if (!isPlainObject(item)) {
      malformed += 1;
      continue;
    }
    if (typeof item["type"] === "string" && !declared.has(item["type"])) {
      undeclaredType += 1;
      continue;
    }
    const verdict = buildRow(item, ctx);
    if ("drop" in verdict) {
      if (verdict.drop === "oversized") {
        oversized += 1;
      } else {
        malformed += 1;
      }
      continue;
    }
    // The primary key ignores `type`, so two types sharing an externalId would overwrite.
    const key = itemPrimaryKey(ctx.indexServiceId, verdict.row.externalId);
    if (seen.has(key)) {
      malformed += 1;
      continue;
    }
    seen.add(key);
    rows.push(verdict.row);
  }
  return { status: "ok", rows, cursor, hasMore, dropped: { undeclaredType, malformed, oversized } };
}

export function parseSyncResponse(raw: unknown, ctx: ParseSyncContext): ParsedSyncResponse {
  if (!isPlainObject(raw)) {
    throw new ExtensionSyncResponseError("sync response: not an object");
  }
  switch (raw["status"]) {
    case "ok":
      return parseOk(raw, ctx);
    case "rate_limited": {
      const ra = raw["retryAfterMs"];
      if (ra === undefined) {
        return { status: "rate_limited" };
      }
      if (typeof ra !== "number" || !Number.isSafeInteger(ra) || ra < 0) {
        throw new ExtensionSyncResponseError(
          "sync response: retryAfterMs must be a non-negative integer",
        );
      }
      return { status: "rate_limited", retryAfterMs: ra };
    }
    case "unauthenticated":
      return { status: "unauthenticated" };
    default:
      throw new ExtensionSyncResponseError("sync response: unknown status");
  }
}
