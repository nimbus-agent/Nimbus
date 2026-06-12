import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { dispatchFederationRpc, type FederationRpcContext } from "./federation-rpc.ts";

function ctx(db: Database): FederationRpcContext {
  return {
    db,
    consentTimeoutMs: 1000,
    notify: () => {},
    discovery: { list: async () => [] } as unknown as FederationRpcContext["discovery"],
    pairing: { listPeers: () => [] } as unknown as FederationRpcContext["pairing"],
  };
}

test("federation.probe returns the content-free recency answer", async () => {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 38);
  const out = await dispatchFederationRpc(
    "federation.probe",
    { resourceRef: "i-12345", purpose: "j", peerId: "peer:a" },
    ctx(db),
  );
  expect(out.kind).toBe("hit");
  if (out.kind === "hit") expect(out.value).toEqual({ touched: false });
});

test("federation.probe reports recency for a touched resource", async () => {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 38);
  const dayMs = 86_400_000;
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at)
     VALUES ('x', 'aws', 'note', 'ext-x', 'i-12345 box', null, ?, ?)`,
    [5 * dayMs, 5 * dayMs],
  );
  const out = await dispatchFederationRpc(
    "federation.probe",
    { resourceRef: "i-12345", purpose: "j", peerId: "peer:a" },
    ctx(db),
  );
  expect(out.kind).toBe("hit");
  if (out.kind === "hit") expect((out.value as { touched: boolean }).touched).toBe(true);
});
