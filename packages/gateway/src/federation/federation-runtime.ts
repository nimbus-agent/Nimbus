import type { NimbusFederationToml } from "../config/nimbus-toml.ts";
import type { LocalIndex } from "../index/local-index.ts";
import { outboundPairHandshake } from "../ipc/lan-client.ts";
import type { BoxKeypair } from "../ipc/lan-crypto.ts";
import {
  type DiscoveryProvider,
  InMemoryDiscoveryProvider,
  MdnsDiscoveryProvider,
} from "./discovery.ts";
import { PeerPairing } from "./peer-pairing.ts";

export interface FederationRuntime {
  readonly discovery: DiscoveryProvider;
  readonly pairing: PeerPairing;
  readonly consentTimeoutSeconds: number;
}

/**
 * Build the federation runtime services from config. Returns undefined when federation is disabled.
 * mDNS-enabled → real bonjour-service browser/advertiser; disabled → broadcast-free in-memory provider.
 * The outbound pair handshake is the production `lan-client` implementation, with this gateway's
 * box identity closed in; `initiatePair` therefore works end-to-end.
 */
export function buildFederationRuntime(
  cfg: NimbusFederationToml,
  index: LocalIndex,
  identity: BoxKeypair,
): FederationRuntime | undefined {
  if (!cfg.enabled) return undefined;
  const discovery: DiscoveryProvider = cfg.mdnsEnabled
    ? new MdnsDiscoveryProvider()
    : new InMemoryDiscoveryProvider();
  const handshake = (host: string, port: number, code: string): Promise<Uint8Array> =>
    outboundPairHandshake(host, port, code, identity);
  return {
    discovery,
    pairing: new PeerPairing(index, handshake),
    consentTimeoutSeconds: cfg.consentTimeoutSeconds,
  };
}
