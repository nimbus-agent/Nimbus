import type { Database } from "bun:sqlite";
import { digestEgressWindow, signWindowDigest } from "../../egress/egress-sign.ts";
import {
  countEgressRows,
  egressHead,
  listEgress,
  proveWindow,
  verifyEgressChain,
} from "../../egress/egress-verify.ts";
import type { HttpWriteRateLimiter } from "../http-rate-limit.ts";
import {
  type ClipReadRouteKey,
  ROUTE_KEY_EGRESS_HEAD,
  ROUTE_KEY_EGRESS_LIST,
  ROUTE_KEY_EGRESS_PROVE,
  ROUTE_KEY_EGRESS_VERIFY,
} from "../http-route-auth.ts";
import { intParam, json, requireScopedSurface, type ScopedSurfaceGate } from "./_shared.ts";
import type { ReadOnlyHttpServerOptions } from "./options.ts";

/**
 * The four egress-ledger reads share a gate: the clips surface must be mounted, and the token must
 * carry the `egress` scope.
 *
 * Mounted HERE — in the bearer-authed fetch handler — and NOT in `dispatchReadOnlyDataGet`, for the
 * same reason `handleItemsResolve` is: that table's "/v1/items/*" entry is PUBLIC, with no bearer
 * gate at all, so routing these through it would serve the record of everything this gateway ever
 * sent to any local process on the machine. The ledger is strictly more sensitive than resolve.
 *
 * None of the four appends an egress row. They read the ledger; a read that ledgered itself would
 * inflate the very number it exists to report.
 */
function requireEgressRead(
  req: Request,
  opts: ReadOnlyHttpServerOptions,
  routeKey: ClipReadRouteKey,
): Promise<ScopedSurfaceGate> {
  // A named 404, never a fall-through to the public /v1/items/* table.
  return requireScopedSurface(req, opts, routeKey, () => json({ error: "egress_disabled" }, 404));
}

// GET /v1/egress — a page of the ledger, newest first, with the window's counted totals.
export async function handleEgressList(
  req: Request,
  url: URL,
  db: Database,
  opts: ReadOnlyHttpServerOptions,
): Promise<Response> {
  const gate = await requireEgressRead(req, opts, ROUTE_KEY_EGRESS_LIST);
  if (!gate.ok) return gate.response;
  const window = { since: intParam(url, "since"), until: intParam(url, "until") };
  const rows = listEgress(db, {
    ...window,
    order: "desc",
    limit: intParam(url, "limit"),
    before: intParam(url, "before"),
  });
  // Counted in SQL over the WHOLE window — never derived from `rows`, which is a page. Deriving it
  // would under-report, and is the failure `countOutboundEgress` was written to end.
  const rowsTotal = countEgressRows(db, window);
  return json({ rows, rowsTotal, rowsTruncated: rows.length < rowsTotal });
}

// GET /v1/egress/head — the chain head and the row count.
export async function handleEgressHead(
  req: Request,
  db: Database,
  opts: ReadOnlyHttpServerOptions,
): Promise<Response> {
  const gate = await requireEgressRead(req, opts, ROUTE_KEY_EGRESS_HEAD);
  if (!gate.ok) return gate.response;
  return json(egressHead(db));
}

// GET /v1/egress/verify — walk the chain and report. Passed through unchanged: `brokenAt` and
// `reason` are the gateway's own vocabulary, and a client must not have to guess at a re-spelling.
export async function handleEgressVerify(
  req: Request,
  db: Database,
  opts: ReadOnlyHttpServerOptions,
): Promise<Response> {
  const gate = await requireEgressRead(req, opts, ROUTE_KEY_EGRESS_VERIFY);
  if (!gate.ok) return gate.response;
  return json(verifyEgressChain(db));
}

/**
 * `prove`'s own budget — the only one of the four egress reads that does asymmetric crypto per
 * call (`signWindowDigest` signs with the Vault share key). List, head and verify are SQLite reads.
 *
 * Its OWN limiter instance rather than the write surface's, so a hot prove loop cannot starve clip
 * ingest of its 60/min, and so a busy clipper cannot make proving fail. The fingerprint is a
 * constant, matching how the write surface buckets its routes (`http-write-routes.ts` checkAuth) —
 * this is a per-route budget, not a per-token one.
 */
export const PROVE_RATE_LIMIT = { maxRequests: 10, windowMs: 60_000 } as const;
const PROVE_FINGERPRINT = "egress-prove";

// GET /v1/egress/prove — the signed window receipt.
export async function handleEgressProve(
  req: Request,
  url: URL,
  db: Database,
  opts: ReadOnlyHttpServerOptions,
  proveRateLimiter: HttpWriteRateLimiter,
): Promise<Response> {
  const gate = await requireEgressRead(req, opts, ROUTE_KEY_EGRESS_PROVE);
  if (!gate.ok) return gate.response;
  // After the scope gate, deliberately: an unauthorized caller must not be able to spend the
  // budget of an authorized one.
  const rate = proveRateLimiter.check(PROVE_FINGERPRINT);
  if (!rate.allowed) {
    return json(
      { error: "rate_limited", retryAfterMs: Math.max(0, rate.resetMs - Date.now()) },
      429,
    );
  }
  const proof = proveWindow(db, { since: intParam(url, "since"), until: intParam(url, "until") });
  const digest = digestEgressWindow(proof.rows, {
    outboundEgressEvents: proof.completeness.outboundEgressEvents,
    rowsTotal: proof.rowsTotal,
  });
  const { sigB64, pubkeyB64 } = await signWindowDigest(gate.clipsVault, digest);
  return json({
    digest,
    sigB64,
    pubkeyB64,
    rowsTotal: proof.rowsTotal,
    rowsTruncated: proof.rowsTruncated,
    completeness: proof.completeness,
    verify: proof.verify,
  });
}
