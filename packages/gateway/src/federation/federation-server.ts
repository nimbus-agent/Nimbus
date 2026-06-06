import type { Database } from "bun:sqlite";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { LocalIndex } from "../index/local-index.ts";
import { dispatchFederationRpc, type FederationRpcContext } from "../ipc/federation-rpc.ts";
import type { BoxKeypair } from "../ipc/lan-crypto.ts";
import { PairingWindow } from "../ipc/lan-pairing.ts";
import { LanRateLimiter } from "../ipc/lan-rate-limit.ts";
import { LanError } from "../ipc/lan-rpc.ts";
import { LanServer } from "../ipc/lan-server.ts";
import type { DiscoveryProvider } from "./discovery.ts";
import type { PeerPairing } from "./peer-pairing.ts";

export interface FederationLanConfig {
  readonly bind: string;
  readonly port: number;
  readonly pairingWindowSeconds: number;
  readonly maxFailedAttempts: number;
  readonly lockoutSeconds: number;
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
}

export interface FederationLanServer {
  readonly lanServer: LanServer;
  readonly pairingWindow: PairingWindow;
  readonly rateLimit: LanRateLimiter;
}

function peerIdFor(pubkey: Uint8Array): string {
  return `peer:${bytesToHex(pubkey.subarray(0, 8))}`;
}

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
    pairing: {
      isOpen: () => pairingWindow.isOpen(),
      consume: (code) => pairingWindow.consume(code),
      open: (code) => pairingWindow.open(code),
      close: () => pairingWindow.close(),
      // PairingWindow returns number|null; PairingService expects number|undefined
      getExpiresAt: () => pairingWindow.getExpiresAt() ?? undefined,
    },
    rateLimit,
    isKnownPeer: (pubkey) => {
      const row = deps.index.getLanPeerByPubkey(pubkey);
      return row === undefined ? null : { peerId: row.peer_id, writeAllowed: false };
    },
    registerPeer: (pubkey, ip) => {
      const peerId = peerIdFor(pubkey);
      deps.index.addLanPeer({ peerId, peerPubkey: pubkey, direction: "inbound", hostIp: ip });
      return peerId;
    },
    onMessage: async (method, params, peer) => {
      // I17 / R1: the answering peerId is the NaCl-authenticated session id,
      // never the request body — force it from the authenticated peer context.
      const body =
        typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {};
      const forced = { ...body, peerId: peer.peerId };
      const ctx: FederationRpcContext = {
        db: deps.db,
        consentTimeoutMs: deps.consentTimeoutMs,
        notify: deps.notify,
        discovery: deps.discovery ?? ({ list: async () => [] } as unknown as DiscoveryProvider),
        pairing: deps.pairing ?? ({ listPeers: () => [] } as unknown as PeerPairing),
      };
      const out = await dispatchFederationRpc(method, forced, ctx);
      if (out.kind === "hit") return out.value;
      throw new LanError(-32601, `ERR_METHOD_NOT_ALLOWED: ${method}`);
    },
  });

  return { lanServer, pairingWindow, rateLimit };
}
