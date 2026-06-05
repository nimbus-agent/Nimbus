import { expect, test } from "bun:test";

const RUN = process.env["NIMBUS_MDNS_E2E"] === "1";

// Real multicast — skipped on CI (no multicast / sandboxed). Run locally with NIMBUS_MDNS_E2E=1.
test.skipIf(!RUN)("MdnsDiscoveryProvider advertises and browses _nimbus._tcp", async () => {
  const { MdnsDiscoveryProvider } = await import("../../../src/federation/discovery.ts");
  const adv = new MdnsDiscoveryProvider();
  const browser = new MdnsDiscoveryProvider();
  await adv.start();
  await adv.advertise("nimbus-mdns-e2e-instance", 7475);
  await browser.start();
  let found = false;
  for (let i = 0; i < 20 && !found; i++) {
    const peers = await browser.list();
    found = peers.some((p) => p.instanceName.includes("nimbus-mdns-e2e-instance"));
    if (!found) await new Promise((r) => setTimeout(r, 250));
  }
  await adv.stop();
  await browser.stop();
  expect(found).toBe(true);
});
