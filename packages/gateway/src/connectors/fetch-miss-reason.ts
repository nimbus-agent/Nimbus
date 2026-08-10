// packages/gateway/src/connectors/fetch-miss-reason.ts

import type { FetchOneResult } from "../sync/types.ts";

/**
 * The single status→outcome mapper every connector's `fetchOne` uses for a
 * non-2xx response. One mapper, five callers, so the connectors cannot drift.
 *
 * Takes a status code and nothing else — no `Response`, no body, no URL — so no
 * provider text can leak through it.
 *
 * KNOWN BOUND: GitHub also returns 403 for secondary rate limits, so
 * `unauthorized` will occasionally mean "throttled". Disambiguating needs
 * `x-ratelimit-remaining` inspection; left unsolved rather than half-solved.
 *
 * NOTE the deliberate divergence from `connectors/credential-probe.ts`, where
 * 403 does NOT reject. Fetching a specific item, a 403 means the user cannot
 * have it either way. Verifying a credential, a 403 proves it authenticated.
 */
export function fetchOneMissForResponse(httpStatus: number): FetchOneResult {
  if (httpStatus === 401 || httpStatus === 403) {
    return { status: "not_found", reason: "unauthorized" };
  }
  if (httpStatus === 404) {
    return { status: "not_found", reason: "absent" };
  }
  if (httpStatus === 429) {
    return { status: "rate_limited" };
  }
  return { status: "not_found", reason: "upstream_error" };
}
