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
 * `(service, type)` -> modality. A pair that is absent returns undefined and the candidate is
 * skipped as `unresolvable_modality` — never defaulted, since guessing the modality means handing
 * bytes to the wrong model.
 *
 * PR 3 adds the cloud pairs (`google_photos:photo`, `zoom:recording`, ...). Deliberately not
 * pre-populated: an entry here with no `fetchBytes` behind it would make discovery surface
 * candidates the pass can only skip.
 */
const ITEM_TYPE_MODALITY: ReadonlyMap<string, MediaModality> = new Map([
  ["filesystem:media_av", "av"],
  ["filesystem:media_image", "image"],
]);

export function modalityForItem(service: string, type: string): MediaModality | undefined {
  return ITEM_TYPE_MODALITY.get(`${service}:${type}`);
}

/**
 * The `item.type` values that carry a given modality, derived from ITEM_TYPE_MODALITY so a new
 * registry entry is picked up automatically. Undefined modality means every media type.
 *
 * Discovery needs this because its LIMIT is applied by SQLite: filtering modality in JS after the
 * fetch silently under-fills the page and makes a resumable pass look finished when it is not.
 */
export function mediaItemTypesForModality(modality?: MediaModality): readonly string[] {
  const out = new Set<string>();
  for (const [key, m] of ITEM_TYPE_MODALITY) {
    if (modality !== undefined && m !== modality) continue;
    const type = key.slice(key.indexOf(":") + 1);
    out.add(type);
  }
  return [...out];
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
