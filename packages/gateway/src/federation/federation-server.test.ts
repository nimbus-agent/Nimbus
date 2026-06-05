import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { LocalIndex } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { outboundPairHandshake } from "../ipc/lan-client.ts";
import { generateBoxKeypair } from "../ipc/lan-crypto.ts";
import { generatePairingCode } from "../ipc/lan-pairing.ts";
import { buildFederationLanServer } from "./federation-server.ts";

let stop: (() => Promise<void>) | undefined;
afterEach(async () => {
  await stop?.();
  stop = undefined;
});

test("buildFederationLanServer registers an inbound peer on a valid pair handshake", async () => {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 33);
  const index = new LocalIndex(db);
  db.run(`INSERT INTO item (id,service,type,external_id,title,body_preview,modified_at,synced_at,metadata)
          VALUES ('github:pr1','github','pull_request','pr1','Fix','b',10,1,'{}')`);

  const identity = generateBoxKeypair();
  const built = buildFederationLanServer({
    db,
    index,
    identity,
    lan: {
      bind: "127.0.0.1",
      port: 0,
      pairingWindowSeconds: 60,
      maxFailedAttempts: 3,
      lockoutSeconds: 60,
    },
    consentTimeoutMs: 1000,
    notify: () => {},
  });
  await built.lanServer.start();
  stop = () => built.lanServer.stop();
  const port = built.lanServer.listenAddr()?.port as number;

  const code = generatePairingCode();
  built.pairingWindow.open(code);
  const askerKp = generateBoxKeypair();
  // outboundPairHandshake takes 4 args: (host, port, code, selfKp)
  const hostPub = await outboundPairHandshake("127.0.0.1", port, code, askerKp);
  expect(Buffer.from(hostPub).toString("hex")).toBe(
    Buffer.from(identity.publicKey).toString("hex"),
  );

  // an inbound, read-only peer row now exists
  const row = index.getLanPeerByPubkey(askerKp.publicKey);
  expect(row).toBeDefined();
  expect(row?.direction).toBe("inbound");
  expect(row?.write_allowed).toBe(0);
  index.close();
});
