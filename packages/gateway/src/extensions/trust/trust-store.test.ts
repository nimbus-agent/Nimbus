import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  publisherKeyFingerprint,
  signTrustStatement,
  type TrustStatement,
  type UnsignedTrustStatement,
} from "@nimbus-dev/registry-format";
import nacl from "tweetnacl";

import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import {
  MAX_STORED_STATEMENTS_PER_SOURCE,
  readFeedFloor,
  recordFeedAccepted,
  recordFeedAttempt,
  recordTrustStatements,
  replaceCurrentVerifications,
  type StatementSource,
  trustStoreCounts,
} from "./trust-store.ts";

const b64 = (u: Uint8Array): string => Buffer.from(u).toString("base64");
const seed = (start: number): Uint8Array => Uint8Array.from({ length: 32 }, (_, i) => start + i);
const NIMBUS_SEED = seed(1);
const REGISTRY_SEED = seed(40);
const PUB_SEED = seed(80);
const OTHER_SEED = seed(120);
const key = (s: Uint8Array): string => b64(nacl.sign.keyPair.fromSeed(s).publicKey);
const NIMBUS_KEY = key(NIMBUS_SEED);
const REGISTRY_KEY = key(REGISTRY_SEED);
const PUB_KEY = key(PUB_SEED);
const OTHER_KEY = key(OTHER_SEED);
const ISSUED = "2026-10-26T12:00:00Z";

const FEED: StatementSource = { kind: "feed", nimbusRootKey: NIMBUS_KEY };
function registrySource(listed: Record<string, string[]> = {}): StatementSource {
  return {
    kind: "registry",
    name: "community",
    rootKey: REGISTRY_KEY,
    rootFingerprint: publisherKeyFingerprint(REGISTRY_KEY),
    listedPublisherKeys: new Map(Object.entries(listed).map(([p, ks]) => [p, new Set(ks)])),
  };
}

const revoke = (signer: string, s: Uint8Array, reason = "leaked"): Promise<TrustStatement> =>
  signTrustStatement(
    {
      kind: "key.revoke",
      issuedAt: ISSUED,
      signerKey: signer,
      publisherId: "acme",
      keyFingerprint: publisherKeyFingerprint(PUB_KEY),
      reason,
    },
    s,
  );

const takedown = (signer: string, s: Uint8Array): Promise<TrustStatement> =>
  signTrustStatement(
    {
      kind: "extension.takedown",
      issuedAt: ISSUED,
      signerKey: signer,
      extensionId: "acme/deploy",
      publisherId: "acme",
      versions: "*",
      reason: "malware",
    },
    s,
  );

const verified = (publisherId: string, keys: string[], s = NIMBUS_SEED, signer = NIMBUS_KEY) =>
  signTrustStatement(
    {
      kind: "publisher.verified",
      issuedAt: ISSUED,
      signerKey: signer,
      publisherId,
      keys,
      github: publisherId,
      verifiedAt: ISSUED,
    } as UnsignedTrustStatement,
    s,
  );

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 76);
});
afterEach(() => db.close());

type Row = { kind: string; signer_role: string; source: string; scope_registry: string | null };
const rows = (): Row[] =>
  db
    .query("SELECT kind, signer_role, source, scope_registry FROM trust_statement ORDER BY rowid")
    .all() as Row[];

describe("recordTrustStatements: authority", () => {
  test("a Nimbus-signed revoke from the feed is stored as nimbus, unscoped", async () => {
    const out = recordTrustStatements(db, [await revoke(NIMBUS_KEY, NIMBUS_SEED)], FEED, 1);
    expect(out).toEqual({ inserted: 1, alreadyKnown: 0, refused: 0, capped: 0 });
    expect(rows()).toEqual([
      { kind: "key.revoke", signer_role: "nimbus", source: "feed", scope_registry: null },
    ]);
  });

  test("a registry-root takedown is stored scoped to that registry", async () => {
    const out = recordTrustStatements(
      db,
      [await takedown(REGISTRY_KEY, REGISTRY_SEED)],
      registrySource(),
      1,
    );
    expect(out.inserted).toBe(1);
    expect(rows()).toEqual([
      {
        kind: "extension.takedown",
        signer_role: "registry",
        source: "registry:community",
        scope_registry: "community",
      },
    ]);
  });

  test("a statement signed by an unrelated key is refused", async () => {
    const out = recordTrustStatements(db, [await revoke(OTHER_KEY, OTHER_SEED)], FEED, 1);
    expect(out).toEqual({ inserted: 0, alreadyKnown: 0, refused: 1, capped: 0 });
    expect(rows()).toEqual([]);
  });

  test("publisher.verified never enters through recordTrustStatements, even from the feed", async () => {
    const fromFeed = recordTrustStatements(db, [await verified("acme", [PUB_KEY])], FEED, 1);
    const fromRegistry = recordTrustStatements(
      db,
      [await verified("acme", [PUB_KEY], REGISTRY_SEED, REGISTRY_KEY)],
      registrySource(),
      1,
    );
    expect(fromFeed.refused + fromRegistry.refused).toBe(2);
    expect(rows()).toEqual([]);
  });
});

describe("recordTrustStatements: admission and idempotence", () => {
  test("a publisher self-revoke from a registry that does not list that publisher is capped", async () => {
    const out = recordTrustStatements(db, [await revoke(PUB_KEY, PUB_SEED)], registrySource(), 1);
    expect(out.capped).toBe(1);
    expect(rows()).toEqual([]);
  });

  test("... and admitted when the registry's index lists that publisher with that key", async () => {
    const out = recordTrustStatements(
      db,
      [await revoke(PUB_KEY, PUB_SEED)],
      registrySource({ acme: [PUB_KEY] }),
      1,
    );
    expect(out.inserted).toBe(1);
    expect(rows()[0]?.signer_role).toBe("publisher");
  });

  test("... and admitted when an installed extension was verified with that key", async () => {
    db.run(
      `INSERT INTO extension (id, version, install_path, manifest_hash, entry_hash, enabled, installed_at, last_verified_at, publisher_key_fingerprint)
       VALUES ('acme/deploy', '1.0.0', '/x', 'm', 'e', 1, 1, 1, ?)`,
      [publisherKeyFingerprint(PUB_KEY)],
    );
    const out = recordTrustStatements(db, [await revoke(PUB_KEY, PUB_SEED)], registrySource(), 1);
    expect(out.inserted).toBe(1);
  });

  test("the same statement twice is stored once, keeping the first source", async () => {
    const s = await revoke(PUB_KEY, PUB_SEED);
    expect(recordTrustStatements(db, [s], FEED, 1).inserted).toBe(1);
    const again = recordTrustStatements(db, [s], registrySource({ acme: [PUB_KEY] }), 2);
    expect(again).toEqual({ inserted: 0, alreadyKnown: 1, refused: 0, capped: 0 });
    expect(rows().map((r) => r.source)).toEqual(["feed"]);
  });

  test("publisher-signed statements stop at the per-registry cap; the registry's own blocks never do", async () => {
    const listed = registrySource({ acme: [PUB_KEY] });
    const publisherSigned = await Promise.all(
      Array.from({ length: MAX_STORED_STATEMENTS_PER_SOURCE + 1 }, (_, i) =>
        revoke(PUB_KEY, PUB_SEED, `p${i}`),
      ),
    );
    const out = recordTrustStatements(db, publisherSigned, listed, 1);
    expect(out.inserted).toBe(MAX_STORED_STATEMENTS_PER_SOURCE);
    expect(out.capped).toBe(1);
    // The cap is full, and a later root-signed revocation from the same registry is still stored.
    const rootSigned = await Promise.all(
      Array.from({ length: 3 }, (_, i) => revoke(REGISTRY_KEY, REGISTRY_SEED, `root${i}`)),
    );
    expect(recordTrustStatements(db, rootSigned, listed, 2).inserted).toBe(3);
    const feedOut = recordTrustStatements(
      db,
      [await revoke(NIMBUS_KEY, NIMBUS_SEED, "past the registry cap")],
      FEED,
      1,
    );
    expect(feedOut.inserted).toBe(1);
  });

  test("a rotation is admitted when the registry lists its NEW key (the old one is not listed)", async () => {
    const rotate = await signTrustStatement(
      {
        kind: "key.rotate",
        issuedAt: ISSUED,
        signerKey: OTHER_KEY,
        publisherId: "acme",
        fromKey: OTHER_KEY,
        toKey: PUB_KEY,
      },
      OTHER_SEED,
    );
    expect(
      recordTrustStatements(db, [rotate], registrySource({ acme: [PUB_KEY] }), 1).inserted,
    ).toBe(1);
    const stored = db
      .query("SELECT key_fingerprint, to_key_fingerprint FROM trust_statement")
      .get() as { key_fingerprint: string; to_key_fingerprint: string };
    expect(stored).toEqual({
      key_fingerprint: publisherKeyFingerprint(OTHER_KEY),
      to_key_fingerprint: publisherKeyFingerprint(PUB_KEY),
    });
  });
});

describe("replaceCurrentVerifications", () => {
  test("a later feed's set replaces the earlier one; non-Nimbus entries are ignored", async () => {
    expect(
      replaceCurrentVerifications(db, [await verified("acme", [PUB_KEY])], NIMBUS_KEY, 1),
    ).toBe(1);
    const second = [
      await verified("globex", [OTHER_KEY]),
      await verified("evil", [OTHER_KEY], REGISTRY_SEED, REGISTRY_KEY),
    ];
    expect(replaceCurrentVerifications(db, second, NIMBUS_KEY, 2)).toBe(1);
    expect(trustStoreCounts(db).verifiedPublishers).toBe(1);
    const ids = (
      db
        .query("SELECT publisher_id FROM trust_statement WHERE kind = 'publisher.verified'")
        .all() as Array<{
        publisher_id: string;
      }>
    ).map((r) => r.publisher_id);
    expect(ids).toEqual(["globex"]);
  });

  test("blocks are untouched by a verification replace", async () => {
    recordTrustStatements(db, [await revoke(NIMBUS_KEY, NIMBUS_SEED)], FEED, 1);
    replaceCurrentVerifications(db, [], NIMBUS_KEY, 2);
    expect(trustStoreCounts(db).revocations).toBe(1);
  });
});

describe("the feed floor", () => {
  const accept = (sequence: number, documentSha256: string, rootKey = NIMBUS_KEY) =>
    recordFeedAccepted(db, "nimbus-trust", {
      rootKey,
      sequence,
      documentSha256,
      generatedAt: ISSUED,
      now: 10,
    });

  test("accepts a first document, the same again, and a higher sequence", () => {
    expect(accept(3, "hA")).toBe("accepted");
    expect(accept(3, "hA")).toBe("accepted");
    expect(accept(4, "hB")).toBe("accepted");
    expect(readFeedFloor(db, "nimbus-trust")).toMatchObject({
      lastSequence: 4,
      lastDocumentSha256: "hB",
      lastFetchedAt: 10,
    });
  });

  test("refuses a lower sequence and different content at the same one", () => {
    accept(3, "hA");
    expect(accept(2, "hX")).toBe("rollback");
    expect(accept(3, "hB")).toBe("equivocation");
    expect(readFeedFloor(db, "nimbus-trust")?.lastDocumentSha256).toBe("hA");
  });

  test("a new root key starts a new floor (a release re-pin)", () => {
    accept(9, "hA");
    expect(accept(1, "hZ", OTHER_KEY)).toBe("accepted");
    expect(readFeedFloor(db, "nimbus-trust")).toMatchObject({
      rootKey: OTHER_KEY,
      lastSequence: 1,
    });
  });

  test("an attempt is recorded on an existing row only", () => {
    recordFeedAttempt(db, "nimbus-trust", 5);
    expect(readFeedFloor(db, "nimbus-trust")).toBeUndefined();
    accept(1, "hA");
    recordFeedAttempt(db, "nimbus-trust", 99);
    expect(readFeedFloor(db, "nimbus-trust")?.lastAttemptedAt).toBe(99);
  });
});

describe("trustStoreCounts", () => {
  test("counts each kind and each source", async () => {
    recordTrustStatements(db, [await revoke(NIMBUS_KEY, NIMBUS_SEED)], FEED, 1);
    recordTrustStatements(db, [await takedown(REGISTRY_KEY, REGISTRY_SEED)], registrySource(), 1);
    expect(trustStoreCounts(db)).toEqual({
      revocations: 1,
      takedowns: 1,
      rotations: 0,
      verifiedPublishers: 0,
      bySource: { feed: 1, "registry:community": 1 },
    });
  });
});
