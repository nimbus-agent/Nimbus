import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { bodyCapForItemType, clampBody } from "../index/body-caps.ts";
import { itemPrimaryKey, upsertIndexedItem } from "../index/item-store.ts";
import { canonicalizeUrl } from "../util/url-canonical.ts";

const CLIP_SERVICE = "nimbus";
const CLIP_TYPE = "web_clip";

/**
 * Provenance a clip carries from the page it was captured from.
 *
 * Every member is optional and every member is bounded, because all of these
 * values are controlled by whatever page the user is looking at and
 * `upsertIndexedItem` THROWS when an item's serialised metadata exceeds 64 KB
 * (`../index/item-store.ts`). Without bounds a hostile page could make its own
 * clip un-ingestable.
 */
export interface ClipSource {
  readonly author?: string;
  readonly publishedAt?: number; // epoch ms, normalised by the client
  readonly siteName?: string;
  readonly lang?: string;
  readonly leadImage?: string; // absolute http(s) URL, stored as a reference and never fetched
}

export interface ClipInput {
  readonly url: string;
  readonly canonicalUrl?: string;
  readonly title: string;
  readonly mode: "article" | "selection";
  readonly body: string;
  readonly tags: readonly string[];
  readonly capturedAt: number;
  readonly source?: ClipSource;
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

const SOURCE_PROSE_MAX = 200;
const SOURCE_LANG_MAX = 20;
const SOURCE_LEAD_IMAGE_MAX = 2048;
/** The largest absolute epoch-ms value `Date` can represent. */
const DATE_RANGE_MAX_MS = 8.64e15;

/**
 * Prose DEGRADES under a cap: a byline cut to 200 characters is still a byline
 * and still tells you who wrote the thing.
 */
function boundedProse(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  return trimmed === "" ? undefined : trimmed.slice(0, max);
}

/**
 * Structured values CORRUPT under a cap, so they are dropped instead. Half a URL
 * is not a slightly-worse URL — it is a broken link, and a consumer cannot tell
 * it was truncated. A language tag past 20 characters is, in practice, a page's
 * prose leaking into the wrong `<meta>`, and `en-US`-shaped nonsense cut out of
 * it would be actively misleading.
 */
function boundedExact(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  return trimmed === "" || trimmed.length > max ? undefined : trimmed;
}

/**
 * `publishedAt` is bounded by TYPE, not by length. The only caller normalises
 * through `Date.parse`, which yields integers, so a non-integer is garbage rather
 * than legitimate data being narrowed. `Number.isInteger` rejects `NaN` and
 * `Infinity` on its own.
 *
 * Pre-1970 and far-future values are deliberately VALID: archived essays carry
 * 1965 publication dates and embargoed posts carry future ones. Nothing sorts on
 * this field — `modified_at` still comes from `capturedAt` — so a wild value
 * cannot disturb ordering. If a later change makes `publishedAt` drive ordering,
 * that change owns the tighter bound.
 *
 * A UNIT error is therefore undetectable here and is the CLIENT's to prevent. A
 * seconds-denominated timestamp (`1750000000`) is an integer inside the range and
 * is accepted as ~1970-01-21. The gateway cannot distinguish it from a genuine
 * January 1970 date, and the heuristic that would — "reject implausibly small
 * magnitudes" — is exactly the rule the pre-1970 decision above rejects. So the
 * scaling contract lives at the extraction site, next to the `Date.parse` that
 * produces the value.
 */
function epochMs(v: unknown): number | undefined {
  if (typeof v !== "number" || !Number.isInteger(v) || Math.abs(v) > DATE_RANGE_MAX_MS) {
    return undefined;
  }
  return v;
}

/**
 * Builds a NEW `ClipSource` from the five known fields. It must never return the
 * caller's object, spread it, or delete keys from it: `ingestClip` stores what it
 * is given without further filtering, `upsertIndexedItem` serialises the whole
 * metadata object, and it throws above 64 KB. A page that put 60 KB under
 * `source.junk` would make its own clip un-ingestable — precisely the denial the
 * per-field caps exist to prevent. A whitelist, not a blocklist: the shape
 * TypeScript describes and the shape that reaches storage are the same object,
 * built here.
 *
 * Wrong-typed MEMBERS are dropped rather than thrown, unlike every other field on
 * this body. `asString` throws because a clip without a title is not a clip; a
 * clip with a malformed byline is still a perfectly good clip, and failing it
 * would mean one bad `<meta>` tag costs the user the capture. A `source` that is
 * not an object is different — that is caller error, and it throws.
 */
function validateClipSource(raw: unknown): ClipSource | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ClipValidationError("source must be a JSON object", "source");
  }
  const o = raw as Record<string, unknown>;
  const author = boundedProse(o["author"], SOURCE_PROSE_MAX);
  const publishedAt = epochMs(o["publishedAt"]);
  const siteName = boundedProse(o["siteName"], SOURCE_PROSE_MAX);
  const lang = boundedExact(o["lang"], SOURCE_LANG_MAX);
  const leadImage = boundedExact(o["leadImage"], SOURCE_LEAD_IMAGE_MAX);
  const source: ClipSource = {
    ...(author === undefined ? {} : { author }),
    ...(publishedAt === undefined ? {} : { publishedAt }),
    ...(siteName === undefined ? {} : { siteName }),
    ...(lang === undefined ? {} : { lang }),
    ...(leadImage === undefined ? {} : { leadImage }),
  };
  return Object.keys(source).length === 0 ? undefined : source;
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
  const source = validateClipSource(o["source"]);
  return {
    url,
    title,
    body,
    mode,
    capturedAt,
    tags,
    ...(canonicalUrl ? { canonicalUrl } : {}),
    ...(source === undefined ? {} : { source }),
  };
}

function externalIdFor(input: ClipInput, canonical: string): string {
  const base = `clip:${sha256(canonical)}`;
  return input.mode === "selection" ? `${base}:${sha256(input.body)}` : base;
}

function wordCount(text: string): number {
  const t = text.trim();
  return t === "" ? 0 : t.split(/\s+/).length;
}

interface BodyExtent {
  /** Words in the text the index actually stores and can return. */
  readonly storedWords: number;
  /** Words in the text the extension sent, present only when it exceeded the cap. */
  readonly sourceWords: number | undefined;
}

/**
 * Word counts that describe what is STORED, not what was submitted.
 *
 * `POST /v1/clips` accepts up to 1 MiB, but `upsertIndexedItem` clamps the body
 * to `bodyCapForItemType` (16,384 for `nimbus:web_clip`). Counting the
 * submitted text and reporting it as `wordCount` made the index advertise
 * content it had discarded, with no field a caller could read to detect the
 * loss (#1005).
 *
 * So `wordCount` now measures the stored body — the thing a search can actually
 * return — and an over-cap clip additionally carries `sourceWordCount` +
 * `truncated: true`, which makes the discrepancy explicit rather than invisible.
 * A clip that fits (the overwhelming majority) carries neither, so the common
 * shape is unchanged.
 *
 * `bodyCapForItemType` + `clampBody` are the SAME functions the store applies,
 * not a reimplementation of them — the count cannot drift from the storage rule.
 * The clamp itself only runs on the rare over-cap clip; the length comparison
 * decides that, so a normal clip never pays to copy a large string.
 */
function bodyExtent(body: string): BodyExtent {
  const cap = bodyCapForItemType(CLIP_SERVICE, CLIP_TYPE);
  if (body.length <= cap) {
    return { storedWords: wordCount(body), sourceWords: undefined };
  }
  return { storedWords: wordCount(clampBody(body, cap)), sourceWords: wordCount(body) };
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
  const extent = bodyExtent(input.body);
  upsertIndexedItem(db, {
    service: CLIP_SERVICE,
    type: CLIP_TYPE,
    externalId,
    title: input.title,
    body: input.body,
    url: input.url,
    canonicalUrl: canonical,
    modifiedAt: input.capturedAt,
    syncedAt: input.capturedAt,
    metadata: {
      tags: input.tags,
      mode: input.mode,
      wordCount: extent.storedWords,
      ...(extent.sourceWords === undefined
        ? {}
        : { sourceWordCount: extent.sourceWords, truncated: true }),
      clippedAt: input.capturedAt,
      // `input.source` is the object `validateClipInput` BUILT, never the one the
      // caller sent — see `validateClipSource`. Nothing filters it here, so the
      // filtering has to have already happened.
      //
      // Note that a re-clip WITHOUT `source` clears a previously-stored one:
      // `upsertIndexedItem` replaces metadata wholesale (`metadata = excluded.metadata`),
      // so every metadata key is last-write-wins. `tags` already behave exactly this
      // way. This is inherited behaviour, documented rather than changed here.
      ...(input.source === undefined ? {} : { source: input.source }),
    },
  });
  scheduleEmbedding?.(id);
  return { id, status: existed ? "updated" : "created" };
}
