import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  publisherKeyFingerprint,
  signTrustFeed,
  signTrustStatement,
  type TrustStatement,
} from "@nimbus-dev/registry-format";
import nacl from "tweetnacl";

import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import type { RegistryFetchDeps } from "../registry/registry-fetch.ts";
import {
  applyTrustSnapshot,
  refreshTrustFeed,
  TRUST_FEED_NAME,
  type TrustFeedConfig,
  type TrustFeedResult,
} from "./trust-feed.ts";
import { TrustFeedDaemon } from "./trust-feed-daemon.ts";
import { readFeedFloor, trustStoreCounts } from "./trust-store.ts";

const b64 = (u: Uint8Array): string => Buffer.from(u).toString("base64");
const ROOT_SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 3);
const OTHER_SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 90);
const ROOT_KEY = b64(nacl.sign.keyPair.fromSeed(ROOT_SEED).publicKey);
const OTHER_KEY = b64(nacl.sign.keyPair.fromSeed(OTHER_SEED).publicKey);
const ISSUED = "2026-10-26T12:00:00Z";

let db: Database;
let dir: string;
let server: ReturnType<typeof Bun.serve> | undefined;
beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 76);
  dir = mkdtempSync(join(tmpdir(), "nimbus-trust-feed-"));
});
afterEach(() => {
  server?.stop(true);
  server = undefined;
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function deps(over: Partial<RegistryFetchDeps> = {}): RegistryFetchDeps {
  return {
    db,
    fetchFn: (url, init) => fetch(url, init),
    enforceAirGap: () => false,
    now: () => 1000,
    production: false,
    ...over,
  };
}

const revoke = (reason: string): Promise<TrustStatement> =>
  signTrustStatement(
    {
      kind: "key.revoke",
      issuedAt: ISSUED,
      signerKey: ROOT_KEY,
      publisherId: "acme",
      keyFingerprint: publisherKeyFingerprint(OTHER_KEY),
      reason,
    },
    ROOT_SEED,
  );

const verified = (publisherId: string): Promise<TrustStatement> =>
  signTrustStatement(
    {
      kind: "publisher.verified",
      issuedAt: ISSUED,
      signerKey: ROOT_KEY,
      publisherId,
      keys: [OTHER_KEY],
      github: publisherId,
      verifiedAt: ISSUED,
    },
    ROOT_SEED,
  );

async function feedText(
  sequence: number,
  statements: unknown[],
  opts: { generatedAt?: string; seed?: Uint8Array; rootKey?: string } = {},
): Promise<string> {
  const feed = await signTrustFeed(
    {
      format: 1,
      rootKey: opts.rootKey ?? ROOT_KEY,
      sequence,
      generatedAt: opts.generatedAt ?? ISSUED,
      statements,
    },
    opts.seed ?? ROOT_SEED,
  );
  return JSON.stringify(feed);
}

async function publish(sequence: number, statements: unknown[], generatedAt?: string) {
  writeFileSync(
    join(dir, "trust.json"),
    await feedText(sequence, statements, generatedAt === undefined ? {} : { generatedAt }),
  );
}

const CFG = (): TrustFeedConfig => ({ url: dir, rootKey: ROOT_KEY });
const egressRows = (): number =>
  (db.query("SELECT COUNT(*) AS n FROM egress_ledger").get() as { n: number }).n;

describe("refreshTrustFeed", () => {
  test("no feed configured: nothing is fetched and no egress row is written", async () => {
    expect(await refreshTrustFeed({ ...deps(), trustFeed: null })).toEqual({
      status: "not_configured",
    });
    expect(egressRows()).toBe(0);
  });

  test("accepts a feed, records its blocks and verifications, and anchors the floor", async () => {
    await publish(3, [await revoke("a"), await verified("acme")]);
    const r = await refreshTrustFeed({ ...deps(), trustFeed: CFG() });
    expect(r).toMatchObject({ status: "accepted", sequence: 3, verified: 1 });
    expect(trustStoreCounts(db)).toMatchObject({ revocations: 1, verifiedPublishers: 1 });
    expect(readFeedFloor(db, TRUST_FEED_NAME)?.lastSequence).toBe(3);
  });

  test("the same document again is unchanged; a higher sequence is accepted", async () => {
    await publish(3, [await revoke("a")]);
    await refreshTrustFeed({ ...deps(), trustFeed: CFG() });
    expect(await refreshTrustFeed({ ...deps(), trustFeed: CFG() })).toEqual({
      status: "unchanged",
      sequence: 3,
    });
    await publish(4, [await revoke("a"), await revoke("b")]);
    expect((await refreshTrustFeed({ ...deps(), trustFeed: CFG() })).status).toBe("accepted");
    expect(trustStoreCounts(db).revocations).toBe(2);
  });

  test("different content at an accepted sequence is refused, and nothing it carried is stored", async () => {
    await publish(3, [await revoke("a")]);
    await refreshTrustFeed({ ...deps(), trustFeed: CFG() });
    await publish(3, [await revoke("a"), await revoke("planted")], "2026-10-27T00:00:00Z");
    expect(await refreshTrustFeed({ ...deps(), trustFeed: CFG() })).toMatchObject({
      status: "refused",
      code: "ERR_TRUST_FEED_EQUIVOCATION",
    });
    expect(trustStoreCounts(db).revocations).toBe(1);
  });

  test("a lower sequence is refused as a rollback", async () => {
    await publish(5, []);
    await refreshTrustFeed({ ...deps(), trustFeed: CFG() });
    await publish(4, []);
    expect(await refreshTrustFeed({ ...deps(), trustFeed: CFG() })).toMatchObject({
      status: "refused",
      code: "ERR_TRUST_FEED_ROLLBACK",
    });
    expect(readFeedFloor(db, TRUST_FEED_NAME)?.lastAttemptedAt).toBe(1000);
  });

  test("a feed signed by another root is refused", async () => {
    writeFileSync(
      join(dir, "trust.json"),
      await feedText(1, [], { seed: OTHER_SEED, rootKey: OTHER_KEY }),
    );
    expect(await refreshTrustFeed({ ...deps(), trustFeed: CFG() })).toMatchObject({
      status: "refused",
      code: "ERR_TRUST_FEED_ROOT_KEY_CHANGED",
    });
  });

  test("a remote feed appends one registry-class row named for the feed; air gap refuses with none", async () => {
    const body = await feedText(1, []);
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(body) });
    const remote: TrustFeedConfig = { url: `http://127.0.0.1:${server.port}/`, rootKey: ROOT_KEY };
    expect((await refreshTrustFeed({ ...deps(), trustFeed: remote })).status).toBe("accepted");
    expect(db.query("SELECT source_type, destination, method FROM egress_ledger").all()).toEqual([
      { source_type: "registry", destination: TRUST_FEED_NAME, method: "trust.feed" },
    ]);
    const gapped = await refreshTrustFeed({
      ...deps({ enforceAirGap: () => true }),
      trustFeed: remote,
    });
    expect(gapped).toMatchObject({ status: "refused", code: "ERR_REGISTRY_AIR_GAP" });
    expect(egressRows()).toBe(1);
  });
});

describe("applyTrustSnapshot", () => {
  test("applies offline, anchoring the floor so an older fetched feed is refused", async () => {
    const snap = await feedText(7, [await revoke("baked")]);
    expect(await applyTrustSnapshot(db, snap, CFG(), 1)).toMatchObject({
      status: "accepted",
      sequence: 7,
    });
    expect(trustStoreCounts(db).revocations).toBe(1);
    await publish(6, []);
    expect((await refreshTrustFeed({ ...deps(), trustFeed: CFG() })).status).toBe("refused");
  });

  test("a snapshot older than the stored floor is unchanged, not refused", async () => {
    await publish(9, []);
    await refreshTrustFeed({ ...deps(), trustFeed: CFG() });
    expect(await applyTrustSnapshot(db, await feedText(7, []), CFG(), 1)).toEqual({
      status: "unchanged",
      sequence: 9,
    });
  });

  test("a snapshot moves the floor without claiming a fetch, and its verifications say snapshot", async () => {
    await applyTrustSnapshot(db, await feedText(7, [await verified("acme")]), CFG(), 1);
    expect(readFeedFloor(db, TRUST_FEED_NAME)).toMatchObject({
      lastSequence: 7,
      lastFetchedAt: null,
      lastAttemptedAt: null,
    });
    expect(
      db.query("SELECT source FROM trust_statement WHERE kind = 'publisher.verified'").all(),
    ).toEqual([{ source: "snapshot" }]);
  });

  test("the same snapshot on a later boot is unchanged and leaves the last fetch time alone", async () => {
    await publish(7, []);
    await refreshTrustFeed({ ...deps({ now: () => 500 }), trustFeed: CFG() });
    const snap = await feedText(7, []);
    // A fetched feed at 7 is stored; a snapshot at the same sequence must not refresh "last fetched".
    expect(await applyTrustSnapshot(db, snap, CFG(), 9_999)).toEqual({
      status: "unchanged",
      sequence: 7,
    });
    expect(readFeedFloor(db, TRUST_FEED_NAME)?.lastFetchedAt).toBe(500);
  });

  test("no snapshot or no feed configured: not_configured", async () => {
    expect(await applyTrustSnapshot(db, null, CFG(), 1)).toEqual({ status: "not_configured" });
    expect(await applyTrustSnapshot(db, "{}", null, 1)).toEqual({ status: "not_configured" });
  });
});

describe("TrustFeedDaemon", () => {
  const logger = { info: () => {}, warn: () => {} };

  test("overlapping refreshes share one in-flight request", async () => {
    let calls = 0;
    let release: (r: TrustFeedResult) => void = () => {};
    const daemon = new TrustFeedDaemon({
      refresh: () => {
        calls++;
        return new Promise<TrustFeedResult>((resolve) => {
          release = resolve;
        });
      },
      intervalHours: 1,
      logger,
    });
    const a = daemon.refreshNow();
    const b = daemon.refreshNow();
    expect(a).toBe(b);
    release({ status: "not_configured" });
    expect(await a).toEqual({ status: "not_configured" });
    expect(calls).toBe(1);
    // Once settled, the next refresh is a new request.
    const c = daemon.refreshNow();
    expect(c).not.toBe(a);
    release({ status: "not_configured" });
    await c;
    expect(calls).toBe(2);
  });

  test("a throwing refresh resolves as refused", async () => {
    const daemon = new TrustFeedDaemon({
      refresh: () => Promise.reject(new Error("boom")),
      intervalHours: 1,
      logger,
    });
    expect(await daemon.refreshNow()).toMatchObject({ status: "refused", detail: "boom" });
  });

  test("start runs a first refresh after its delay; stop clears the timers", async () => {
    let calls = 0;
    const daemon = new TrustFeedDaemon({
      refresh: () => {
        calls++;
        return Promise.resolve({ status: "not_configured" });
      },
      intervalHours: 1,
      logger,
      firstRefreshDelayMs: 1,
    });
    daemon.start();
    await new Promise((r) => setTimeout(r, 30));
    daemon.stop();
    expect(calls).toBe(1);
  });
});
