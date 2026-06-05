import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { LocalIndex } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { InMemoryDiscoveryProvider } from "./discovery.ts";
import { buildFederationRuntime } from "./federation-runtime.ts";
import { MdnsDiscoveryProvider } from "./mdns-discovery-provider.ts";

let index: LocalIndex;
beforeEach(() => {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 33);
  index = new LocalIndex(db);
});
afterEach(() => index.close());

const base = { enabled: true, consentTimeoutSeconds: 30, mdnsEnabled: true, mdnsBind: "0.0.0.0" };

test("disabled federation returns undefined", () => {
  expect(buildFederationRuntime({ ...base, enabled: false }, index)).toBeUndefined();
});

test("enabled + mdns builds an mDNS provider + pairing + timeout", () => {
  const rt = buildFederationRuntime(base, index);
  expect(rt).toBeDefined();
  expect(rt?.discovery).toBeInstanceOf(MdnsDiscoveryProvider);
  expect(rt?.consentTimeoutSeconds).toBe(30);
  expect(rt?.pairing.listPeers()).toEqual([]); // a real PeerPairing over the index
});

test("enabled + mdns disabled builds the in-memory provider (no real broadcast)", () => {
  const rt = buildFederationRuntime({ ...base, mdnsEnabled: false }, index);
  expect(rt?.discovery).toBeInstanceOf(InMemoryDiscoveryProvider);
});
