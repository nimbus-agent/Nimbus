import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { LocalIndex } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { generateBoxKeypair } from "../ipc/lan-crypto.ts";
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
  expect(
    buildFederationRuntime({ ...base, enabled: false }, index, generateBoxKeypair()),
  ).toBeUndefined();
});

test("enabled + mdns builds an mDNS provider + pairing + timeout", () => {
  const rt = buildFederationRuntime(base, index, generateBoxKeypair());
  expect(rt).toBeDefined();
  expect(rt?.discovery).toBeInstanceOf(MdnsDiscoveryProvider);
  expect(rt?.consentTimeoutSeconds).toBe(30);
  expect(rt?.pairing.listPeers()).toEqual([]); // a real PeerPairing over the index
});

test("enabled + mdns disabled builds the in-memory provider (no real broadcast)", () => {
  const rt = buildFederationRuntime({ ...base, mdnsEnabled: false }, index, generateBoxKeypair());
  expect(rt?.discovery).toBeInstanceOf(InMemoryDiscoveryProvider);
});

test("buildFederationRuntime wires a real outbound handshake (initiatePair no longer throws 'not wired')", async () => {
  const rt = buildFederationRuntime(
    { enabled: true, consentTimeoutSeconds: 30, mdnsEnabled: false, mdnsBind: "127.0.0.1" },
    index,
    generateBoxKeypair(),
  );
  expect(rt).toBeDefined();
  // No responder running → connection error, NOT the "not wired" sentinel.
  let err: unknown;
  try {
    await rt?.pairing.initiatePair("127.0.0.1", 1, "code");
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(Error);
  const msg = (err as Error).message;
  expect(msg).not.toContain("outbound pair handshake not wired");
  // a real connection was attempted (port 1 refuses): connection-class error, not the sentinel
  expect(msg).toMatch(/connect|refus|ECONN|fail|timeout|reset/i);
});
