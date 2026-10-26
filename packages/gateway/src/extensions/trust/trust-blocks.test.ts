import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  publisherKeyFingerprint,
  signTrustStatement,
  type TrustStatement,
} from "@nimbus-dev/registry-format";
import nacl from "tweetnacl";

import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import {
  acknowledgementJson,
  assertNotBlocked,
  type BlockSubject,
  blockSubjectForInstalled,
  blocksFor,
  blocksForInstalled,
  MAX_REASON_CHARS,
  TrustBlockError,
  UNREADABLE_REASON,
  unacknowledged,
} from "./trust-blocks.ts";
import { recordTrustStatements, type StatementSource } from "./trust-store.ts";

const b64 = (u: Uint8Array): string => Buffer.from(u).toString("base64");
const seed = (start: number): Uint8Array => Uint8Array.from({ length: 32 }, (_, i) => start + i);
const key = (s: Uint8Array): string => b64(nacl.sign.keyPair.fromSeed(s).publicKey);
const NIMBUS_SEED = seed(1);
const REGISTRY_SEED = seed(40);
const PUB_SEED = seed(80);
const NIMBUS_KEY = key(NIMBUS_SEED);
const REGISTRY_KEY = key(REGISTRY_SEED);
const PUB_KEY = key(PUB_SEED);
const PUB_FP = publisherKeyFingerprint(PUB_KEY);
const REGISTRY_FP = publisherKeyFingerprint(REGISTRY_KEY);

const FEED: StatementSource = { kind: "feed", nimbusRootKey: NIMBUS_KEY };
const REGISTRY: StatementSource = {
  kind: "registry",
  name: "community",
  rootKey: REGISTRY_KEY,
  rootFingerprint: REGISTRY_FP,
  listedPublisherKeys: new Map([["acme", new Set([PUB_KEY])]]),
};

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 76);
});
afterEach(() => db.close());

const subject = (over: Partial<BlockSubject> = {}): BlockSubject => ({
  extensionId: "acme/deploy",
  version: "1.1.0",
  publisherId: "acme",
  keyFingerprint: PUB_FP,
  source: { registry: "community", rootFingerprint: REGISTRY_FP },
  ...over,
});

const revoke = (
  signer: string,
  s: Uint8Array,
  over: { reason?: string; issuedAt?: string; publisherId?: string } = {},
): Promise<TrustStatement> =>
  signTrustStatement(
    {
      kind: "key.revoke",
      issuedAt: over.issuedAt ?? "2026-10-26T12:00:00Z",
      signerKey: signer,
      publisherId: over.publisherId ?? "acme",
      keyFingerprint: PUB_FP,
      reason: over.reason ?? "leaked",
    },
    s,
  );

const takedown = (
  signer: string,
  s: Uint8Array,
  over: { versions?: "*" | string[]; publisherId?: string; issuedAt?: string } = {},
): Promise<TrustStatement> =>
  signTrustStatement(
    {
      kind: "extension.takedown",
      issuedAt: over.issuedAt ?? "2026-10-26T13:00:00Z",
      signerKey: signer,
      extensionId: "acme/deploy",
      publisherId: over.publisherId ?? "acme",
      versions: over.versions ?? "*",
      reason: "malware",
    },
    s,
  );

function record(source: StatementSource, ...statements: TrustStatement[]): void {
  const out = recordTrustStatements(db, statements, source, 1);
  expect(out.inserted).toBe(statements.length);
}

describe("blocksFor", () => {
  test("a Nimbus revocation blocks the key everywhere, local installs included", async () => {
    record(FEED, await revoke(NIMBUS_KEY, NIMBUS_SEED));
    expect(blocksFor(db, subject())).toHaveLength(1);
    expect(blocksFor(db, subject({ source: null }))[0]).toMatchObject({
      kind: "key.revoke",
      issuer: "nimbus",
      registry: null,
      reason: "leaked",
    });
  });

  test("a publisher's own revocation blocks its key", async () => {
    record(REGISTRY, await revoke(PUB_KEY, PUB_SEED));
    expect(blocksFor(db, subject({ source: null }))[0]?.issuer).toBe("publisher");
  });

  test("a registry revocation reaches only its own source at its own root", async () => {
    record(REGISTRY, await revoke(REGISTRY_KEY, REGISTRY_SEED));
    expect(blocksFor(db, subject())[0]).toMatchObject({
      issuer: "registry",
      registry: "community",
    });
    expect(blocksFor(db, subject({ source: null }))).toEqual([]);
    expect(
      blocksFor(db, subject({ source: { registry: "other", rootFingerprint: REGISTRY_FP } })),
    ).toEqual([]);
    expect(
      blocksFor(
        db,
        subject({ source: { registry: "community", rootFingerprint: "f".repeat(32) } }),
      ),
    ).toEqual([]);
  });

  test("a revocation of another key, or for another publisher id, does not apply", async () => {
    record(FEED, await revoke(NIMBUS_KEY, NIMBUS_SEED, { publisherId: "other" }));
    expect(blocksFor(db, subject())).toEqual([]);
    record(FEED, await revoke(NIMBUS_KEY, NIMBUS_SEED));
    expect(blocksFor(db, subject({ keyFingerprint: "0".repeat(32) }))).toEqual([]);
  });

  test("a takedown matches every version or only the listed ones", async () => {
    record(FEED, await takedown(NIMBUS_KEY, NIMBUS_SEED, { versions: ["1.1.0"] }));
    expect(blocksFor(db, subject())).toHaveLength(1);
    expect(blocksFor(db, subject({ version: "1.0.9" }))).toEqual([]);
    record(FEED, await takedown(NIMBUS_KEY, NIMBUS_SEED));
    expect(blocksFor(db, subject({ version: "1.0.9" }))).toHaveLength(1);
  });

  test("a takedown naming another publisher id does not reach this extension", async () => {
    record(FEED, await takedown(NIMBUS_KEY, NIMBUS_SEED, { publisherId: "impostor" }));
    expect(blocksFor(db, subject())).toEqual([]);
    expect(blocksFor(db, subject({ publisherId: "impostor", keyFingerprint: null }))).toHaveLength(
      1,
    );
  });

  test("unsigned code is never blocked", async () => {
    record(FEED, await takedown(NIMBUS_KEY, NIMBUS_SEED));
    expect(blocksFor(db, subject({ publisherId: null, keyFingerprint: null }))).toEqual([]);
  });

  test("newest first, and the reason is flattened and capped", async () => {
    record(
      FEED,
      await revoke(NIMBUS_KEY, NIMBUS_SEED, { reason: `a\u0000b\nc${"x".repeat(450)}` }),
      await takedown(NIMBUS_KEY, NIMBUS_SEED),
    );
    const blocks = blocksFor(db, subject());
    expect(blocks.map((b) => b.kind)).toEqual(["extension.takedown", "key.revoke"]);
    const reason = blocks[1]?.reason ?? "";
    expect(reason.startsWith("a b c")).toBe(true);
    expect(reason.length).toBe(MAX_REASON_CHARS);
    expect([...reason].some((c) => c.charCodeAt(0) < 0x20)).toBe(false);
  });

  test("a stored row that no longer parses still blocks, every version", async () => {
    record(FEED, await takedown(NIMBUS_KEY, NIMBUS_SEED, { versions: ["9.9.9"] }));
    db.run("UPDATE trust_statement SET statement_json = '{not json'");
    expect(blocksFor(db, subject({ version: "1.0.0" }))[0]).toMatchObject({
      kind: "extension.takedown",
      reason: UNREADABLE_REASON,
    });
  });

  test("below V76 nothing is read", () => {
    const old = new Database(":memory:");
    expect(blocksFor(old, subject())).toEqual([]);
    old.close();
  });
});

describe("assertNotBlocked", () => {
  test("passes with no block; a revocation wins over a takedown", async () => {
    assertNotBlocked(db, subject());
    record(FEED, await takedown(NIMBUS_KEY, NIMBUS_SEED));
    expect(() => assertNotBlocked(db, subject())).toThrow("ERR_EXTENSION_TAKEN_DOWN");
    record(FEED, await revoke(NIMBUS_KEY, NIMBUS_SEED));
    let caught: unknown;
    try {
      assertNotBlocked(db, subject());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TrustBlockError);
    expect((caught as TrustBlockError).code).toBe("ERR_EXTENSION_KEY_REVOKED");
    expect((caught as TrustBlockError).blocks).toHaveLength(2);
  });
});

describe("acknowledgement", () => {
  test("unacknowledged names what the grant did not acknowledge; garbage acknowledges nothing", async () => {
    record(FEED, await revoke(NIMBUS_KEY, NIMBUS_SEED), await takedown(NIMBUS_KEY, NIMBUS_SEED));
    const blocks = blocksFor(db, subject());
    const first = blocks[0];
    if (first === undefined) throw new Error("expected blocks");
    expect(unacknowledged(blocks, acknowledgementJson(blocks))).toEqual([]);
    expect(unacknowledged(blocks, JSON.stringify([first.statementId]))).toHaveLength(1);
    expect(unacknowledged(blocks, "not json")).toHaveLength(2);
    expect(unacknowledged(blocks, '{"a":1}')).toHaveLength(2);
    expect(unacknowledged(blocks, undefined)).toHaveLength(2);
    expect(JSON.parse(acknowledgementJson(blocks))).toEqual(
      blocks.map((b) => b.statementId).sort(),
    );
  });
});

describe("blockSubjectForInstalled", () => {
  const manifest = { publisher: { id: "acme", key: PUB_KEY } };
  test("uses the recorded fingerprint, falls back to the declared key, reads the source", () => {
    const row = {
      id: "acme/deploy",
      version: "1.1.0",
      source_registry: "community",
      source_root_fingerprint: REGISTRY_FP,
      publisher_key_fingerprint: "a".repeat(32),
    };
    expect(blockSubjectForInstalled(row, manifest)).toEqual({
      extensionId: "acme/deploy",
      version: "1.1.0",
      publisherId: "acme",
      keyFingerprint: "a".repeat(32),
      source: { registry: "community", rootFingerprint: REGISTRY_FP },
    });
    const local = blockSubjectForInstalled(
      {
        ...row,
        source_registry: null,
        source_root_fingerprint: null,
        publisher_key_fingerprint: null,
      },
      manifest,
    );
    expect(local.keyFingerprint).toBe(PUB_FP);
    expect(local.source).toBeNull();
    expect(blockSubjectForInstalled(row, {}).publisherId).toBeNull();
  });
});

describe("blocksForInstalled", () => {
  test("covers both the recorded and the declared key, once each", async () => {
    record(FEED, await revoke(NIMBUS_KEY, NIMBUS_SEED));
    const row = {
      id: "acme/deploy",
      version: "1.1.0",
      source_registry: null,
      source_root_fingerprint: null,
      // A recorded fingerprint that differs from the declared key's must not hide its revocation.
      publisher_key_fingerprint: "a".repeat(32),
    };
    const manifest = { publisher: { id: "acme", key: PUB_KEY } };
    expect(blocksForInstalled(db, row, manifest).map((b) => b.kind)).toEqual(["key.revoke"]);
    expect(
      blocksForInstalled(db, { ...row, publisher_key_fingerprint: PUB_FP }, manifest),
    ).toHaveLength(1);
    expect(blocksForInstalled(db, row, {})).toEqual([]);
  });
});
