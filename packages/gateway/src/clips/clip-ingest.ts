import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { itemPrimaryKey, upsertIndexedItem } from "../index/item-store.ts";
import { canonicalizeUrl } from "../util/url-canonical.ts";

export interface ClipInput {
  readonly url: string;
  readonly canonicalUrl?: string;
  readonly title: string;
  readonly mode: "article" | "selection";
  readonly body: string;
  readonly tags: readonly string[];
  readonly capturedAt: number;
}

export interface ClipResult {
  readonly id: string;
  readonly status: "created" | "updated";
}

export class ClipValidationError extends Error {
  readonly field?: string;
  constructor(message: string, field?: string) {
    super(message);
    this.name = "ClipValidationError";
    if (field !== undefined) this.field = field;
  }
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function asString(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new ClipValidationError(`${key} (non-empty string) is required`, key);
  }
  return v;
}

export function validateClipInput(parsed: unknown): ClipInput {
  if (parsed === null || typeof parsed !== "object") {
    throw new ClipValidationError("body must be a JSON object");
  }
  const o = parsed as Record<string, unknown>;
  const url = asString(o, "url");
  const title = asString(o, "title");
  const body = asString(o, "body");
  const mode = o["mode"];
  if (mode !== "article" && mode !== "selection") {
    throw new ClipValidationError('mode must be "article" or "selection"', "mode");
  }
  const capturedAt = o["capturedAt"];
  if (typeof capturedAt !== "number" || !Number.isFinite(capturedAt)) {
    throw new ClipValidationError("capturedAt (epoch ms) is required", "capturedAt");
  }
  const rawTags = o["tags"];
  let tags: string[];
  if (rawTags === undefined) {
    tags = [];
  } else if (Array.isArray(rawTags) && rawTags.every((t) => typeof t === "string")) {
    tags = rawTags;
  } else {
    throw new ClipValidationError("tags must be a string array", "tags");
  }
  const canonicalUrl =
    typeof o["canonicalUrl"] === "string" ? (o["canonicalUrl"] as string) : undefined;
  return { url, title, body, mode, capturedAt, tags, ...(canonicalUrl ? { canonicalUrl } : {}) };
}

function externalIdFor(input: ClipInput, canonical: string): string {
  const base = `clip:${sha256(canonical)}`;
  return input.mode === "selection" ? `${base}:${sha256(input.body)}` : base;
}

function wordCount(text: string): number {
  const t = text.trim();
  return t === "" ? 0 : t.split(/\s+/).length;
}

export function ingestClip(
  db: Database,
  input: ClipInput,
  scheduleEmbedding?: (id: string) => void,
): ClipResult {
  // Always canonicalize — even a caller-supplied canonicalUrl — so re-clip dedup is consistent
  // regardless of what the extension sends (it might send a raw or partially-normalized URL).
  const canonical = canonicalizeUrl(input.canonicalUrl ?? input.url);
  const externalId = externalIdFor(input, canonical);
  const id = itemPrimaryKey("nimbus", externalId);
  // `get` returns null (never undefined) when no row matches — one read suffices.
  const existed = db.query("SELECT 1 FROM item WHERE id = ?").get(id) !== null;
  upsertIndexedItem(db, {
    service: "nimbus",
    type: "web_clip",
    externalId,
    title: input.title,
    bodyPreview: input.body,
    url: input.url,
    canonicalUrl: canonical,
    modifiedAt: input.capturedAt,
    syncedAt: input.capturedAt,
    metadata: {
      tags: input.tags,
      mode: input.mode,
      wordCount: wordCount(input.body),
      clippedAt: input.capturedAt,
    },
  });
  scheduleEmbedding?.(id);
  return { id, status: existed ? "updated" : "created" };
}
