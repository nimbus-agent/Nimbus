import { describe, expect, test } from "bun:test";

import { processListeners } from "../locality/listener-registry.ts";
import type { DiscoveredPeer } from "./discovery.ts";
import {
  type BonjourLike,
  type BonjourServiceLike,
  MdnsDiscoveryProvider,
} from "./mdns-discovery-provider.ts";

/** A broadcast-free fake bonjour: captures the `find` callback so a test can drive
 *  discovered-service events synchronously, and records publish/destroy/stop. */
function makeFakeBonjour() {
  let onUp: ((s: BonjourServiceLike) => void) | undefined;
  const published: Array<{ name: string; type: string; port: number }> = [];
  const state = { destroyed: false, browserStopped: false };
  const bonjour: BonjourLike = {
    find: (_opts, cb) => {
      onUp = cb;
      return {
        stop: () => {
          state.browserStopped = true;
        },
      };
    },
    publish: (o) => {
      published.push(o);
    },
    destroy: () => {
      state.destroyed = true;
    },
  };
  return {
    bonjour,
    emit: (s: BonjourServiceLike) => onUp?.(s),
    published,
    state,
  };
}

describe("MdnsDiscoveryProvider", () => {
  test("default constructor (no factory) — list is empty before start, no socket opened", async () => {
    // Exercises the default-param binding WITHOUT calling start() (so no real bonjour socket).
    const provider = new MdnsDiscoveryProvider();
    expect(await provider.list()).toEqual([]);
  });

  test("start() records a service whose host comes from addresses[0]", async () => {
    const fake = makeFakeBonjour();
    const provider = new MdnsDiscoveryProvider(() => fake.bonjour);
    await provider.start();
    fake.emit({ name: "peer-a", addresses: ["10.0.0.5"], host: "ignored.local", port: 8080 });
    expect(await provider.list()).toEqual([
      { instanceName: "peer-a", host: "10.0.0.5", port: 8080 },
    ]);
    await provider.stop(); // processListeners is process-global — leave nothing registered behind
  });

  test("start() falls back to service.host when addresses is empty/undefined", async () => {
    const fake = makeFakeBonjour();
    const provider = new MdnsDiscoveryProvider(() => fake.bonjour);
    await provider.start();
    fake.emit({ name: "peer-b", host: "peer-b.local", port: 9090 });
    expect(await provider.list()).toEqual([
      { instanceName: "peer-b", host: "peer-b.local", port: 9090 },
    ]);
    await provider.stop();
  });

  test("start() ignores a service with no usable host", async () => {
    const fake = makeFakeBonjour();
    const provider = new MdnsDiscoveryProvider(() => fake.bonjour);
    await provider.start();
    fake.emit({ name: "peer-c", port: 1234 }); // no addresses, no host
    expect(await provider.list()).toEqual([]);
    await provider.stop();
  });

  test("start() ignores a service with a non-numeric port", async () => {
    const fake = makeFakeBonjour();
    const provider = new MdnsDiscoveryProvider(() => fake.bonjour);
    await provider.start();
    fake.emit({ name: "peer-d", host: "peer-d.local" }); // port undefined
    expect(await provider.list()).toEqual([]);
    await provider.stop();
  });

  test("list() merges discovered + manual peers", async () => {
    const fake = makeFakeBonjour();
    const provider = new MdnsDiscoveryProvider(() => fake.bonjour);
    await provider.start();
    fake.emit({ name: "peer-e", host: "e.local", port: 1 });
    const manual: DiscoveredPeer = { instanceName: "manual-x", host: "x.local", port: 2 };
    provider.addManualPeer(manual);
    expect(await provider.list()).toEqual([
      { instanceName: "peer-e", host: "e.local", port: 1 },
      manual,
    ]);
    await provider.stop();
  });

  test("advertise() before start is a no-op; after start it publishes", async () => {
    const fake = makeFakeBonjour();
    const provider = new MdnsDiscoveryProvider(() => fake.bonjour);
    await provider.advertise("early", 1); // bonjour undefined → no-op (optional-chain false arm)
    expect(fake.published).toEqual([]);
    await provider.start();
    await provider.advertise("me", 7070);
    expect(fake.published).toEqual([{ name: "me", type: "nimbus", port: 7070 }]);
    await provider.stop();
  });

  test("registers an 'mdns' listener in the live registry while started, gone after stop", async () => {
    const fake = makeFakeBonjour();
    const provider = new MdnsDiscoveryProvider(() => fake.bonjour);
    await provider.start();
    // No real mDNS socket in this test — driven entirely through the BonjourFactory DI seam.
    // Filtered by NAME rather than a per-instance address, since the mdns report's address is a
    // fixed string (there is exactly one mDNS listener per process, unlike the per-port sites).
    expect(processListeners.live().filter((l) => l.name === "mdns")).toEqual([
      { name: "mdns", address: "udp *:5353 (mDNS multicast)", loopback: false },
    ]);
    await provider.stop();
    expect(processListeners.live().some((l) => l.name === "mdns")).toBe(false);
  });

  test("stop() stops the browser, destroys bonjour, and resets (idempotent)", async () => {
    const fake = makeFakeBonjour();
    const provider = new MdnsDiscoveryProvider(() => fake.bonjour);
    await provider.start();
    await provider.stop();
    expect(fake.state.browserStopped).toBe(true);
    expect(fake.state.destroyed).toBe(true);
    await provider.stop(); // second stop: both undefined → optional-chain false arms, no throw
  });

  // `platform/assemble.ts` fires these as `void discovery.start()` / `void discovery.stop()`, so a
  // bonjour failure must SETTLE the returned promise as a rejection — a synchronous throw would
  // escape into gateway boot or the shutdown drain instead. Each call is made on its own line,
  // OUTSIDE `expect(...)`, on purpose: a synchronous throw fails the test right there.
  test("a bonjour failure rejects start/advertise/stop instead of throwing synchronously", async () => {
    const unstartable = new MdnsDiscoveryProvider(() => {
      throw new Error("bonjour unavailable");
    });
    const started = unstartable.start();
    await expect(started).rejects.toThrow("bonjour unavailable");

    const fake = makeFakeBonjour();
    let destroyFailuresLeft = 1;
    const refusing: BonjourLike = {
      ...fake.bonjour,
      publish: () => {
        throw new Error("publish refused");
      },
      destroy: () => {
        if (destroyFailuresLeft > 0) {
          destroyFailuresLeft -= 1;
          throw new Error("destroy refused");
        }
        fake.bonjour.destroy();
      },
    };
    const provider = new MdnsDiscoveryProvider(() => refusing);
    await provider.start();
    const advertised = provider.advertise("me", 7070);
    await expect(advertised).rejects.toThrow("publish refused");
    const stopped = provider.stop();
    await expect(stopped).rejects.toThrow("destroy refused");

    // The failed stop never reached its unregister. A second, clean stop must still leave nothing
    // in the process-global registry for the tests that run after this one.
    await provider.stop();
    expect(fake.state.destroyed).toBe(true);
    expect(processListeners.live().some((l) => l.name === "mdns")).toBe(false);
  });
});
