/**
 * Turns a cloud candidate into the URL its bytes live at (spec § 16.6).
 *
 * Separate from `cloud-renditions.ts` ON PURPOSE: that module is pure, which is what lets the
 * credential rule be tested with no network and no vault. This one talks to a provider, so it
 * takes its collaborators as injected functions rather than reaching for a global `fetch`.
 *
 * Drive alone needs no round-trip — its byte URL is constructed from the external id. The other
 * two must ASK, because a Photos `baseUrl` expires in about an hour and OneDrive's
 * `@microsoft.graph.downloadUrl` is never indexed. Same rule as the local arm's: what the item
 * stored is not trusted (§ 5.1) — there for security, here for plain correctness.
 *
 * The resolve request itself carries a bearer to a host WE construct. The URL it returns for
 * Photos and OneDrive is pre-signed and is fetched with no credential at all.
 */
import { type ByteUrl, driveByteUrl, onedriveByteUrl, photosByteUrl } from "./cloud-renditions.ts";
import type { MediaCandidate, SkipReason } from "./media-types.ts";

export interface CloudUrlResolverDeps {
  readonly bearerFor: (service: string) => Promise<string | null>;
  readonly fetchFn: (url: string, init: RequestInit) => Promise<Response>;
}

export type ResolvedByteUrl = ByteUrl | { readonly error: SkipReason };

/** Narrows an untyped JSON body without an assertion — external data is `unknown` (no-`any` rule). */
function stringField(body: unknown, key: string): string | null {
  if (typeof body !== "object" || body === null) return null;
  const v = (body as Record<string, unknown>)[key];
  return typeof v === "string" && v !== "" ? v : null;
}

export async function resolveCloudByteUrl(
  candidate: MediaCandidate,
  preferRenditions: boolean,
  deps: CloudUrlResolverDeps,
): Promise<ResolvedByteUrl> {
  if (candidate.service === "google_drive") {
    return driveByteUrl(candidate.externalId);
  }

  if (candidate.service !== "google_photos" && candidate.service !== "onedrive") {
    return { error: "unresolvable_modality" };
  }

  const token = await deps.bearerFor(candidate.service);
  if (token === null) return { error: "not_configured" };

  const id = encodeURIComponent(candidate.externalId);
  const url =
    candidate.service === "google_photos"
      ? `https://photoslibrary.googleapis.com/v1/mediaItems/${id}`
      : `https://graph.microsoft.com/v1.0/me/drive/items/${id}`;

  const res = await deps.fetchFn(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return { error: res.status === 429 ? "rate_limited" : "fetch_miss" };

  const body: unknown = await res.json();
  if (candidate.service === "google_photos") {
    const baseUrl = stringField(body, "baseUrl");
    return baseUrl === null
      ? { error: "fetch_miss" }
      : photosByteUrl(baseUrl, candidate.modality, preferRenditions);
  }

  const downloadUrl = stringField(body, "@microsoft.graph.downloadUrl");
  return downloadUrl === null ? { error: "fetch_miss" } : onedriveByteUrl(downloadUrl);
}
