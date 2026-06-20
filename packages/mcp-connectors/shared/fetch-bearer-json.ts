export type BearerJsonFetchResult = {
  ok: boolean;
  status: number;
  json: unknown;
  text: string;
};

/**
 * Resolve a path-or-URL against `baseUrl`. A relative path is prefixed with the
 * base. An ABSOLUTE URL is only allowed when it shares the base's origin — this
 * is the single chokepoint that prevents a caller-supplied pagination link
 * (`@odata.nextLink`, etc.) from redirecting a credential-bearing fetch at an
 * attacker-controlled host (SSRF / bearer-token exfiltration). A cross-origin or
 * malformed absolute URL throws and is never fetched.
 */
export function resolveUrlWithBase(baseUrl: string, pathOrUrl: string): string {
  if (!pathOrUrl.startsWith("http")) {
    return `${baseUrl}${pathOrUrl}`;
  }
  const target = new URL(pathOrUrl);
  const base = new URL(baseUrl);
  if (target.origin !== base.origin) {
    throw new Error(
      `resolveUrlWithBase: refusing to fetch cross-origin URL (got ${target.origin}, expected ${base.origin})`,
    );
  }
  return pathOrUrl;
}

export async function fetchBearerAuthorizedJson(
  url: string,
  token: string,
  init?: RequestInit,
  defaultHeaders?: Record<string, string>,
): Promise<BearerJsonFetchResult> {
  const mergedHeaders = new Headers({
    Authorization: `Bearer ${token}`,
    ...defaultHeaders,
  });
  if (init?.headers !== undefined) {
    const extra = new Headers(init.headers);
    for (const [k, v] of extra) {
      mergedHeaders.set(k, v);
    }
  }
  const res = await fetch(url, {
    ...init,
    headers: mergedHeaders,
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json, text };
}
