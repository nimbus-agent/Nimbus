export interface DiscoveredPeer {
  readonly instanceName: string;
  readonly host: string;
  readonly port: number;
}

/** Discovery never implies trust — pairing still requires mutual approval. */
export interface DiscoveryProvider {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Snapshot of currently-known peers (mDNS-advertised + manually added). */
  list(): Promise<readonly DiscoveredPeer[]>;
  /** Advertise this gateway as `_nimbus._tcp` on the given port. */
  advertise(instanceName: string, port: number): Promise<void>;
  /** Manual fallback for mDNS-absent environments. */
  addManualPeer(peer: DiscoveredPeer): void;
}

/** Deterministic, broadcast-free provider for unit + integration tests. */
export class InMemoryDiscoveryProvider implements DiscoveryProvider {
  private readonly peers: DiscoveredPeer[];
  constructor(seed: readonly DiscoveredPeer[] = []) {
    this.peers = [...seed];
  }
  async start(): Promise<void> {
    // no-op: the in-memory provider needs no startup
  }
  async stop(): Promise<void> {
    // no-op: nothing to tear down
  }
  async list(): Promise<readonly DiscoveredPeer[]> {
    return [...this.peers];
  }
  async advertise(): Promise<void> {
    // no-op: the in-memory provider does not broadcast
  }
  addManualPeer(peer: DiscoveredPeer): void {
    this.peers.push(peer);
  }
}

export { MdnsDiscoveryProvider } from "./mdns-discovery-provider.ts";
