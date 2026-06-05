import type { NimbusFederationToml } from "../config/nimbus-toml.ts";
import type { LocalIndex } from "../index/local-index.ts";
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
 * The outbound pair handshake is intentionally NOT injected here (deferred seam — no production
 * outbound LAN client yet); initiatePair therefore throws until that lands.
 */
export function buildFederationRuntime(
  cfg: NimbusFederationToml,
  index: LocalIndex,
): FederationRuntime | undefined {
  if (!cfg.enabled) return undefined;
  const discovery: DiscoveryProvider = cfg.mdnsEnabled
    ? new MdnsDiscoveryProvider()
    : new InMemoryDiscoveryProvider();
  return {
    discovery,
    pairing: new PeerPairing(index),
    consentTimeoutSeconds: cfg.consentTimeoutSeconds,
  };
}
