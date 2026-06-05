import type { Database } from "bun:sqlite";
import { federationConsent } from "../federation/consent-broker.ts";
import { SessionConsentCache } from "../federation/consent-cache.ts";
import type { DiscoveryProvider } from "../federation/discovery.ts";
import { scoreExpertise } from "../federation/expertise.ts";
import { NamespaceStore } from "../federation/namespace-store.ts";
import type { PeerPairing } from "../federation/peer-pairing.ts";
import type { ConsentPrompter } from "../federation/query-gate.ts";
import { answerFederatedQuery } from "../federation/query-gate.ts";
import type {
  ExpertiseRequest,
  FederatedQueryRequest,
  FederationRole,
  NamespaceFilter,
} from "../federation/types.ts";
import { dispatchByMethod, type RpcMissOrHit } from "./_lib/dispatch-by-method.ts";

export class FederationRpcError extends Error {
  readonly rpcCode: number;
  constructor(rpcCode: number, message: string) {
    super(message);
    this.name = "FederationRpcError";
    this.rpcCode = rpcCode;
  }
}

export interface FederationRpcContext {
  readonly db: Database;
  readonly consentTimeoutMs: number;
  readonly notify: (method: string, params: unknown) => void;
  readonly discovery: DiscoveryProvider;
  readonly pairing: PeerPairing;
}

// One session-scoped consent cache per process. Shared across calls (the dispatcher is per-call).
const sessionConsent = new SessionConsentCache();

function asRecord(params: unknown): Record<string, unknown> {
  if (params === null || typeof params !== "object") {
    throw new FederationRpcError(-32602, "ERR_INVALID_PARAMS: object expected");
  }
  return params as Record<string, unknown>;
}

function requireString(rec: Record<string, unknown>, key: string): string {
  const v = rec[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new FederationRpcError(-32602, `ERR_INVALID_PARAMS: ${key} must be a non-empty string`);
  }
  return v;
}

function parseFilters(raw: unknown): NamespaceFilter[] {
  if (!Array.isArray(raw)) throw new FederationRpcError(-32602, "ERR_INVALID_PARAMS: filters[]");
  return raw.map((f) => {
    const r = asRecord(f);
    const kind = requireString(r, "kind");
    if (kind !== "service" && kind !== "type" && kind !== "tag") {
      throw new FederationRpcError(-32602, `ERR_INVALID_PARAMS: bad filter kind ${kind}`);
    }
    return { kind, value: requireString(r, "value") };
  });
}

/** Routes consent round-trips through the broker singleton.
 *  The broker broadcasts federation.consentRequest itself (via its setBroadcast channel) and
 *  resolves when the owner calls federation.consentRespond.
 *  The broker TTL is longer than the gate's own consentTimeoutMs so the gate's
 *  timeout (→ timeout_waiting_for_consent) wins on no-response; the broker TTL is a belt-and-
 *  suspenders cleanup, never the primary timer. */
function makePrompter(ctx: FederationRpcContext): ConsentPrompter {
  return (input) => federationConsent.request(input, ctx.consentTimeoutMs + 5000);
}

export async function dispatchFederationRpc(
  method: string,
  params: unknown,
  ctx: FederationRpcContext,
): Promise<RpcMissOrHit> {
  const store = new NamespaceStore(ctx.db);
  return dispatchByMethod<FederationRpcContext>(method, params, ctx, {
    "federation.discover": async () => {
      const peers = await ctx.discovery.list();
      return { peers };
    },
    "federation.peers": () => {
      return { peers: ctx.pairing.listPeers() };
    },
    "federation.pair": async (p) => {
      const rec = asRecord(p);
      const host = requireString(rec, "host");
      const code = requireString(rec, "code");
      const port = typeof rec["port"] === "number" ? rec["port"] : 7475;
      const peerId = await ctx.pairing.initiatePair(host, port, code);
      return { peerId };
    },
    "federation.namespace.publish": (p) => {
      const rec = asRecord(p);
      const name = requireString(rec, "name");
      const def = store.publish(name, parseFilters(rec["filters"]));
      return { namespace: def.name, filters: def.filters };
    },
    "federation.namespace.grant": (p) => {
      const rec = asRecord(p);
      const role = requireString(rec, "role");
      if (role !== "owner" && role !== "editor" && role !== "viewer") {
        throw new FederationRpcError(-32602, `ERR_INVALID_PARAMS: bad role ${role}`);
      }
      const narrowedRole: FederationRole = role;
      store.grant(
        requireString(rec, "namespace"),
        requireString(rec, "peerId"),
        narrowedRole,
        rec["standingConsent"] === true,
      );
      return { ok: true };
    },
    "federation.namespace.revoke": (p) => {
      const rec = asRecord(p);
      const namespace = requireString(rec, "namespace");
      store.revoke(namespace, requireString(rec, "peerId"));
      // Revocation invalidates any cached session consent immediately (acceptance criterion 4).
      sessionConsent.invalidateNamespace(namespace);
      return { ok: true };
    },
    "federation.query": async (p) => {
      const rec = asRecord(p);
      const request: FederatedQueryRequest = {
        namespace: requireString(rec, "namespace"),
        purpose: requireString(rec, "purpose"),
        ...(Array.isArray(rec["types"])
          ? { types: rec["types"].filter((t): t is string => typeof t === "string") }
          : {}),
      };
      return answerFederatedQuery(
        {
          db: ctx.db,
          store,
          consentCache: sessionConsent,
          prompt: makePrompter(ctx),
          consentTimeoutMs: ctx.consentTimeoutMs,
        },
        { peerId: requireString(rec, "peerId"), request },
      );
    },
    "federation.consentRespond": (p) => {
      const rec = asRecord(p);
      const requestId = requireString(rec, "requestId");
      if (typeof rec["approved"] !== "boolean") {
        throw new FederationRpcError(-32602, "ERR_INVALID_PARAMS: approved must be a boolean");
      }
      const matched = federationConsent.respond(requestId, rec["approved"]);
      return { ok: true, matched };
    },
    "federation.expertise": (p) => {
      const rec = asRecord(p);
      const req: ExpertiseRequest = {
        query: requireString(rec, "query"),
        purpose: requireString(rec, "purpose"),
      };
      return scoreExpertise(ctx.db, req);
    },
  });
}
