import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { InMemoryDiscoveryProvider } from "../federation/discovery.ts";
import { PeerPairing } from "../federation/peer-pairing.ts";
import { LocalIndex } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import type { FederationRpcContext } from "./federation-rpc.ts";
import { dispatchFederationRpc } from "./federation-rpc.ts";

let db: Database;
let index: LocalIndex;
let notes: Array<{ method: string; params: unknown }>;
function ctx(): FederationRpcContext {
  return {
    db,
    consentTimeoutMs: 1000,
    notify: (method, params) => notes.push({ method, params }),
    discovery: new InMemoryDiscoveryProvider([
      { instanceName: "bob", host: "10.0.0.2", port: 7475 },
    ]),
    pairing: new PeerPairing(index),
  };
}
beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 33);
  index = new LocalIndex(db);
  notes = [];
});
afterEach(() => db.close());

test("federation.discover lists provider peers; federation.peers lists paired peers", async () => {
  const disc = await dispatchFederationRpc("federation.discover", {}, ctx());
  expect(disc.kind).toBe("hit");
  if (disc.kind === "hit") {
    expect((disc.value as { peers: unknown[] }).peers.length).toBe(1);
  }
  const peers = await dispatchFederationRpc("federation.peers", {}, ctx());
  expect(peers.kind).toBe("hit");
});

test("namespace.publish then unknown method miss", async () => {
  const pub = await dispatchFederationRpc(
    "federation.namespace.publish",
    { name: "project:zurich", filters: [{ kind: "type", value: "pull_request" }] },
    ctx(),
  );
  expect(pub.kind).toBe("hit");
  const miss = await dispatchFederationRpc("federation.unknown", {}, ctx());
  expect(miss.kind).toBe("miss");
});

test("federation.query with no grant returns the no_grant error shape (wrapped in a hit)", async () => {
  await dispatchFederationRpc(
    "federation.namespace.publish",
    { name: "ns", filters: [{ kind: "type", value: "pull_request" }] },
    ctx(),
  );
  const res = await dispatchFederationRpc(
    "federation.query",
    { peerId: "stranger", namespace: "ns", purpose: "x" },
    ctx(),
  );
  expect(res.kind).toBe("hit");
  if (res.kind === "hit") {
    const v = res.value as { kind: string; error?: string };
    expect(v.kind).toBe("error");
    expect(v.error).toBe("no_grant");
  }
});

test("federation.expertise returns a content-free rank", async () => {
  const res = await dispatchFederationRpc(
    "federation.expertise",
    { query: "auth bug", purpose: "who-knows" },
    ctx(),
  );
  expect(res.kind).toBe("hit");
  if (res.kind === "hit") {
    expect(Object.keys(res.value as object)).toEqual(["rank"]);
  }
});

test("namespace.grant then revoke invalidates and returns ok", async () => {
  await dispatchFederationRpc(
    "federation.namespace.publish",
    { name: "ns", filters: [{ kind: "type", value: "pull_request" }] },
    ctx(),
  );
  const g = await dispatchFederationRpc(
    "federation.namespace.grant",
    { namespace: "ns", peerId: "peerA", role: "viewer", standingConsent: true },
    ctx(),
  );
  expect(g.kind).toBe("hit");
  const r = await dispatchFederationRpc(
    "federation.namespace.revoke",
    { namespace: "ns", peerId: "peerA" },
    ctx(),
  );
  expect(r.kind).toBe("hit");
});

test("missing required param throws a FederationRpcError (invalid params)", async () => {
  await expect(
    dispatchFederationRpc("federation.namespace.publish", { filters: [] }, ctx()),
  ).rejects.toThrow();
});

test("federation.pair throws 'not wired' when no outbound handshake is configured", async () => {
  await expect(
    dispatchFederationRpc("federation.pair", { host: "10.0.0.2", port: 7475, code: "abc" }, ctx()),
  ).rejects.toThrow(/not wired/);
});

test("federation.query with a non-standing grant fires the consent prompt (notify) and denies", async () => {
  const c = ctx();
  await dispatchFederationRpc(
    "federation.namespace.publish",
    { name: "ns-consent", filters: [{ kind: "type", value: "pull_request" }] },
    c,
  );
  await dispatchFederationRpc(
    "federation.namespace.grant",
    { namespace: "ns-consent", peerId: "peer-consent-1", role: "viewer", standingConsent: false },
    c,
  );
  const res = await dispatchFederationRpc(
    "federation.query",
    { peerId: "peer-consent-1", namespace: "ns-consent", purpose: "review" },
    c,
  );
  expect(res.kind).toBe("hit");
  if (res.kind === "hit") {
    const v = res.value as { kind: string; error?: string };
    expect(v.kind).toBe("error");
    expect(v.error).toBe("consent_denied");
  }
  // the deferred consent seam emitted exactly one consent-request notification
  expect(notes.some((n) => n.method === "federation.consentRequest")).toBe(true);
});

test("requireString rejects an empty string", async () => {
  await expect(
    dispatchFederationRpc(
      "federation.namespace.publish",
      { name: "", filters: [{ kind: "type", value: "pull_request" }] },
      ctx(),
    ),
  ).rejects.toThrow(/non-empty string/);
});

test("parseFilters rejects a bad filter kind", async () => {
  await expect(
    dispatchFederationRpc(
      "federation.namespace.publish",
      { name: "ns-badkind", filters: [{ kind: "nope", value: "x" }] },
      ctx(),
    ),
  ).rejects.toThrow();
});

test("namespace.grant rejects an unknown role", async () => {
  await dispatchFederationRpc(
    "federation.namespace.publish",
    { name: "ns-role", filters: [{ kind: "type", value: "pull_request" }] },
    ctx(),
  );
  await expect(
    dispatchFederationRpc(
      "federation.namespace.grant",
      { namespace: "ns-role", peerId: "peer-role-1", role: "superadmin", standingConsent: false },
      ctx(),
    ),
  ).rejects.toThrow();
});
