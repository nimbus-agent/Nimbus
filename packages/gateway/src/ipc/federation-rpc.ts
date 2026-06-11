import type { Database } from "bun:sqlite";
import { appendAuditEntry } from "../db/audit-chain.ts";
import { delegatedApprovalBroker } from "../engine/delegated-approval-broker.ts";
import { quorumCoordinator } from "../engine/quorum/quorum-singleton.ts";
import type { FederationAuditEntry } from "../federation/audit-export.ts";
import { answerFederatedAuditExport, exportFederationAudit } from "../federation/audit-export.ts";
import { mergeTeamAudit, type PeerAuditStream } from "../federation/audit-merge.ts";
import { federationConsent } from "../federation/consent-broker.ts";
import { SessionConsentCache } from "../federation/consent-cache.ts";
import type { DiscoveryProvider } from "../federation/discovery.ts";
import { scoreExpertise } from "../federation/expertise.ts";
import { answerFederatedInvoke } from "../federation/invoke-gate.ts";
import { NamespaceStore } from "../federation/namespace-store.ts";
import type { PeerPairing } from "../federation/peer-pairing.ts";
import { preflightConsent } from "../federation/preflight-consent-broker.ts";
import { answerFederatedPreflight, type PreflightGateCtx } from "../federation/preflight-gate.ts";
import type { ConsentPrompter } from "../federation/query-gate.ts";
import { answerFederatedQuery } from "../federation/query-gate.ts";
import { probeResourceRecency } from "../federation/resource-probe.ts";
import type {
  ExpertiseRequest,
  FederatedQueryRequest,
  FederationRole,
  NamespaceFilter,
} from "../federation/types.ts";
import { KnownNamespaceStore } from "../index/known-namespace-store.ts";
import type { LanPeerRow, LocalIndex } from "../index/local-index.ts";
import { type DeletionRecord, signDeletionRecord } from "../policy/deletion-record.ts";
import { servePolicy } from "../policy/policy-distribution.ts";
import { PolicyStore } from "../policy/policy-store.ts";
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
  // DI seam: injected in tests to replace the real sendFederatedOverWire (avoids mock.module).
  readonly sendOverWire?: typeof sendFederatedOverWire;
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
  // Delegated HITL (Slice 2, I20). Present on the answering (delegate) dispatch path: the delegate's
  // local decision for an owner's routed approval. The handler audits the decision on the DELEGATE's
  // gateway; absent → fail-closed deny.
  readonly delegateApproval?: (req: {
    actionType: string;
    ownerPeerId: string;
  }) => Promise<boolean>;
  // GDPR purge serve (Slice 4, spec D11). When peer A purges a user, it sends federation.purge
  // {externalId} to this gateway (peer B). HITL is STRUCTURAL: we NEVER auto-delete on receipt — we
  // ask THIS gateway's LOCAL operator to approve first (via the consent broker, the same local-human
  // round-trip federation.query uses). On approval we delete that user's local contributions and
  // return a record signed with the gateway's Ed25519 anchor key; on denial/timeout we delete
  // nothing. `purgeSign` threads the signer (privkey seed + peerId), `deletePurgeContributions`
  // threads the concrete local-delete (Task 26 wires the real accessor; default 0 = nothing deleted).
  readonly purgeSign?: { privkeyB64: string; selfPeerId: string };
  readonly deletePurgeContributions?: (externalId: string, peerId: string) => number;
  // I24 (Slice 6b). Present on the answering path: the downstream preflight gate's deps (the LOCAL
  // command resolver + HITL approval + sandbox runner + audit). `identity` is supplied separately
  // from `identityGuard`. Absent → federation.preflight fails closed (ERR_PREFLIGHT_UNAVAILABLE).
  readonly preflight?: Omit<PreflightGateCtx, "identity">;
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

/** Narrow an over-the-wire federation.auditExport result to its entries, or undefined on
 *  an error/non-ok/malformed shape (the peer denied, or sent something unexpected → skip it). */
function extractAuditEntries(result: unknown): FederationAuditEntry[] | undefined {
  if (result === null || typeof result !== "object") return undefined;
  const r = result as { kind?: unknown; entries?: unknown };
  if (r.kind !== "ok" || !Array.isArray(r.entries)) return undefined;
  const out: FederationAuditEntry[] = [];
  for (const e of r.entries) {
    if (e === null || typeof e !== "object") return undefined;
    const rec = e as Record<string, unknown>;
    if (
      typeof rec["actionType"] !== "string" ||
      typeof rec["hitlStatus"] !== "string" ||
      typeof rec["hash"] !== "string" ||
      typeof rec["timestamp"] !== "number"
    ) {
      return undefined;
    }
    out.push({
      actionType: rec["actionType"],
      hitlStatus: rec["hitlStatus"],
      hash: rec["hash"],
      timestamp: rec["timestamp"],
    });
  }
  return out;
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
    // Anchor/answerer-side: serve THIS gateway's FEDERATION-only, METADATA-only audit slice so the
    // team can build a merged audit view. Leak-proof — only `federation.%` action types, NEVER
    // `action_json`. Consent-gated IDENTICALLY to federation.query (I18 identity guard → namespace
    // grant → standing/cached/prompted consent) via answerFederatedAuditExport; fail-closed on any
    // unmet gate. `peerId` is the NaCl-authenticated session id forced by the LAN transport (I17/R1).
    "federation.auditExport": async (p) => {
      const rec = asRecord(p);
      const sinceMsRaw = rec["sinceMs"];
      const sinceMs = typeof sinceMsRaw === "number" ? sinceMsRaw : 0;
      return answerFederatedAuditExport(
        {
          db: ctx.db,
          store,
          consentCache: sessionConsent,
          prompt: makePrompter(ctx),
          consentTimeoutMs: ctx.consentTimeoutMs,
          ...(ctx.identityGuard === undefined ? {} : { identity: ctx.identityGuard }),
        },
        {
          peerId: requireString(rec, "peerId"),
          namespace: requireString(rec, "namespace"),
          purpose: requireString(rec, "purpose"),
          sinceMs,
        },
      );
    },
    // Asker-side: build the TEAM-WIDE merged federation-audit timeline. Includes THIS gateway's
    // local federation-audit slice (tagged "local") + each paired peer's slice fetched OVER THE WIRE
    // via federation.auditExport (Task 20's consent-gated handler — requires the requester hold a
    // grant on `namespace` at the peer). Best-effort: an unreachable / denying peer is SKIPPED, never
    // fatal, so the local stream + every reachable peer still merges. Pure merge (sort+tag) is
    // mergeTeamAudit. Local-only entrypoint (mirrors federation.ask: requires asker-side deps).
    "team.auditMerged": async (p) => {
      const rec = asRecord(p);
      const sinceMsRaw = rec["sinceMs"];
      const sinceMs = typeof sinceMsRaw === "number" ? sinceMsRaw : 0;
      const namespace = requireString(rec, "namespace");
      const purpose = typeof rec["purpose"] === "string" ? rec["purpose"] : "team-audit";

      const streams: PeerAuditStream[] = [
        { peerId: "local", entries: exportFederationAudit(ctx.db, { sinceMs }) },
      ];

      // Fan out to paired peers only when the asker-side transport is wired (index + identity).
      if (ctx.index !== undefined && ctx.selfIdentity !== undefined) {
        const selfIdentity = ctx.selfIdentity;
        for (const row of ctx.index.listLanPeers()) {
          if (row.host_ip === null || row.host_port === null) continue;
          try {
            const result = await sendFederatedOverWire(
              row.host_ip,
              row.host_port,
              selfIdentity,
              row.peer_pubkey,
              "federation.auditExport",
              { namespace, purpose, sinceMs },
            );
            const entries = extractAuditEntries(result);
            if (entries !== undefined) {
              streams.push({ peerId: row.peer_id, entries });
            }
          } catch {
            // Best-effort: unreachable peer / wire error / consent denial → skip this peer.
          }
        }
      }

      return { entries: mergeTeamAudit(streams) };
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
    // Cloud janitor (Slice 6b): content-free resource-recency probe. Like expertise, this returns
    // only a coarse, leak-proof answer (touched + whole-days recency) and requires no per-namespace
    // grant — it never exposes item bodies. Scored locally against this gateway's own index.
    "federation.probe": (p) => {
      const rec = asRecord(p);
      return probeResourceRecency(ctx.db, { resourceRef: requireString(rec, "resourceRef") });
    },
    // Blast-radius preflight (Slice 6b, I24). Routes ONLY through answerFederatedPreflight — the
    // command is resolved from LOCAL config + gated by the LOCAL owner's HITL approval; the caller
    // never supplies it. Fail-closed if this gateway isn't configured to serve preflights.
    "federation.preflight": (p) => {
      const rec = asRecord(p);
      if (ctx.preflight === undefined) {
        throw new FederationRpcError(
          -32603,
          "ERR_PREFLIGHT_UNAVAILABLE: not configured to serve preflights",
        );
      }
      const surfaceRaw = rec["changedSurface"];
      const changedSurface = Array.isArray(surfaceRaw)
        ? surfaceRaw.filter((s): s is string => typeof s === "string")
        : [];
      const gateCtx: PreflightGateCtx =
        ctx.identityGuard === undefined
          ? ctx.preflight
          : { ...ctx.preflight, identity: ctx.identityGuard };
      return answerFederatedPreflight(gateCtx, {
        peerId: requireString(rec, "peerId"),
        namespace: requireString(rec, "namespace"),
        ref: requireString(rec, "ref"),
        changedSurface,
        purpose: requireString(rec, "purpose"),
      });
    },
    // The LOCAL owner's approval response for a pending inbound preflight (broker is local-only
    // state; a remote/unknown requestId simply doesn't match → { matched:false }, harmless).
    "federation.preflightRespond": (p) => {
      const rec = asRecord(p);
      const matched = preflightConsent.respond(
        requireString(rec, "requestId"),
        rec["approved"] === true,
      );
      return { matched };
    },
    // Anchor-side: serve the persisted signed org-policy bundle so paired peers can fetch it.
    // Read-only and public — the bundle is the signed TOML + signature, never a secret (the
    // signature lets peers verify authenticity; I22 enforces verification on the fetching side).
    // Takes no params; returns PolicyBundle | null (null when this gateway holds no policy).
    "federation.policy": () => {
      return servePolicy(new PolicyStore(ctx.db));
    },
    // Asker-side: look up the paired peer and send the federated query OVER THE WIRE.
    "federation.ask": async (p) => {
      const rec = asRecord(p);
      const { row, selfIdentity } = requireAskTarget(ctx, rec);
      const namespace = requireString(rec, "namespace");
      const body: Record<string, unknown> = {
        namespace,
        purpose: requireString(rec, "purpose"),
        ...(Array.isArray(rec["types"])
          ? { types: rec["types"].filter((t): t is string => typeof t === "string") }
          : {}),
      };
      const send = ctx.sendOverWire ?? sendFederatedOverWire;
      const result = await send(
        row.host_ip as string,
        row.host_port as number,
        selfIdentity,
        row.peer_pubkey,
        "federation.query",
        body,
      );
      // Asker-side cache (V38): record the namespace only when the peer actually answered.
      if ((result as { kind?: string }).kind === "ok") {
        new KnownNamespaceStore(ctx.db).record(row.peer_id, namespace, Date.now());
      }
      return result;
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
    // Asker-side: ask the trust anchor (a paired peer) to run a team-vault tool OVER THE WIRE. The
    // anchor answers via federation.invoke (I19). Local-only entrypoint (forbidden over LAN, I5).
    "federation.askInvoke": async (p) => {
      const rec = asRecord(p);
      const { row, selfIdentity } = requireAskTarget(ctx, rec);
      return sendFederatedOverWire(
        row.host_ip as string,
        row.host_port as number,
        selfIdentity,
        row.peer_pubkey,
        "federation.invoke",
        {
          entry: requireString(rec, "entry"),
          toolId: requireString(rec, "toolId"),
          purpose: requireString(rec, "purpose"),
          args: rec["args"],
        },
      );
    },
    // Anchor-side: a teammate asks the trust anchor to run a named team-vault tool. The secret is
    // injected inside teamVault.runTool (never in this scope); I19 gate enforces RBAC + quorum.
    // SECURITY (I17/R1): `peerId` here is NOT trusted from the request body. The LAN transport
    // (federation-server.ts onMessage) overwrites it with the NaCl-authenticated session id BEFORE
    // dispatch — `const forced = { ...body, peerId: peer.peerId }`. The same forcing protects
    // federation.query. These handlers (invoke RBAC subject; *Respond quorum/delegate identity)
    // are therefore spoof-proof over the wire. They MUST only be reached via a transport that forces
    // peerId; never dispatch them with a caller-supplied peerId (see Task 17 local-path note).
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
    // Delegate-side: an owner routes a HITL approval to this peer (I20). `peerId` is the OWNER's
    // forced authenticated id (I17/R1). The delegate decides locally and AUDITS its own decision on
    // THIS gateway (so the approval is recorded in both the owner's and the delegate's logs).
    "federation.requestApproval": async (p) => {
      const rec = asRecord(p);
      const actionType = requireString(rec, "actionType");
      const ownerPeerId = requireString(rec, "peerId");
      const decide = ctx.delegateApproval ?? (async () => false); // no prompter → fail-closed deny
      const approved = await decide({ actionType, ownerPeerId });
      // I4: `hitlStatus` is consent-gate-output-only — never written as approved/rejected outside
      // `executor.gate()`. This row records the *delegate's* answer to a federated request, not a
      // local HITL-gated action, so the row is `not_required` and the decision lives in
      // `federationJson.decision` (the owner's own audit row carries the real gate-set hitlStatus).
      appendAuditEntry(ctx.db, {
        actionType: "hitl.delegate.answered",
        hitlStatus: "not_required",
        actionJson: JSON.stringify({ method: "federation.requestApproval", actionType }),
        timestamp: Date.now(),
        federationJson: JSON.stringify({
          peer_id: ownerPeerId,
          action_type: actionType,
          decision: approved ? "approved" : "rejected",
        }),
      });
      return { approved };
    },
    // Answerer-side GDPR purge (Slice 4, spec D11). A paired peer (the user's home/origin gateway)
    // asks THIS gateway to erase that user's federated contributions. HITL is STRUCTURAL — we do NOT
    // auto-delete on receipt. We ask THIS gateway's LOCAL operator to approve via the consent broker
    // (the same local-human round-trip federation.query uses); NOTHING is deleted before approval.
    // SECURITY (I17/R1): `peerId` is the NaCl-authenticated session id forced by the LAN transport,
    // never trusted from the request body. On denial/timeout → { kind: "error", error: "purge_denied" }
    // and zero deletions. On approval → delete the user's local contributions, sign a DeletionRecord
    // with this gateway's Ed25519 anchor key, and return { kind: "ok", record, sig }. Either outcome is
    // audited (decision only; no user content).
    "federation.purge": async (p) => {
      const rec = asRecord(p);
      const peerId = requireString(rec, "peerId");
      const externalId = requireString(rec, "externalId");

      // Step 1 (HITL, no auto-exec): ask the LOCAL operator. The consent broker broadcasts
      // federation.consentRequest to local clients and resolves on federation.consentRespond; the
      // TTL safety-net denies on no answer. Purpose names the destructive action so the operator
      // sees what they are approving. role:"purge" disambiguates from query consent prompts.
      const decision = await federationConsent.request(
        {
          peerId,
          namespace: `gdpr-purge:${externalId}`,
          purpose: `Erase all federated contributions from ${peerId} (GDPR purge)`,
          role: "purge",
        },
        ctx.consentTimeoutMs + 5000,
      );

      if (decision !== "approved") {
        // Denial / timeout: delete NOTHING. Audit the refusal (no user content).
        appendAuditEntry(ctx.db, {
          actionType: "federation.purge",
          hitlStatus: "rejected",
          actionJson: JSON.stringify({ method: "federation.purge" }),
          timestamp: Date.now(),
          federationJson: JSON.stringify({ peer_id: peerId, decision: "denied" }),
        });
        return { kind: "error", error: "purge_denied" } as const;
      }

      // FAIL-CLOSED: verify the signer is available BEFORE touching any data. A purge must never
      // delete a single row unless it can also produce a signed deletion receipt — so the signer
      // guard runs ahead of the delete, not after it. No signer → return an error, delete NOTHING.
      const signer = ctx.purgeSign;
      if (signer === undefined) {
        // Approved but blocked: audit the fail-closed outcome so the refusal is not lost
        // from the compliance ledger (delete NOTHING).
        appendAuditEntry(ctx.db, {
          actionType: "federation.purge",
          hitlStatus: "rejected",
          actionJson: JSON.stringify({ method: "federation.purge" }),
          timestamp: Date.now(),
          federationJson: JSON.stringify({ peer_id: peerId, decision: "signer_unavailable" }),
        });
        return { kind: "error", error: "purge_signer_unavailable" } as const;
      }

      // Step 2 (post-approval, signer confirmed): delete the user's local contributions. The concrete
      // delete accessor is threaded in (Task 26 wires the real one); absent → 0 deleted.
      const deletedCount = ctx.deletePurgeContributions?.(externalId, peerId) ?? 0;

      // Step 3: sign a DeletionRecord with this gateway's Ed25519 anchor key (the federation IDENTITY
      // is an X25519 BOX keypair and CANNOT sign). The record attests WHO performed the deletion, so
      // its peerId is THIS answering gateway's own id (signer.selfPeerId), not the requesting peer's.
      const record: DeletionRecord = {
        externalId,
        peerId: signer.selfPeerId,
        deletedCount,
        at: Date.now(),
      };
      const sig = signDeletionRecord(record, signer.privkeyB64);

      // Audit the approved purge (decision + count only; never user content).
      appendAuditEntry(ctx.db, {
        actionType: "federation.purge",
        hitlStatus: "approved",
        actionJson: JSON.stringify({ method: "federation.purge", deletedCount }),
        timestamp: record.at,
        federationJson: JSON.stringify({ peer_id: peerId, decision: "approved", deletedCount }),
      });

      return { kind: "ok", record, sig } as const;
    },
  });
}
