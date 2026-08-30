import type { Database } from "bun:sqlite";
import { type CuResourceType, decideRequest, originOf } from "../computer-use/cu-request-policy.ts";
import type { CuBrowserTarget } from "../computer-use/cu-types.ts";
import { appendEgressEntry } from "./egress-ledger.ts";

export class EgressAppendFailedError extends Error {
  constructor(cause: unknown) {
    super(`egress append failed: ${String(cause)}`);
    this.name = "EgressAppendFailedError";
  }
}

/** Structural shapes, so this module needs no driver import and tests without a browser. */
export interface LedgerableRoute {
  request(): { url(): string; resourceType(): string };
  continue(): Promise<void>;
  abort(): Promise<void>;
}
export interface LedgerableContext {
  route(pattern: string, handler: (route: LedgerableRoute) => Promise<void>): Promise<void>;
}

export interface BrowserEgressDeps {
  readonly db: Database;
  readonly sessionId: string;
  readonly target: CuBrowserTarget;
  readonly now: () => number;
}

/**
 * The `browser`-class I29 appender: a DECORATOR over the browser context, not a call-site append.
 *
 * Same shape as `wrapLedgeredProvider` (I34/D22(e)) and `wrapLedgeredEmbedder` (D22(f)), for the
 * same reason: a call-site append covers the callers that exist today, whereas wrapping the
 * INSTANCE covers every caller including ones written later, without any of them cooperating.
 *
 * ONE ROW PER (ORIGIN, VERDICT), not per request — `per-run` granularity (see `egress-coverage.ts`).
 * A page load makes hundreds of requests to a handful of origins; a row each would bury the ledger,
 * while a single row naming only the origin the owner typed would understate where data went. The
 * key is the PAIR, not the origin alone: a later BLOCKED request to an origin that was previously
 * ALLOWED still gets its own row, since a cluster of blocked rows naming an unapproved origin is
 * the clearest signal that something is steering the page toward exfiltration.
 *
 * FAIL-CLOSED: the row is appended BEFORE the request is allowed to continue, and an append failure
 * throws rather than proceeding. A zero-row window therefore means no request was made, never that
 * one was made unrecorded.
 *
 * `destination` is the ORIGIN, never the full URL, matching `summarizeDestination`'s rule that no
 * secret-bearing query string is ever stored. `payload_summary` carries the resource type and the
 * policy's reason — never the URL, never a body.
 */
export function wrapLedgeredBrowserContext(
  ctx: LedgerableContext,
  deps: BrowserEgressDeps,
): LedgerableContext {
  const seenOrigins = new Set<string>();

  return {
    route: async (pattern, _handler) => {
      await ctx.route(pattern, async (route) => {
        const req = route.request();
        const url = req.url();
        const resourceType = req.resourceType() as CuResourceType;
        const verdict = decideRequest({ resourceType, url, target: deps.target });
        const destination = originOf(url) ?? "unparseable";

        // Dedupe per (origin, verdict): a blocked origin must still surface even if the same origin
        // was previously allowed for a passive subresource, since the blocked row is the signal.
        const key = `${destination}|${verdict.allow ? "a" : "b"}`;
        if (!seenOrigins.has(key)) {
          seenOrigins.add(key);
          try {
            appendEgressEntry(deps.db, {
              timestamp: deps.now(),
              sourceType: "browser",
              sourceId: deps.sessionId,
              destination,
              method: "browser.request",
              payloadSummary: `${resourceType}: ${verdict.reason}`,
              // "not_required", matching every other decorator-style appender in this file's
              // family (model/embedding/chatops/sync egress) — none of these route through the
              // I2 HITL frozen set per call, and the per-request origin decision here is made by
              // `decideRequest` against the envelope's already-approved target, not by a fresh
              // consent prompt. "approved" is reserved for a row that RECORDS an I2 gate decision
              // made on that exact path (I4's earned-set rule); no such gate exists in this file.
              hitlStatus: "not_required",
              resultStatus: verdict.allow ? "authorized" : "blocked",
            });
          } catch (e) {
            // Do NOT continue the request. This is the property the whole class rests on.
            throw new EgressAppendFailedError(e);
          }
        }

        if (verdict.allow) await route.continue();
        else await route.abort();
      });
    },
  };
}
