import BonjourLib from "bonjour-service";
import type { DiscoveredPeer, DiscoveryProvider } from "./discovery.ts";

// Namespace-qualified types under the `export =` root — most robust form for
// a CJS module that uses `export = Bonjour` with a companion namespace.
type Browser = InstanceType<typeof BonjourLib.Browser>;
type Service = InstanceType<typeof BonjourLib.Service>;

const SERVICE_TYPE = "nimbus"; // bonjour-service advertises this as _nimbus._tcp

// MdnsDiscoveryProvider is a thin bonjour-service socket shell (advertise/browse
// _nimbus._tcp) with no injection seam — real multicast can't run on CI, so it's
// exercised only by the skippable Task 15 mDNS E2E. The testable discovery logic
// (DiscoveryProvider interface + InMemoryDiscoveryProvider) lives in discovery.ts,
// which IS covered.
export class MdnsDiscoveryProvider implements DiscoveryProvider {
  private bonjour: InstanceType<typeof BonjourLib> | undefined;
  private browser: Browser | undefined;
  private readonly seen = new Map<string, DiscoveredPeer>();
  private readonly manual: DiscoveredPeer[] = [];

  async start(): Promise<void> {
    this.bonjour = new BonjourLib();
    this.browser = this.bonjour.find({ type: SERVICE_TYPE }, (service: Service) => {
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
