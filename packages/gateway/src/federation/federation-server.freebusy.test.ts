import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { bytesToHex } from "@noble/hashes/utils.js";
import { LocalIndex } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { outboundPairHandshake, sendFederatedOverWire } from "../ipc/lan-client.ts";
import { generateBoxKeypair } from "../ipc/lan-crypto.ts";
import { generatePairingCode } from "../ipc/lan-pairing.ts";
import { BLOCK_MS, floorToBlock } from "./_lib/free-busy-blocks.ts";
import { buildFederationLanServer, type FederationLanServer } from "./federation-server.ts";
import { FreeBusyLimiter } from "./free-busy-limiter.ts";
import { askPeerFreeBusy } from "./schedule-ask.ts";

let built: FederationLanServer | undefined;
afterEach(async () => {
  await built?.lanServer.stop();
  built = undefined;
});

async function failure(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

const LINK = { known: 1, minProtocol: 1 } as const;

async function boot(opts: { approve?: (() => Promise<boolean>) | undefined; configured: boolean }) {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, LocalIndex.SCHEMA_VERSION);
  const index = new LocalIndex(db);
  const now = Date.now();
  const from = floorToBlock(now) + 2 * BLOCK_MS;
  db.run("INSERT INTO sync_state (connector_id,last_sync_at) VALUES ('google_calendar', ?)", [now]);
  db.run(
    `INSERT INTO item (id,service,type,external_id,title,modified_at,synced_at,metadata)
     VALUES ('ev:1','google_calendar','event','1','WIRE-SECRET-TITLE',1,1,?)`,
    [
      JSON.stringify({
        start_ms: from + BLOCK_MS,
        end_ms: from + 2 * BLOCK_MS,
        all_day: false,
        status: "confirmed",
        self_response: "accepted",
        attendee_count: 2,
        organizer_email: "wire-secret@example.com",
      }),
    ],
  );
  const identity = generateBoxKeypair();
  const requests: Array<{ peerId: string; fromMs: number; toMs: number }> = [];
  built = buildFederationLanServer({
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
    ...(opts.configured
      ? {
          freeBusy: {
            db,
            limiter: new FreeBusyLimiter(),
            requestApproval: async (input) => {
              requests.push(input);
              return opts.approve === undefined ? true : opts.approve();
            },
          },
        }
      : {}),
  });
  await built.lanServer.start();
  const port = built.lanServer.listenAddr()?.port as number;
  const code = generatePairingCode();
  built.pairingWindow.open(code);
  const askerKp = generateBoxKeypair();
  await outboundPairHandshake("127.0.0.1", port, code, askerKp);
  const askerPeerId = `peer:${bytesToHex(askerKp.publicKey.subarray(0, 8))}`;
  const send = (method: string, params: unknown) =>
    sendFederatedOverWire(
      "127.0.0.1",
      port,
      askerKp,
      identity.publicKey,
      method,
      params,
      undefined,
      LINK,
    );
  return { db, from, send, requests, askerPeerId };
}

test("a paired peer's request reaches the gate with the authenticated id and gets blocks only", async () => {
  const { from, send, requests, askerPeerId } = await boot({ configured: true });
  const res = await send("federation.freeBusy", {
    fromMs: from,
    toMs: from + 4 * BLOCK_MS,
    peerId: "peer:bogus",
  });
  expect(requests).toEqual([{ peerId: askerPeerId, fromMs: from, toMs: from + 4 * BLOCK_MS }]);
  expect(res).toEqual({
    kind: "ok",
    reply: { fromMs: from, blockMs: BLOCK_MS, blocks: "0100" },
  });
  const wire = JSON.stringify(res);
  expect(wire).not.toContain("WIRE-SECRET");
  expect(wire).not.toContain("wire-secret");
});

test("a denial by the owner reaches the peer as the fixed refusal", async () => {
  const { from, send } = await boot({ configured: true, approve: async () => false });
  expect(await send("federation.freeBusy", { fromMs: from, toMs: from + 4 * BLOCK_MS })).toEqual({
    kind: "error",
    error: "declined",
  });
});

test("a gateway not configured to answer fails closed", async () => {
  const { from, send } = await boot({ configured: false });
  expect(
    await failure(send("federation.freeBusy", { fromMs: from, toMs: from + 4 * BLOCK_MS })),
  ).toMatch(/ERR_FREEBUSY_UNAVAILABLE/);
});

test("the owner-only scheduling methods are not callable over the wire", async () => {
  const { send } = await boot({ configured: true });
  expect(await failure(send("scheduling.respond", { requestId: "x", approved: true }))).toMatch(
    /not callable over LAN/,
  );
  expect(await failure(send("scheduling.ask", {}))).toMatch(/not callable over LAN/);
});

test("end to end: the asking side intersects the peer's blocks with its own", async () => {
  const peer = await boot({ configured: true });
  const mine = new Database(":memory:");
  runIndexedSchemaMigrations(mine, LocalIndex.SCHEMA_VERSION);
  mine.run("INSERT INTO sync_state (connector_id,last_sync_at) VALUES ('apple', ?)", [Date.now()]);
  mine.run(
    `INSERT INTO item (id,service,type,external_id,title,modified_at,synced_at,metadata)
     VALUES ('ev:m','apple','event','m','mine',1,1,?)`,
    [
      JSON.stringify({
        start_ms: peer.from + 2 * BLOCK_MS,
        end_ms: peer.from + 3 * BLOCK_MS,
        all_day: false,
        status: "confirmed",
        self_response: "accepted",
      }),
    ],
  );
  const result = await askPeerFreeBusy(
    { db: mine, send: (p) => peer.send("federation.freeBusy", p) },
    { fromMs: peer.from, toMs: peer.from + 4 * BLOCK_MS, durationMs: BLOCK_MS },
  );
  // peer busy at block 1, mine busy at block 2: free at 0 and 3 only
  expect(result).toMatchObject({
    kind: "ok",
    slots: [
      { startMs: peer.from, endMs: peer.from + BLOCK_MS },
      { startMs: peer.from + 3 * BLOCK_MS, endMs: peer.from + 4 * BLOCK_MS },
    ],
  });
});
