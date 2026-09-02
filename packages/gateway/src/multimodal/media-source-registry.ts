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
