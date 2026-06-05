/**
 * Phase 6 Slice 1 — Federation Core acceptance (integration layer).
 *
 * This drives the FULL federation flow through the real RPC dispatcher (dispatchFederationRpc),
 * the real LAN allowlist (checkLanMethodAllowed), and the real Blake3 audit chain (verifyAuditChain)
 * against real SQLite with seeded items. It is the lowest layer that meaningfully tests the
 * acceptance criteria.
 *
 * DEFERRED to Slice 2 (infrastructure does not exist in Slice 1): the real two-gateway flow over
 * the NaCl-box LAN channel — it needs (a) a production OUTBOUND LAN client wired into
 * PeerPairing.initiatePair (currently a DI seam that throws "not wired"), (b) the LanServer wired
 * into gateway boot, and (c) the owner-consent UI round-trip (the dispatcher's makePrompter is a
 * notify seam that defaults to a timeout-safe deny). The consent TIMEOUT path is unit-tested in
 * query-gate.test.ts; here we assert the deferred consent seam denies + notifies.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { verifyAuditChain } from "../../../src/db/audit-verify.ts";
import { InMemoryDiscoveryProvider } from "../../../src/federation/discovery.ts";
import { PeerPairing } from "../../../src/federation/peer-pairing.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";
import { runIndexedSchemaMigrations } from "../../../src/index/migrations/runner.ts";
import type { FederationRpcContext } from "../../../src/ipc/federation-rpc.ts";
import { dispatchFederationRpc } from "../../../src/ipc/federation-rpc.ts";
import { generateBoxKeypair } from "../../../src/ipc/lan-crypto.ts";
import { checkLanMethodAllowed, LanError } from "../../../src/ipc/lan-rpc.ts";

let db: Database;
let index: LocalIndex;
let notes: Array<{ method: string; params: unknown }>;

function ctx(): FederationRpcContext {
  return {
    db,
    consentTimeoutMs: 1000,
    notify: (method, params) => notes.push({ method, params }),
    discovery: new InMemoryDiscoveryProvider([
      { instanceName: "gateway-b", host: "10.0.0.2", port: 7475 },
    ]),
    pairing: new PeerPairing(index),
  };
}

beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 33);
  index = new LocalIndex(db);
  notes = [];
  db.run(
    `INSERT INTO item (id,service,type,external_id,title,body_preview,modified_at,synced_at,metadata)
     VALUES ('github:pr1','github','pull_request','pr1','Fix auth','body1',10,1,'{"secret":"x"}')`,
  );
  db.run(
    `INSERT INTO item (id,service,type,external_id,title,body_preview,modified_at,synced_at,metadata)
     VALUES ('github:pr2','github','pull_request','pr2','Add cache','body2',20,1,'{"secret":"y"}')`,
  );
  db.run(
    `INSERT INTO item (id,service,type,external_id,title,body_preview,modified_at,synced_at,metadata)
     VALUES ('gmail:e1','gmail','email','e1','Salaries','TOP SECRET',30,1,'{"secret":"z"}')`,
  );
});
afterEach(() => index.close());

test("acceptance: discover → pair → publish → grant → scoped leak-proof query → undeclared empty → revoke → verify → expertise", async () => {
  const c = ctx();

  // (criterion 9) discovery surfaces the mock peer
  const disc = await dispatchFederationRpc("federation.discover", {}, c);
  expect(disc.kind).toBe("hit");
  if (disc.kind === "hit") {
    expect((disc.value as { peers: unknown[] }).peers.length).toBe(1);
  }

  // (criterion) publish a named, filtered slice
  // Use namespace name unique to this test to avoid sessionConsent cross-contamination
  const ns = "project:zurich-accept-1";
  await dispatchFederationRpc(
    "federation.namespace.publish",
    {
      name: ns,
      filters: [
        { kind: "service", value: "github" },
        { kind: "type", value: "pull_request" },
      ],
    },
    c,
  );

  // (criterion 1) mutual pairing: in-process owner approval persists an inbound peer
  const peerKey = generateBoxKeypair().publicKey;
  const peerId = c.pairing.approveInboundPair({ peerPubkey: peerKey, hostIp: "10.0.0.2" });
  const peers = await dispatchFederationRpc("federation.peers", {}, c);
  expect(peers.kind).toBe("hit");
  if (peers.kind === "hit") {
    expect((peers.value as { peers: unknown[] }).peers.length).toBe(1);
  }

  // (criterion 1/2) a paired-but-ungranted query is rejected + audited
  const ungranted = await dispatchFederationRpc(
    "federation.query",
    { peerId, namespace: ns, purpose: "snoop" },
    c,
  );
  expect(ungranted.kind).toBe("hit");
  if (ungranted.kind === "hit") {
    const v = ungranted.value as { kind: string; error?: string };
    expect(v.kind).toBe("error");
    expect(v.error).toBe("no_grant");
  }

  // grant viewer + standing consent (unique peerId ensures no stale sessionConsent entry)
  await dispatchFederationRpc(
    "federation.namespace.grant",
    { namespace: ns, peerId, role: "viewer", standingConsent: true },
    c,
  );

  // (criteria 2 + 5) scoped, leak-proof answer: only the 2 github PRs, NO metadata/email
  const answered = await dispatchFederationRpc(
    "federation.query",
    { peerId, namespace: ns, purpose: "review" },
    c,
  );
  expect(answered.kind).toBe("hit");
  if (answered.kind === "hit") {
    const r = answered.value as {
      kind: string;
      response?: { items: Array<Record<string, unknown>> };
    };
    expect(r.kind).toBe("ok");
    const items = r.response?.items ?? [];
    expect(items.map((i) => i["id"]).sort((a, b) => String(a).localeCompare(String(b)))).toEqual([
      "github:pr1",
      "github:pr2",
    ]);
    for (const it of items) {
      expect(Object.keys(it).sort((a, b) => a.localeCompare(b))).toEqual([
        "id",
        "modifiedAt",
        "service",
        "snippet",
        "title",
        "type",
      ]);
    }
  }

  // (criterion 5) requesting an undeclared type returns empty — no leak the email exists
  const undeclared = await dispatchFederationRpc(
    "federation.query",
    { peerId, namespace: ns, purpose: "review", types: ["email"] },
    c,
  );
  expect(undeclared.kind).toBe("hit");
  if (undeclared.kind === "hit") {
    const r = undeclared.value as { kind: string; response?: { items: unknown[] } };
    expect(r.kind).toBe("ok");
    expect(r.response?.items).toEqual([]);
  }

  // (criterion 4) revoke is live-checked within the session
  await dispatchFederationRpc("federation.namespace.revoke", { namespace: ns, peerId }, c);
  const afterRevoke = await dispatchFederationRpc(
    "federation.query",
    { peerId, namespace: ns, purpose: "review" },
    c,
  );
  expect(afterRevoke.kind).toBe("hit");
  if (afterRevoke.kind === "hit") {
    const v = afterRevoke.value as { kind: string; error?: string };
    expect(v.kind).toBe("error");
    expect(v.error).toBe("no_grant");
  }

  // (criterion 3) the Blake3 audit chain still verifies after every federation event
  const verify = verifyAuditChain(index, { fromId: 0 });
  expect(verify.ok).toBe(true);
  // ungranted + answered + undeclared + post-revoke query = at least 4 audited rows
  const fedRows = db
    .query(`SELECT COUNT(*) AS n FROM audit_log WHERE federation_json IS NOT NULL`)
    .get() as { n: number };
  expect(fedRows.n).toBeGreaterThanOrEqual(4);

  // (criterion 6) expertise returns ONLY a coarse rank — zero item content
  const exp = await dispatchFederationRpc(
    "federation.expertise",
    { query: "auth", purpose: "who-knows" },
    c,
  );
  expect(exp.kind).toBe("hit");
  if (exp.kind === "hit") {
    expect(Object.keys(exp.value as object)).toEqual(["rank"]);
  }
});

test("criterion 7 / I5: only federation.query + federation.expertise are admitted over LAN", () => {
  const peer = { peerId: "p", writeAllowed: false };
  expect(() => checkLanMethodAllowed("federation.query", peer)).not.toThrow();
  expect(() => checkLanMethodAllowed("federation.expertise", peer)).not.toThrow();
  for (const m of [
    "federation.discover",
    "federation.pair",
    "federation.peers",
    "federation.namespace.publish",
    "federation.namespace.grant",
    "federation.namespace.revoke",
    "vault.get",
    "data.export",
    "extension.install",
  ]) {
    expect(() => checkLanMethodAllowed(m, peer)).toThrow(LanError);
  }
});

test("criterion 10 (deferred consent seam): a non-standing grant routes through the consent prompt → deny + notify", async () => {
  const c = ctx();
  // Unique namespace + peerId so the module-level sessionConsent cannot have a cached entry
  const ns = "ns-consent-accept-15b";
  const peerId = "peer-consent-accept-15b";
  await dispatchFederationRpc(
    "federation.namespace.publish",
    { name: ns, filters: [{ kind: "type", value: "pull_request" }] },
    c,
  );
  await dispatchFederationRpc(
    "federation.namespace.grant",
    { namespace: ns, peerId, role: "viewer", standingConsent: false },
    c,
  );
  const res = await dispatchFederationRpc(
    "federation.query",
    { peerId, namespace: ns, purpose: "review" },
    c,
  );
  expect(res.kind).toBe("hit");
  if (res.kind === "hit") {
    const v = res.value as { kind: string; error?: string };
    expect(v.kind).toBe("error");
    expect(v.error).toBe("consent_denied");
  }
  expect(notes.some((n) => n.method === "federation.consentRequest")).toBe(true);
});
