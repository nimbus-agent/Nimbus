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
  /**
   * MUST NOT follow a redirect on its own — this module calls it with `redirect: "manual"` for
   * exactly that reason, on the one request that carries a credential (the Photos/OneDrive
   * round-trip). A `fetchFn` that re-issues the request against a `Location` header would hand
   * that bearer to whatever host the provider named next — the same attack shape this module
   * exists to prevent, just one hop later. The production caller is `util/safe-fetch.ts`'s
   * `safeFetchFollowing`, which already forces manual redirects and strips credentials
   * cross-origin; this states that requirement rather than inventing new behaviour.
   */
  readonly fetchFn: (url: string, init: RequestInit) => Promise<Response>;
}

export type ResolvedByteUrl = ByteUrl | { readonly error: SkipReason };

/**
 * Reads one field off an untyped JSON body. The `typeof`/`null` check on `body` is what makes the
 * `Record<string, unknown>` cast below it safe, and the caller only gets a value back once its own
 * type is verified too — a runtime-checked narrow, not a bare type assertion trusted on faith
 * (external data is `unknown`, never `any`).
 */
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

  let body: unknown;
  try {
    const res = await deps.fetchFn(url, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "manual",
    });
    if (!res.ok) return { error: res.status === 429 ? "rate_limited" : "fetch_miss" };
    body = await res.json();
  } catch {
    // A transport failure, or a 200 whose body is not JSON at all (a proxy interception, an HTML
    // error page) — either way the round-trip did not produce a usable answer, and there is
    // nothing left to trust it with.
    return { error: "fetch_miss" };
  }

  if (candidate.service === "google_photos") {
    const baseUrl = stringField(body, "baseUrl");
    return baseUrl === null
      ? { error: "fetch_miss" }
      : photosByteUrl(baseUrl, candidate.modality, preferRenditions);
  }

  const downloadUrl = stringField(body, "@microsoft.graph.downloadUrl");
  return downloadUrl === null ? { error: "fetch_miss" } : onedriveByteUrl(downloadUrl);
}
