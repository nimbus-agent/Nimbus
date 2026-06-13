import BonjourLib from "bonjour-service";
import type { DiscoveredPeer, DiscoveryProvider } from "./discovery.ts";

const SERVICE_TYPE = "nimbus"; // bonjour-service advertises this as _nimbus._tcp

/** Structural seam types (avoid `any` and the `InstanceType<typeof BonjourLib>` import in tests). */
export interface BonjourServiceLike {
  readonly name: string;
  readonly host?: string;
  readonly port?: number;
  readonly addresses?: readonly string[];
}
export interface BonjourBrowserLike {
  stop(): void;
}
export interface BonjourLike {
  find(opts: { type: string }, onUp: (service: BonjourServiceLike) => void): BonjourBrowserLike;
  publish(opts: { name: string; type: string; port: number }): void;
  destroy(): void;
}
export type BonjourFactory = () => BonjourLike;

// The real bonjour-service instance structurally satisfies BonjourLike; the `as unknown as`
// bridges the wider real type to the seam interface used for testability.
const defaultBonjourFactory: BonjourFactory = () => new BonjourLib() as unknown as BonjourLike;

// MdnsDiscoveryProvider is a thin bonjour-service socket shell (advertise/browse _nimbus._tcp).
// Real multicast cannot run on CI, so the bonjour client is injected via a factory (default = the
// real library) and the discovery logic (host-extraction, manual merge, lifecycle) is unit-tested
// against a broadcast-free fake. The DiscoveryProvider interface + InMemoryDiscoveryProvider live
// in discovery.ts.
export class MdnsDiscoveryProvider implements DiscoveryProvider {
  private bonjour: BonjourLike | undefined;
  private browser: BonjourBrowserLike | undefined;
  private readonly seen = new Map<string, DiscoveredPeer>();
  private readonly manual: DiscoveredPeer[] = [];
  private readonly makeBonjour: BonjourFactory;

  constructor(makeBonjour: BonjourFactory = defaultBonjourFactory) {
    this.makeBonjour = makeBonjour;
  }

  async start(): Promise<void> {
    this.bonjour = this.makeBonjour();
    this.browser = this.bonjour.find({ type: SERVICE_TYPE }, (service) => {
      const host = service.addresses?.[0] ?? service.host;
      if (typeof host === "string" && typeof service.port === "number") {
        this.seen.set(service.name, {
          instanceName: service.name,
          host,
          port: service.port,
        });
      }
    });
  }

  async stop(): Promise<void> {
    this.browser?.stop();
    this.bonjour?.destroy();
    this.browser = undefined;
    this.bonjour = undefined;
  }

  async list(): Promise<readonly DiscoveredPeer[]> {
    return [...this.seen.values(), ...this.manual];
  }

  async advertise(instanceName: string, port: number): Promise<void> {
    this.bonjour?.publish({ name: instanceName, type: SERVICE_TYPE, port });
  }

  addManualPeer(peer: DiscoveredPeer): void {
    this.manual.push(peer);
  }
}
