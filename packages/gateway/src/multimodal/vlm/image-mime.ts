/**
 * The image type that goes ON THE WIRE to a vision model (spec § 19.2).
 *
 * WHY THE SNIFF IS AUTHORITATIVE AND THE DECLARED TYPE IS THE FALLBACK. On the cloud arm the
 * "declared" type is a remote provider's `Content-Type` header — `media-types.ts` says in as many
 * words that it is "not something an understander should trust further than that" — and a wrong
 * `media_type` is not a soft failure: Anthropic rejects `image/png` over JPEG bytes with an
 * HTTP 400, so trusting the header converts a provider quirk into a per-artifact failure the user
 * cannot diagnose. Magic bytes are the artifact itself.
 *
 * Four types, because these are what every target vendor accepts. A format outside the set (HEIC
 * straight off an iPhone is the common one) resolves to null and the caller REFUSES the artifact
 * rather than sending bytes of unknown type on the theory that the vendor might cope.
 *
 * Pure: no I/O, no allocation beyond the comparisons. Nothing here decodes an image — see
 * `ollama-vlm.ts`'s note on why `sharp` must not come back.
 */
export type WireImageMime = "image/jpeg" | "image/png" | "image/webp" | "image/gif";

const WIRE_MIMES: readonly WireImageMime[] = ["image/jpeg", "image/png", "image/webp", "image/gif"];

function startsWith(bytes: Uint8Array, sig: readonly number[]): boolean {
  if (bytes.length < sig.length) return false;
  return sig.every((b, i) => bytes[i] === b);
}

export function sniffImageMime(bytes: Uint8Array): WireImageMime | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
  // RIFF alone is ambiguous — WAV and AVI share it — so the WEBP fourcc at offset 8 is required.
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    bytes.length >= 12 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

/**
 * Sniff first; fall back to a declared type ONLY when it names one of the four wire types.
 * Returns null when neither resolves — the caller refuses that artifact
 * (`unsupported_image_format`) rather than guessing.
 */
export function resolveWireMime(bytes: Uint8Array, declared: string | null): WireImageMime | null {
  const sniffed = sniffImageMime(bytes);
  if (sniffed !== null) return sniffed;
  if (declared === null) return null;
  // `image/png; charset=binary` and `IMAGE/PNG` are both real headers in the wild.
  const bare = declared.split(";")[0]?.trim().toLowerCase() ?? "";
  return (WIRE_MIMES as readonly string[]).includes(bare) ? (bare as WireImageMime) : null;
}
