import type { Database } from "bun:sqlite";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { LocalIndex } from "../index/local-index.ts";
import { dispatchFederationRpc, type FederationRpcContext } from "../ipc/federation-rpc.ts";
import type { BoxKeypair } from "../ipc/lan-crypto.ts";
import { PairingWindow } from "../ipc/lan-pairing.ts";
import { LanRateLimiter } from "../ipc/lan-rate-limit.ts";
import { LanError } from "../ipc/lan-rpc.ts";
import { LanServer, type PairingService } from "../ipc/lan-server.ts";
import type { ReceiveShareDeps } from "../share/share-forward.ts";
import type { DiscoveryProvider } from "./discovery.ts";
import { answerFederatedFreeBusy, type FreeBusyGateCtx } from "./free-busy-gate.ts";
import type { PeerPairing } from "./peer-pairing.ts";

export interface FederationLanConfig {
  readonly bind: string;
  readonly port: number;
  readonly pairingWindowSeconds: number;
  readonly maxFailedAttempts: number;
  readonly lockoutSeconds: number;
  /** Called with the address of a peer that opened the removed v1 wire (FS3): it must be upgraded. */
  readonly onOldWireRefused?: (peerIp: string) => void;
}

export interface BuildFederationLanServerDeps {
  readonly db: Database;
  readonly index: LocalIndex;
  readonly identity: BoxKeypair;
  readonly lan: FederationLanConfig;
  readonly consentTimeoutMs: number;
  readonly notify: (method: string, params: unknown) => void;
  readonly discovery?: DiscoveryProvider;
  readonly pairing?: PeerPairing;
  // Team Vault (Slice 2): the anchor's invoke backing. When set, an authenticated peer's
  // federation.invoke is answered here (I19). I18: operator identity must be valid to serve.
  readonly teamVault?: FederationRpcContext["teamVault"];
  readonly identityGuard?: FederationRpcContext["identityGuard"];
  // Delegated HITL (Slice 2, I20): the delegate's local decision for an owner's routed approval.
  readonly delegateApproval?: FederationRpcContext["delegateApproval"];
  // GDPR purge (Slice 4, spec D11): the Ed25519 anchor signer (privkey seed + this gateway's
  // selfPeerId) that signs the DeletionRecord, and the concrete local-delete accessor. Without the
  // signer wired, an approved federation.purge fails closed (purge_signer_unavailable) and deletes
  // nothing. `deletePurgeContributions` is deferred to Task 26 (undefined → deletedCount stays 0).
  readonly purgeSign?: FederationRpcContext["purgeSign"];
  readonly deletePurgeContributions?: FederationRpcContext["deletePurgeContributions"];
  // I24 (Slice 6b): downstream preflight gate deps — present so an upstream peer's federation.preflight
  // is served over the wire (behind THIS owner's local HITL approval; command from local config).
  readonly preflight?: FederationRpcContext["preflight"];
  // I17 (b) (OR-S4-SCHED): the free/busy gate's deps (the per-peer limiter and the LOCAL owner's
  // approval). Absent -> an inbound federation.freeBusy fails closed (ERR_FREEBUSY_UNAVAILABLE).
  readonly freeBusy?: Omit<FreeBusyGateCtx, "identity">;
  // Share receiving (Slice 8d): answerer-side deps for federation.shareReceive — inbound forwarded
  // shares from a peer are stored INERT (viewable artifact only, no HITL needed, spec §9.4).
  readonly receiveShareDeps?: ReceiveShareDeps;
}

export interface FederationLanServer {
  readonly lanServer: LanServer;
  readonly pairingWindow: PairingWindow;
  readonly rateLimit: LanRateLimiter;
}

function peerIdFor(pubkey: Uint8Array): string {
  return `peer:${bytesToHex(pubkey.subarray(0, 8))}`;
}

/**
 * Adapt a {@link PairingWindow} to the {@link PairingService} the LanServer expects.
 * Exported for testing — LanServer only invokes isOpen/consume during a handshake, so the
 * open/close/getExpiresAt arms are otherwise exercised only here.
 */
export function pairingServiceFor(pairingWindow: PairingWindow): PairingService {
  return {
    isOpen: () => pairingWindow.isOpen(),
    currentPsk: () => pairingWindow.currentPsk(),
    consumeOpen: () => pairingWindow.consumeOpen(),
    open: (code) => pairingWindow.open(code),
    close: () => pairingWindow.close(),
    // PairingWindow returns number|null; PairingService expects number|undefined
    getExpiresAt: () => pairingWindow.getExpiresAt() ?? undefined,
  };
}

/**
 * Inert default providers used when no discovery/pairing is wired. The management methods that
 * would call them (federation.discover / federation.peers) are wire-forbidden (I5), so over the
 * wire these are never reached; they exist only to satisfy the dispatch context shape. Exported
 * for testing.
 */
export const EMPTY_DISCOVERY = {
  list: () => Promise.resolve([]),
} as unknown as DiscoveryProvider;
export const EMPTY_PEER_PAIRING = {
  listPeers: () => [],
} as unknown as PeerPairing;

/** Build (but do not start) the federation LanServer + its pairing window + rate limiter. */
export function buildFederationLanServer(deps: BuildFederationLanServerDeps): FederationLanServer {
  const pairingWindow = new PairingWindow(deps.lan.pairingWindowSeconds * 1000);
  const rateLimit = new LanRateLimiter({
    maxFailures: deps.lan.maxFailedAttempts,
    windowMs: deps.lan.lockoutSeconds * 1000,
    lockoutMs: deps.lan.lockoutSeconds * 1000,
  });

  const lanServer = new LanServer({
    bind: deps.lan.bind,
    port: deps.lan.port,
    hostKeypair: deps.identity,
    pairing: pairingServiceFor(pairingWindow),
    rateLimit,
    ...(deps.lan.onOldWireRefused === undefined
      ? {}
      : { onOldWireRefused: deps.lan.onOldWireRefused }),
    isKnownPeer: (pubkey) => {
      const row = deps.index.getLanPeerByPubkey(pubkey);
      return row === undefined
        ? null
        : {
            peerId: row.peer_id,
            writeAllowed: false,
            protoVersion: row.proto_version === 2 ? 2 : 1,
          };
    },
    // The downgrade ratchet (I56), responder side: a peer that completed a v2 session is never
    // talked to over the old wire again.
    onPeerNegotiated: (pubkey) => deps.index.markLanPeerProto(pubkey, 2),
    registerPeer: (pubkey, ip, protoVersion) => {
      const peerId = peerIdFor(pubkey);
      deps.index.addLanPeer({
        peerId,
        peerPubkey: pubkey,
        direction: "inbound",
        hostIp: ip,
        ...(protoVersion === undefined ? {} : { protoVersion }),
      });
      return peerId;
    },
    onMessage: async (method, params, peer) => {
      // I17 / R1: the answering peerId is the NaCl-authenticated session id,
      // never the request body — force it from the authenticated peer context.
      const body =
        typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {};
      const forced = { ...body, peerId: peer.peerId };
      if (method === "federation.freeBusy") {
        // I17 (b): the ONLY answering path for a free/busy request. peerId is the authenticated
        // session's; the window fields are untrusted and validated inside the gate.
        if (deps.freeBusy === undefined) {
          throw new LanError(-32603, "ERR_FREEBUSY_UNAVAILABLE: not configured to answer");
        }
        return answerFederatedFreeBusy(
          {
            ...deps.freeBusy,
            ...(deps.identityGuard === undefined ? {} : { identity: deps.identityGuard }),
          },
          { peerId: peer.peerId, fromMs: body["fromMs"], toMs: body["toMs"] },
        );
      }
      const ctx: FederationRpcContext = {
        db: deps.db,
        consentTimeoutMs: deps.consentTimeoutMs,
        notify: deps.notify,
        discovery: deps.discovery ?? EMPTY_DISCOVERY,
        pairing: deps.pairing ?? EMPTY_PEER_PAIRING,
        ...(deps.teamVault === undefined ? {} : { teamVault: deps.teamVault }),
        ...(deps.identityGuard === undefined ? {} : { identityGuard: deps.identityGuard }),
        ...(deps.delegateApproval === undefined ? {} : { delegateApproval: deps.delegateApproval }),
        ...(deps.purgeSign === undefined ? {} : { purgeSign: deps.purgeSign }),
        ...(deps.deletePurgeContributions === undefined
          ? {}
          : { deletePurgeContributions: deps.deletePurgeContributions }),
        ...(deps.preflight === undefined ? {} : { preflight: deps.preflight }),
        ...(deps.receiveShareDeps === undefined ? {} : { receiveShareDeps: deps.receiveShareDeps }),
      };
      const out = await dispatchFederationRpc(method, forced, ctx);
      if (out.kind === "hit") return out.value;
      throw new LanError(-32601, `ERR_METHOD_NOT_ALLOWED: ${method}`);
    },
  });

  return { lanServer, pairingWindow, rateLimit };
}
