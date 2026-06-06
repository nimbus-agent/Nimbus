import { expect, test } from "bun:test";
import type { DiscoveredPeer } from "./discovery.ts";
import { InMemoryDiscoveryProvider } from "./discovery.ts";

test("InMemoryDiscoveryProvider lists the injected peers", async () => {
  const peers: DiscoveredPeer[] = [
    { instanceName: "asaf-laptop", host: "asaf-laptop.test", port: 7475 },
    { instanceName: "bob-desktop", host: "bob-desktop.test", port: 7475 },
  ];
  const provider = new InMemoryDiscoveryProvider(peers);
  await provider.start();
  expect(await provider.list()).toEqual(peers);
  await provider.stop();
});

test("addManualPeer surfaces a peer when mDNS is unavailable", async () => {
  const provider = new InMemoryDiscoveryProvider([]);
  await provider.start();
  provider.addManualPeer({ instanceName: "manual", host: "manual-peer.test", port: 7475 });
  expect(await provider.list()).toEqual([
    { instanceName: "manual", host: "manual-peer.test", port: 7475 },
  ]);
  await provider.stop();
});
