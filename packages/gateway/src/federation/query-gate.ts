import type { Database } from "bun:sqlite";
import { buildItemListSql } from "../index/item-list-query.ts";
import { enforceCommonGate } from "./_lib/gate-commons.ts";
import type { SessionConsentCache } from "./consent-cache.ts";
import { appendFederationAudit } from "./federation-audit.ts";
import type { NamespaceStore } from "./namespace-store.ts";
import type {
  FederatedItem,
  FederatedQueryRequest,
  FederatedQueryResponse,
  FederationDecision,
  FederationWireError,
} from "./types.ts";

export type ConsentDecision = "approved" | "denied" | "timeout";
export type ConsentPrompter = (input: {
  peerId: string;
  namespace: string;
  purpose: string;
  role: string;
}) => Promise<ConsentDecision>;

export interface QueryGateCtx {
  readonly db: Database;
  readonly store: NamespaceStore;
  readonly consentCache: SessionConsentCache;
  readonly prompt: ConsentPrompter;
  readonly consentTimeoutMs: number;
  readonly now?: () => number;
  /** I18: when identity is enabled, the answerer's own operator identity must be valid to federate. */
  readonly identity?: { readonly enabled: boolean; readonly isOperatorValid: () => boolean };
}

export interface InboundQuery {
  readonly peerId: string;
  readonly request: FederatedQueryRequest;
}

export type AnswerResult =
  | { readonly kind: "ok"; readonly response: FederatedQueryResponse }
  | { readonly kind: "error"; readonly error: FederationWireError };

const SNIPPET_MAX = 280;
const DEFAULT_LIMIT = 50;

interface ItemRow {
  id: string;
  service: string;
  type: string;
  title: string;
  body_preview: string | null;
  modified_at: number;
}

/** Maps ONLY the safe columns — `metadata`/`author_id`/`external_id` are never copied out. */
function toFederatedItem(r: ItemRow): FederatedItem {
  return {
    id: r.id,
    service: r.service,
    type: r.type,
    title: r.title,
    snippet: (r.body_preview ?? "").slice(0, SNIPPET_MAX),
    modifiedAt: r.modified_at,
  };
}

function audit(ctx: QueryGateCtx, q: InboundQuery, decision: FederationDecision): void {
  const nowMs = (ctx.now ?? Date.now)();
  appendFederationAudit(ctx.db, {
    peerId: q.peerId,
    namespace: q.request.namespace,
    purpose: q.request.purpose,
    decision,
    method: "federation.query",
    timestamp: nowMs,
  });
}

/** An in-scope query that resolves to zero shareable rows. Audited as "answered" so an empty
 *  result is shape-identical whether it's "no matches" or "you asked for undeclared types" —
 *  the requester can't distinguish the two (no leak of what exists outside the declared scope). */
function emptyAnswer(ctx: QueryGateCtx, q: InboundQuery): AnswerResult {
  audit(ctx, q, "answered");
  return { kind: "ok", response: { items: [] } };
}

/** Leak-proof effective-type computation. Returns the type filter to compile into the read, or
 *  undefined when the peer requested ONLY undeclared types (caller must answer empty — never
 *  reveal those items exist). [] means "unrestricted within declared services". */
function computeEffectiveTypes(
  declaredTypes: readonly string[],
  requested: readonly string[] | undefined,
): readonly string[] | undefined {
  if (requested === undefined) {
    // No peer narrowing: share the declared types. [] here means "unrestricted within declared services".
    return declaredTypes;
  }
  if (declaredTypes.length === 0) {
    // Namespace places no type restriction: narrow to exactly what the peer asked for.
    return requested;
  }
  // Namespace restricts types: intersect requested with declared.
  const intersected = declaredTypes.filter((t) => requested.includes(t));
  return intersected.length === 0 ? undefined : intersected;
}

/**
 * I17 — the ONLY path that answers an inbound federated query. Enforces grant + role + consent +
 * the namespace's declared filter; returns only declared item types as FederatedItem; audits every outcome.
 */
export async function answerFederatedQuery(
  ctx: QueryGateCtx,
  q: InboundQuery,
): Promise<AnswerResult> {
  // I17/I18 preamble: identity check → namespace-exists → active-grant → consent.
  const preambleError = await enforceCommonGate(
    ctx,
    { peerId: q.peerId, namespace: q.request.namespace, purpose: q.request.purpose },
    "federation.query",
  );
  if (preambleError !== undefined) {
    return preambleError;
  }

  // --- LEAK-PROOF SCOPE COMPILATION ---
  // Compile ONLY the namespace's declared filters into the read. CAUTION: buildItemListSql treats
  // an empty `types` array as "no type filter" (returns every type in the declared services), so an
  // empty effective type set must be handled here, NOT passed through, or we'd leak undeclared items.
  const declaredServices = ctx.store.declaredServices(q.request.namespace);
  const declaredTypes = ctx.store.declaredTypes(q.request.namespace);

  const effectiveTypes = computeEffectiveTypes(declaredTypes, q.request.types);
  if (effectiveTypes === undefined) {
    // Peer requested ONLY undeclared types -> empty (never reveal those items exist).
    return emptyAnswer(ctx, q);
  }

  // Safety: a read with NO service filter AND NO type filter is an unconstrained full-index dump.
  // A namespace must declare at least one constraining filter to share anything.
  if (declaredServices.length === 0 && effectiveTypes.length === 0) {
    return emptyAnswer(ctx, q);
  }

  const { sql, vals } = buildItemListSql({
    services: declaredServices,
    types: effectiveTypes,
    limit: q.request.limit ?? DEFAULT_LIMIT,
  });
  const rows = ctx.db.query<ItemRow, Array<string | number>>(sql).all(...vals);
  const items = rows.map(toFederatedItem);

  audit(ctx, q, "answered");
  return { kind: "ok", response: { items } };
}
