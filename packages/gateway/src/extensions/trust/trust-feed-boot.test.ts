import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signTrustFeed, signTrustStatement, trustStatementId } from "@nimbus-dev/registry-format";
import nacl from "tweetnacl";

import { listExtensions } from "../../automation/extension-store.ts";
import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import { encodeBase64 } from "../../util/base64.ts";
import { MockVault } from "../../vault/mock.ts";
import { writePublisherKey } from "../publisher-keys.ts";
import type { RegistryFetchDeps } from "../registry/registry-fetch.ts";
import { BUILTIN_TRUST_FEED, BUILTIN_TRUST_SNAPSHOT, TRUST_FEED_NAME } from "./trust-feed.ts";
import { prepareTrustAtBoot, startTrustFeedForBoot } from "./trust-feed-boot.ts";
import { readFeedFloor } from "./trust-store.ts";

const ROOT_KEY = Buffer.from(
  nacl.sign.keyPair.fromSeed(Uint8Array.from({ length: 32 }, (_, i) => i + 3)).publicKey,
).toString("base64");

let db: Database;
let dir: string;
beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 77);
  dir = mkdtempSync(join(tmpdir(), "nimbus-trust-boot-"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function recordingLogger() {
  const info: string[] = [];
  const warn: string[] = [];
  return {
    info,
    warn,
    logger: {
      info: (_o: unknown, msg: string) => void info.push(msg),
      warn: (_o: unknown, msg: string) => void warn.push(msg),
    } as never,
  };
}

const registryFetch = (): Omit<RegistryFetchDeps, "db"> => ({
  fetchFn: (url, init) => fetch(url, init),
  enforceAirGap: () => false,
  now: () => 1000,
  production: false,
});

describe("prepareTrustAtBoot", () => {
  test("with the baked defaults it applies the baked snapshot (no network) and logs nothing", async () => {
    const log = recordingLogger();
    await prepareTrustAtBoot({ db, vault: new MockVault(), logger: log.logger });
    const baked = JSON.parse(BUILTIN_TRUST_SNAPSHOT ?? "null") as { sequence: number };
    const floor = readFeedFloor(db, TRUST_FEED_NAME);
    expect(floor?.lastSequence).toBe(baked.sequence);
    // A snapshot is not a fetch: `trust status` must not report the feed as fetched.
    expect(floor?.lastFetchedAt ?? null).toBeNull();
    expect(log.info).toEqual([]);
    expect(log.warn).toEqual([]);
  });

  test("with no feed and no snapshot it does nothing", async () => {
    const log = recordingLogger();
    await prepareTrustAtBoot({
      db,
      vault: new MockVault(),
      logger: log.logger,
      trustFeed: null,
      snapshot: null,
    });
    expect(readFeedFloor(db, TRUST_FEED_NAME)).toBeUndefined();
    expect(log.warn).toEqual([]);
  });

  test("backfills a signed install's verifying key and says so", async () => {
    const key = Uint8Array.from({ length: 32 }, (_, i) => i + 7);
    const vault = new MockVault();
    await writePublisherKey(vault, "acme", key);
    const extDir = join(dir, "acme_a");
    mkdirSync(extDir);
    writeFileSync(
      join(extDir, "nimbus.extension.json"),
      JSON.stringify({
        id: "acme/a",
        version: "1.0.0",
        publisher: { id: "acme", key: encodeBase64(key) },
        signature: `${"A".repeat(86)}==`,
        permissions: {},
      }),
    );
    db.run(
      `INSERT INTO extension (id, version, install_path, manifest_hash, entry_hash, enabled, installed_at, last_verified_at)
       VALUES ('acme/a', '1.0.0', ?, 'm', 'e', 1, 1, 1)`,
      [extDir],
    );
    const log = recordingLogger();
    await prepareTrustAtBoot({ db, vault, logger: log.logger });
    expect(listExtensions(db)[0]?.publisher_key_fingerprint).toBeString();
    expect(log.info).toEqual(["recorded verifying-key fingerprints"]);
  });

  test("statements the snapshot newly stores reach the enforcement hook", async () => {
    const seed = Uint8Array.from({ length: 32 }, (_, i) => i + 3);
    const s = await signTrustStatement(
      {
        kind: "key.revoke",
        issuedAt: "2026-10-26T12:00:00Z",
        signerKey: ROOT_KEY,
        publisherId: "acme",
        keyFingerprint: "0".repeat(32),
        reason: "baked",
      },
      seed,
    );
    const snapshot = JSON.stringify(
      await signTrustFeed(
        {
          format: 1,
          rootKey: ROOT_KEY,
          sequence: 1,
          generatedAt: "2026-10-26T12:00:00Z",
          statements: [s],
        },
        seed,
      ),
    );
    const seen: string[][] = [];
    await prepareTrustAtBoot({
      db,
      vault: new MockVault(),
      logger: recordingLogger().logger,
      trustFeed: { url: dir, rootKey: ROOT_KEY },
      snapshot,
      onTrustRecorded: (ids) => void seen.push([...ids]),
    });
    expect(seen).toEqual([[trustStatementId(s)]]);
  });

  test("a failed backfill is logged and does not stop the snapshot step", async () => {
    const bare = new Database(":memory:");
    bare.run("PRAGMA user_version = 76"); // claims V76 but has no extension table
    const log = recordingLogger();
    await prepareTrustAtBoot({
      db: bare,
      vault: new MockVault(),
      logger: log.logger,
      trustFeed: { url: dir, rootKey: ROOT_KEY },
      snapshot: "not a feed",
    });
    bare.close();
    expect(log.warn).toEqual([
      "verifying-key fingerprint backfill failed",
      "baked trust snapshot refused",
    ]);
  });
});

describe("startTrustFeedForBoot", () => {
  test("a demo-rooted gateway gets no handle and starts no timer", () => {
    const stops: Array<() => void> = [];
    const handle = startTrustFeedForBoot({
      db,
      configDir: dir,
      demoRooted: true,
      registryFetch: registryFetch(),
      logger: recordingLogger().logger,
      sidecarStops: stops,
      trustFeed: { url: dir, rootKey: ROOT_KEY },
    });
    expect(handle).toBeUndefined();
    expect(stops).toEqual([]);
  });

  test("by default the handle follows the baked feed and its timer is registered", () => {
    const stops: Array<() => void> = [];
    const handle = startTrustFeedForBoot({
      db,
      configDir: dir,
      demoRooted: false,
      registryFetch: registryFetch(),
      logger: recordingLogger().logger,
      sidecarStops: stops,
    });
    try {
      expect(handle?.config).toEqual(BUILTIN_TRUST_FEED);
      expect(stops).toHaveLength(1);
    } finally {
      // Stopped before the first refresh is due: this test never reaches the network.
      for (const stop of stops) stop();
    }
  });

  test("with no feed configured the handle answers but no timer starts", async () => {
    const stops: Array<() => void> = [];
    const handle = startTrustFeedForBoot({
      db,
      configDir: dir,
      demoRooted: false,
      registryFetch: registryFetch(),
      logger: recordingLogger().logger,
      sidecarStops: stops,
      trustFeed: null,
    });
    expect(handle?.config).toBeNull();
    expect(handle?.intervalHours).toBe(1);
    expect(stops).toEqual([]);
    expect(await handle?.refreshNow()).toEqual({ status: "not_configured" });
  });

  test("a configured feed starts the timer, registers its stop, and refreshes on demand", async () => {
    const stops: Array<() => void> = [];
    const log = recordingLogger();
    const handle = startTrustFeedForBoot({
      db,
      configDir: dir,
      demoRooted: false,
      registryFetch: registryFetch(),
      logger: log.logger,
      sidecarStops: stops,
      trustFeed: { url: dir, rootKey: ROOT_KEY },
    });
    try {
      expect(stops).toHaveLength(1);
      // No trust.json in the directory: refused, never thrown.
      expect((await handle?.refreshNow())?.status).toBe("refused");
      expect(log.warn).toEqual(["trust feed refresh refused"]);
    } finally {
      for (const stop of stops) stop();
    }
  });
});
