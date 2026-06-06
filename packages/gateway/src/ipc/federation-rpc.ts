import type { Database } from "bun:sqlite";
import { delegatedApprovalBroker } from "../engine/delegated-approval-broker.ts";
import { quorumCoordinator } from "../engine/quorum/quorum-singleton.ts";
import { federationConsent } from "../federation/consent-broker.ts";
import { SessionConsentCache } from "../federation/consent-cache.ts";
import type { DiscoveryProvider } from "../federation/discovery.ts";
import { scoreExpertise } from "../federation/expertise.ts";
import { answerFederatedInvoke } from "../federation/invoke-gate.ts";
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
import type { LanPeerRow, LocalIndex } from "../index/local-index.ts";
import { TeamVaultStore } from "../teamvault/team-vault-store.ts";
import { dispatchByMethod, type RpcMissOrHit } from "./_lib/dispatch-by-method.ts";
import { sendFederatedOverWire } from "./lan-client.ts";
import type { BoxKeypair } from "./lan-crypto.ts";

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
  // Asker-side over-the-wire client deps (present only on the local dispatch path):
  readonly index?: LocalIndex;
  readonly selfIdentity?: BoxKeypair;
  // I18: when identity is enabled, the answerer's own operator identity must be valid to federate.
  readonly identityGuard?: { enabled: boolean; isOperatorValid: () => boolean };
  // Team Vault (Slice 2). Present on the answering (anchor) dispatch path.
  readonly teamVault?: {
    readonly quorumFor: (
      toolId: string,
    ) => { approvers: number; windowSeconds: number } | undefined;
    readonly runTool: (input: {
      entry: string;
      service: string;
      toolId: string;
      args: unknown;
    }) => Promise<unknown>;
  };
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

/** Locate the paired peer (host/port/pubkey) the asker should send to, asserting the
 *  asker-side deps (index + identity) are wired. Used by federation.ask / askExpertise. */
function requireAskTarget(
  ctx: FederationRpcContext,
  rec: Record<string, unknown>,
): { row: LanPeerRow; selfIdentity: BoxKeypair } {
  if (ctx.index === undefined || ctx.selfIdentity === undefined) {
    throw new FederationRpcError(
      -32603,
      "ERR_FEDERATION_ASKER_UNAVAILABLE: index/identity not wired",
    );
  }
  const peerId = requireString(rec, "peerId");
  const row = ctx.index.listLanPeers().find((r) => r.peer_id === peerId);
  if (row === undefined) {
    throw new FederationRpcError(-32602, `ERR_UNKNOWN_PEER: ${peerId}`);
  }
  if (row.host_ip === null || row.host_port === null) {
    throw new FederationRpcError(-32602, `ERR_UNKNOWN_PEER: ${peerId} has no host address`);
  }
  return { row, selfIdentity: ctx.selfIdentity };
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
          ...(ctx.identityGuard === undefined ? {} : { identity: ctx.identityGuard }),
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
    // Asker-side: look up the paired peer and send the federated query OVER THE WIRE.
    "federation.ask": async (p) => {
      const rec = asRecord(p);
      const { row, selfIdentity } = requireAskTarget(ctx, rec);
      const body: Record<string, unknown> = {
        namespace: requireString(rec, "namespace"),
        purpose: requireString(rec, "purpose"),
        ...(Array.isArray(rec["types"])
          ? { types: rec["types"].filter((t): t is string => typeof t === "string") }
          : {}),
      };
      return sendFederatedOverWire(
        row.host_ip as string,
        row.host_port as number,
        selfIdentity,
        row.peer_pubkey,
        "federation.query",
        body,
      );
    },
    // Asker-side: send the content-free expertise probe OVER THE WIRE.
    "federation.askExpertise": async (p) => {
      const rec = asRecord(p);
      const { row, selfIdentity } = requireAskTarget(ctx, rec);
      return sendFederatedOverWire(
        row.host_ip as string,
        row.host_port as number,
        selfIdentity,
        row.peer_pubkey,
        "federation.expertise",
        { query: requireString(rec, "query"), purpose: requireString(rec, "purpose") },
      );
    },
    // Anchor-side: a teammate asks the trust anchor to run a named team-vault tool. The secret is
    // injected inside teamVault.runTool (never in this scope); I19 gate enforces RBAC + quorum.
    "federation.invoke": async (p) => {
      const rec = asRecord(p);
      if (ctx.teamVault === undefined) {
        throw new FederationRpcError(-32603, "ERR_TEAMVAULT_UNAVAILABLE: not the trust anchor");
      }
      const tv = ctx.teamVault;
      return answerFederatedInvoke(
        {
          db: ctx.db,
          store: new TeamVaultStore(ctx.db),
          quorumFor: tv.quorumFor,
          runQuorum: (rule) =>
            quorumCoordinator.collect({
              approvers: rule.approvers,
              windowMs: rule.windowSeconds * 1000,
            }),
          runTool: tv.runTool,
          ...(ctx.identityGuard === undefined ? {} : { identity: ctx.identityGuard }),
        },
        {
          peerId: requireString(rec, "peerId"),
          entry: requireString(rec, "entry"),
          toolId: requireString(rec, "toolId"),
          purpose: requireString(rec, "purpose"),
          args: rec["args"],
        },
      );
    },
    // Quorum approver's response (over the wire) → feeds the QuorumCoordinator singleton.
    "federation.quorumRespond": (p) => {
      const rec = asRecord(p);
      if (typeof rec["approved"] !== "boolean") {
        throw new FederationRpcError(-32602, "ERR_INVALID_PARAMS: approved must be a boolean");
      }
      const matched = quorumCoordinator.respond(
        requireString(rec, "requestId"),
        requireString(rec, "peerId"),
        rec["approved"],
      );
      return { ok: true, matched };
    },
    // Delegate's approval response (over the wire) → feeds the delegated-approval broker singleton.
    "federation.approvalRespond": (p) => {
      const rec = asRecord(p);
      if (typeof rec["approved"] !== "boolean") {
        throw new FederationRpcError(-32602, "ERR_INVALID_PARAMS: approved must be a boolean");
      }
      const matched = delegatedApprovalBroker.respond(
        requireString(rec, "requestId"),
        requireString(rec, "peerId"),
        rec["approved"],
      );
      return { ok: true, matched };
    },
  });
}
