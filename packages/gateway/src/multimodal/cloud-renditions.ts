/**
 * Which URL to fetch an artifact's bytes from, and whether a credential may ride on it.
 *
 * THE RULE (spec § 16.4): a credential is attached only to a URL this codebase CONSTRUCTED. A
 * provider-returned URL is pre-signed and is fetched with no `Authorization` header at all, so a
 * hostile or compromised API response naming any host it likes learns no credential — it still
 * learns that this machine issued a GET. Constraining the SCHEME/HOST a provider-returned URL is
 * actually fetched against is the fetcher's job (a later task), not this one.
 *
 * Pure — no network, no vault, no clock — so the rule is testable without either.
 */
import type { MediaModality } from "./media-types.ts";

export type ByteUrl =
  | { readonly kind: "constructed"; readonly url: string; readonly bearer: true }
  | { readonly kind: "provider"; readonly url: string; readonly bearer: false };

/** We build this against a FIXED host, so the bearer is safe on it. */
export function driveByteUrl(externalId: string): ByteUrl {
  const id = encodeURIComponent(externalId);
  return {
    kind: "constructed",
    url: `https://www.googleapis.com/drive/v3/files/${id}?alt=media&supportsAllDrives=true`,
    bearer: true,
  };
}

const PHOTOS_RENDITION_EDGE = 2048;

/**
 * Google Photos serves bytes from a pre-signed `baseUrl`. Renditions are a SUFFIX on it:
 * `=w<W>-h<H>` bounds a still's long edge; `=dv` asks for the transcoded video.
 *
 * NOTE: the caller must have RE-RESOLVED `baseUrl` — an indexed one is expired (spec § 16.6).
 */
export function photosByteUrl(
  baseUrl: string,
  modality: MediaModality,
  renditions: boolean,
): ByteUrl {
  const suffix = !renditions
    ? ""
    : modality === "image"
      ? `=w${PHOTOS_RENDITION_EDGE}-h${PHOTOS_RENDITION_EDGE}`
      : "=dv";
  return { kind: "provider", url: `${baseUrl}${suffix}`, bearer: false };
}

/** Microsoft Graph's `@microsoft.graph.downloadUrl` is pre-signed and short-lived. */
export function onedriveByteUrl(downloadUrl: string): ByteUrl {
  return { kind: "provider", url: downloadUrl, bearer: false };
}
