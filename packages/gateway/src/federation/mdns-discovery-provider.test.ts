import { describe, expect, test } from "bun:test";

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
  });

  test("start() falls back to service.host when addresses is empty/undefined", async () => {
    const fake = makeFakeBonjour();
    const provider = new MdnsDiscoveryProvider(() => fake.bonjour);
    await provider.start();
    fake.emit({ name: "peer-b", host: "peer-b.local", port: 9090 });
    expect(await provider.list()).toEqual([
      { instanceName: "peer-b", host: "peer-b.local", port: 9090 },
    ]);
  });

  test("start() ignores a service with no usable host", async () => {
    const fake = makeFakeBonjour();
    const provider = new MdnsDiscoveryProvider(() => fake.bonjour);
    await provider.start();
    fake.emit({ name: "peer-c", port: 1234 }); // no addresses, no host
    expect(await provider.list()).toEqual([]);
  });

  test("start() ignores a service with a non-numeric port", async () => {
    const fake = makeFakeBonjour();
    const provider = new MdnsDiscoveryProvider(() => fake.bonjour);
    await provider.start();
    fake.emit({ name: "peer-d", host: "peer-d.local" }); // port undefined
    expect(await provider.list()).toEqual([]);
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
  });

  test("advertise() before start is a no-op; after start it publishes", async () => {
    const fake = makeFakeBonjour();
    const provider = new MdnsDiscoveryProvider(() => fake.bonjour);
    await provider.advertise("early", 1); // bonjour undefined → no-op (optional-chain false arm)
    expect(fake.published).toEqual([]);
    await provider.start();
    await provider.advertise("me", 7070);
    expect(fake.published).toEqual([{ name: "me", type: "nimbus", port: 7070 }]);
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
});
