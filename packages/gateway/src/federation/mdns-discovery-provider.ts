import BonjourLib from "bonjour-service";
import { registerListener } from "../locality/listener-registry.ts";
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
  publish(opts: { name: string; type: string; port: number }): unknown;
  destroy(): void;
}
export type BonjourFactory = () => BonjourLike;

// The real bonjour-service instance structurally satisfies BonjourLike (the seam interface used for
// testability), so it is assigned directly without a bridging type assertion.
const defaultBonjourFactory: BonjourFactory = () => new BonjourLib();

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
  // Registered BY HAND (D31 cannot see a socket a library opens internally — see
  // locality/listener-registry.ts's module doc). Unregisters on every stop() path.
  private unregisterListener: (() => void) | undefined;

  constructor(makeBonjour: BonjourFactory = defaultBonjourFactory) {
    this.makeBonjour = makeBonjour;
  }

  // `start`, `stop` and `advertise` do no asynchronous work — every bonjour call is synchronous —
  // but the `DiscoveryProvider` contract returns a Promise, and `platform/assemble.ts` fires them
  // as `void discovery.start()` / `void discovery.stop()`. `Promise.try` runs each body
  // immediately, exactly as the former `async` did, and turns a throw from the bonjour library into
  // a REJECTION of the returned promise; a plain synchronous throw would instead escape into gateway
  // boot or the shutdown drain at the call site.
  start(): Promise<void> {
    return Promise.try(() => {
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
      this.unregisterListener = registerListener(() =>
        this.bonjour === undefined
          ? null
          : { name: "mdns", address: "udp *:5353 (mDNS multicast)", loopback: false },
      );
    });
  }

  stop(): Promise<void> {
    return Promise.try(() => {
      this.browser?.stop();
      this.bonjour?.destroy();
      this.browser = undefined;
      this.bonjour = undefined;
      this.unregisterListener?.();
      this.unregisterListener = undefined;
    });
  }

  list(): Promise<readonly DiscoveredPeer[]> {
    return Promise.resolve([...this.seen.values(), ...this.manual]);
  }

  advertise(instanceName: string, port: number): Promise<void> {
    return Promise.try(() => {
      this.bonjour?.publish({ name: instanceName, type: SERVICE_TYPE, port });
    });
  }

  addManualPeer(peer: DiscoveredPeer): void {
    this.manual.push(peer);
  }
}
