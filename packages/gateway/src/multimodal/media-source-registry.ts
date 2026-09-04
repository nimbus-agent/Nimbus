/**
 * The SSoT for "is this thing understandable, and as what" (spec § 3.1).
 *
 * Two lookups that must not be collapsed: an EXTENSION lookup used by the filesystem walk to decide
 * what to index at all, and an ITEM lookup used by discovery to decide what to understand. A cloud
 * photo has an item type but no extension; a file on disk has both.
 */
import type { MediaModality } from "./media-types.ts";

const AV_EXTENSIONS: ReadonlySet<string> = new Set([
  ".mp4",
  ".mov",
  ".m4v",
  ".webm",
  ".mkv",
  ".mp3",
  ".m4a",
  ".wav",
  ".flac",
  ".ogg",
]);

const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".tiff",
]);

/** The union, for the filesystem walk's allow-list (spec § 12.4). */
export const MEDIA_EXTENSIONS: ReadonlySet<string> = new Set([
  ...AV_EXTENSIONS,
  ...IMAGE_EXTENSIONS,
]);

/**
 * Lower-cases before lookup: `readdirSync` returns the on-disk casing, and `.MP4` and `.PNG` are
 * ordinary on Windows and on media exported from phones.
 */
export function mediaExtensionModality(ext: string): MediaModality | undefined {
  const lower = ext.toLowerCase();
  if (AV_EXTENSIONS.has(lower)) return "av";
  if (IMAGE_EXTENSIONS.has(lower)) return "image";
  return undefined;
}

/**
 * `(service, type)` -> modality, for services whose item TYPE names the modality directly
 * (`filesystem:media_av`, `filesystem:media_image`). A pair that is absent returns undefined and
 * the candidate is skipped as `unresolvable_modality` — never defaulted, since guessing the
 * modality means handing bytes to the wrong model.
 *
 * Mime-keyed services (`MIME_KEYED_SERVICES`, below) must NEVER be added here, even for a
 * generic-sounding type like `zoom:recording`. This table has no mime condition — an entry here
 * for a mime-keyed service's `(service, type)` pair would make discovery's SQL admit EVERY item of
 * that type regardless of its declared mime, while `modalityForItem` still routes that service
 * through the mime check and drops the non-matching ones — the exact starvation this task exists
 * to prevent, reintroduced through this table instead of the mime arm. A mime-keyed service is
 * discovered ONLY through `MIME_KEYED_SERVICES` + its declared mime.
 *
 * Exported (read-only) SOLELY so media-source-registry.test.ts can assert this table's keys never
 * name a `MIME_KEYED_SERVICES` service — a test that inspects the raw table survives a future
 * rewrite of `mediaItemTypePairsForModality`'s own defensive filter (below), which a test driven
 * only through that function's output could not (fix round 3, Important B).
 */
export const ITEM_TYPE_MODALITY: ReadonlyMap<string, MediaModality> = new Map([
  ["filesystem:media_av", "av"],
  ["filesystem:media_image", "image"],
]);

/**
 * Services whose items carry a GENERIC type and whose modality must come from mime instead.
 *
 * Drive and OneDrive index everything as `type: "file"`; Photos indexes both stills and videos as
 * `type: "photo"`. A mime type is the PROVIDER'S OWN DECLARATION, not our inference, so reading it
 * does not weaken the "never defaulted" rule this module states above — an absent or unrecognised
 * mime is still skipped rather than guessed.
 */
export const MIME_KEYED_SERVICES: ReadonlySet<string> = new Set([
  "google_photos",
  "google_drive",
  "onedrive",
]);

/** SQL `LIKE` patterns per modality. Bound as parameters, never concatenated (I9). */
export const MIME_PATTERNS_FOR_MODALITY: Readonly<Record<MediaModality, readonly string[]>> = {
  image: ["image/%"],
  av: ["video/%", "audio/%"],
};

export function mimeModality(mime: string | null): MediaModality | undefined {
  if (mime === null || mime === "") return undefined;
  const lower = mime.toLowerCase();
  if (lower.startsWith("image/")) return "image";
  if (lower.startsWith("video/") || lower.startsWith("audio/")) return "av";
  return undefined;
}

export function modalityForItem(
  service: string,
  type: string,
  mime?: string | null,
): MediaModality | undefined {
  if (MIME_KEYED_SERVICES.has(service)) {
    return mimeModality(mime ?? null);
  }
  return ITEM_TYPE_MODALITY.get(`${service}:${type}`);
}

export interface MediaItemTypePair {
  readonly service: string;
  readonly type: string;
}

/**
 * The `(service, type)` pairs that carry a given modality, derived from ITEM_TYPE_MODALITY so a
 * new registry entry here is picked up automatically. Undefined modality means every pair in the
 * table.
 *
 * A pair whose service is in `MIME_KEYED_SERVICES` is filtered out here EVEN IF the docstring
 * above (correctly) says such a pair should never exist in `ITEM_TYPE_MODALITY` in the first
 * place. This is not redundant: the docstring is a promise about the table's CONTENTS, enforced
 * only by the disjointness test in media-source-registry.test.ts; this filter is what makes
 * discovery's SQL arm 1 safe even if that promise is ever broken. Without it, a mime-keyed pair
 * slipping into the table (e.g. `("google_drive", "file")`) would make arm 1 admit EVERY item of
 * that (service, type) regardless of declared mime — since arm 1 carries no mime condition — while
 * `modalityForItem` still routes that service through the mime check and drops the non-matching
 * ones, under-filling the page (fix round 3, Important B).
 *
 * PAIR-keyed, not type-keyed: discovery's SQL arm built from this must match the same shape
 * `modalityForItem`'s non-mime-keyed branch does (`ITEM_TYPE_MODALITY.get(`${service}:${type}`)`).
 * A bare `src.type IN (...)` clause matches the type across EVERY service regardless of which one
 * registered it — a future `zoom:recording` pair would also admit any other service that happens
 * to use `type: "recording"`, which the JS check would then drop for lacking a registered pair,
 * under-filling the SQL page exactly like the mime-arm starvation bug this task fixes.
 *
 * Discovery needs this because its LIMIT is applied by SQLite: filtering modality in JS after the
 * fetch silently under-fills the page and makes a resumable pass look finished when it is not.
 */
export function mediaItemTypePairsForModality(
  modality?: MediaModality,
): readonly MediaItemTypePair[] {
  const out: MediaItemTypePair[] = [];
  for (const [key, m] of ITEM_TYPE_MODALITY) {
    if (modality !== undefined && m !== modality) continue;
    const sep = key.indexOf(":");
    const service = key.slice(0, sep);
    if (MIME_KEYED_SERVICES.has(service)) continue;
    out.push({ service, type: key.slice(sep + 1) });
  }
  return out;
}

/**
 * Where a service records its artifact's byte size, and in what type.
 *
 * Not one key: `filesystem` writes `sizeBytes` (number), Drive and OneDrive both write `size` but
 * Drive's is a STRING, because the Drive v3 API serialises int64 as a string. A plain numeric read
 * of that field returns null silently, which degrades the byte budget rather than breaking
 * anything visibly — which is exactly why this is a named table and not an inline read.
 *
 * A service absent from this map has no size to read. `google_photos` is deliberately absent:
 * `mediaMetadata` carries width and height and no byte count, so its size is genuinely unknown and
 * must be reported as unknown rather than estimated (spec § 16.9).
 */
const SOURCE_BYTES_KEY: ReadonlyMap<string, { readonly key: string; readonly numeric: boolean }> =
  new Map([
    ["filesystem", { key: "sizeBytes", numeric: true }],
    ["google_drive", { key: "size", numeric: false }],
    ["onedrive", { key: "size", numeric: true }],
  ]);

export function mediaSourceBytes(
  service: string,
  metadata: Record<string, unknown>,
): number | null {
  const spec = SOURCE_BYTES_KEY.get(service);
  if (spec === undefined) return null;

  const raw = metadata[spec.key];
  if (typeof raw === "number") {
    return Number.isFinite(raw) && raw >= 0 ? raw : null;
  }
  if (!spec.numeric && typeof raw === "string" && raw !== "") {
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }
  return null;
}
