import { describe, expect, test } from "bun:test";
import nacl from "tweetnacl";

import { publisherKeyFingerprint } from "./fingerprint.ts";
import {
  isKnownStatementKind,
  MAX_STATEMENT_REASON_CHARS,
  parseTrustStatement,
  signTrustStatement,
  type TrustStatement,
  trustStatementId,
  trustStatementSigningBytes,
  type UnsignedTrustStatement,
  verifyTrustStatement,
} from "./trust-statement.ts";

const encodeBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

const PUB_SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const ROOT_SEED = Uint8Array.from({ length: 32 }, (_, i) => 200 - i);
const OTHER_SEED = Uint8Array.from({ length: 32 }, (_, i) => 100 + i);
const PUB_KEY = encodeBase64(nacl.sign.keyPair.fromSeed(PUB_SEED).publicKey);
const ROOT_KEY = encodeBase64(nacl.sign.keyPair.fromSeed(ROOT_SEED).publicKey);
const OTHER_KEY = encodeBase64(nacl.sign.keyPair.fromSeed(OTHER_SEED).publicKey);

// Pinned once from this file's fixtures (sign with tweetnacl, print, paste). A change to the
// canonical bytes or the id rule changes them and must be deliberate.
const PINNED_REVOKE_SIGNATURE =
  "mUx9nwNbtgcjBh6TtTrvphj/IqxqplMC199P02PS8da7N8BDwsHHsHLXCbC01eBu8LfHzgDfQedV4UgfdftRDQ==";
const PINNED_REVOKE_ID = "575a084be69f3accfee136369b52cad5ba56b31a0d7174441eb490d1cc71b097";

const ISSUED = "2026-10-26T12:00:00Z";

const revokeUnsigned: UnsignedTrustStatement = {
  kind: "key.revoke",
  issuedAt: ISSUED,
  signerKey: PUB_KEY,
  publisherId: "acme",
  keyFingerprint: publisherKeyFingerprint(PUB_KEY),
  reason: "clé compromise — rotated",
};

const takedownUnsigned: UnsignedTrustStatement = {
  kind: "extension.takedown",
  issuedAt: ISSUED,
  signerKey: ROOT_KEY,
  extensionId: "acme/deploy",
  publisherId: "acme",
  versions: ["1.0.0", "1.1.0"],
  reason: "exfiltrates tokens",
};

const rotateUnsigned: UnsignedTrustStatement = {
  kind: "key.rotate",
  issuedAt: ISSUED,
  signerKey: PUB_KEY,
  publisherId: "acme",
  fromKey: PUB_KEY,
  toKey: OTHER_KEY,
};

const verifiedUnsigned: UnsignedTrustStatement = {
  kind: "publisher.verified",
  issuedAt: ISSUED,
  signerKey: ROOT_KEY,
  publisherId: "acme",
  keys: [PUB_KEY],
  github: "acme-corp",
  verifiedAt: ISSUED,
};

function naclSign(u: UnsignedTrustStatement, seed: Uint8Array): TrustStatement {
  const kp = nacl.sign.keyPair.fromSeed(seed);
  const sig = nacl.sign.detached(trustStatementSigningBytes(u), kp.secretKey);
  return { ...u, signature: encodeBase64(sig) } as TrustStatement;
}

const roundTrip = (s: unknown): TrustStatement =>
  parseTrustStatement(JSON.parse(JSON.stringify(s)) as unknown);

describe("trust statements", () => {
  test("golden vector: a non-ASCII revoke signs to the pinned signature and id", async () => {
    const viaNacl = naclSign(revokeUnsigned, PUB_SEED);
    expect(viaNacl.signature).toBe(PINNED_REVOKE_SIGNATURE);
    const viaCrypto = await signTrustStatement(revokeUnsigned, PUB_SEED);
    expect(viaCrypto.signature).toBe(PINNED_REVOKE_SIGNATURE);
    expect(trustStatementId(viaCrypto)).toBe(PINNED_REVOKE_ID);
    expect(trustStatementId(roundTrip(viaCrypto))).toBe(PINNED_REVOKE_ID);
  });

  test("round-trips each kind with a stable id", async () => {
    const cases: Array<[UnsignedTrustStatement, Uint8Array]> = [
      [revokeUnsigned, PUB_SEED],
      [takedownUnsigned, ROOT_SEED],
      [rotateUnsigned, PUB_SEED],
      [verifiedUnsigned, ROOT_SEED],
    ];
    for (const [u, seed] of cases) {
      const s = await signTrustStatement(u, seed);
      const back = roundTrip(s);
      expect(back).toEqual(s);
      expect(trustStatementId(back)).toBe(trustStatementId(s));
    }
  });

  test("an extra key is carried through and covered by the signature", async () => {
    const s = await signTrustStatement({ ...takedownUnsigned, note: "see #12" }, ROOT_SEED);
    const back = roundTrip(s) as TrustStatement & { note?: string };
    expect(back.note).toBe("see #12");
    expect(verifyTrustStatement(back, { rootKey: ROOT_KEY })).toBe("root");
    const tampered = { ...back, note: "changed" };
    expect(verifyTrustStatement(tampered, { rootKey: ROOT_KEY })).toBeNull();
  });

  const bad: Array<[string, Record<string, unknown>]> = [
    ["unknown kind", { ...revokeUnsigned, kind: "key.unrevoke" }],
    ["missing field", { ...revokeUnsigned, publisherId: undefined }],
    ["bad fingerprint", { ...revokeUnsigned, keyFingerprint: "XYZ" }],
    ["fromKey equals toKey", { ...rotateUnsigned, toKey: PUB_KEY }],
    ["empty keys", { ...verifiedUnsigned, keys: [] }],
    ["duplicate key", { ...verifiedUnsigned, keys: [PUB_KEY, PUB_KEY] }],
    ["too many keys", { ...verifiedUnsigned, keys: Array.from({ length: 11 }, () => PUB_KEY) }],
    ["empty versions", { ...takedownUnsigned, versions: [] }],
    ["non-semver version", { ...takedownUnsigned, versions: ["1.x"] }],
    [
      "too many versions",
      { ...takedownUnsigned, versions: Array.from({ length: 101 }, (_, i) => `1.0.${i}`) },
    ],
    ["reason too long", { ...revokeUnsigned, reason: "é".repeat(MAX_STATEMENT_REASON_CHARS + 1) }],
    ["empty reason", { ...revokeUnsigned, reason: "" }],
    ["bad github handle", { ...verifiedUnsigned, github: "-bad" }],
    ["bad issuedAt", { ...revokeUnsigned, issuedAt: "yesterday" }],
    ["unsafe extension id", { ...takedownUnsigned, extensionId: "../evil" }],
    ["bad publisher id", { ...revokeUnsigned, publisherId: "Acme Corp" }],
  ];
  for (const [name, raw] of bad) {
    test(`rejects: ${name}`, () => {
      const withSig = { ...raw, signature: "A".repeat(86) + "==" };
      expect(() => parseTrustStatement(JSON.parse(JSON.stringify(withSig)))).toThrow(
        "ERR_TRUST_STATEMENT_INVALID",
      );
    });
  }

  test("a reason of exactly the cap in code points is accepted", async () => {
    const s = await signTrustStatement(
      { ...revokeUnsigned, reason: "😀".repeat(MAX_STATEMENT_REASON_CHARS) },
      PUB_SEED,
    );
    expect(roundTrip(s).kind).toBe("key.revoke");
  });

  describe("authority", () => {
    test("a revoke signed by the revoked key is a publisher statement", async () => {
      const s = await signTrustStatement(revokeUnsigned, PUB_SEED);
      expect(verifyTrustStatement(s, {})).toBe("publisher");
    });

    test("a revoke signed by the root key is a root statement only when that root is given", async () => {
      const s = await signTrustStatement({ ...revokeUnsigned, signerKey: ROOT_KEY }, ROOT_SEED);
      expect(verifyTrustStatement(s, { rootKey: ROOT_KEY })).toBe("root");
      expect(verifyTrustStatement(s, {})).toBeNull();
      expect(verifyTrustStatement(s, { rootKey: OTHER_KEY })).toBeNull();
    });

    test("a revoke signed by an unrelated key has no authority", async () => {
      const s = await signTrustStatement({ ...revokeUnsigned, signerKey: OTHER_KEY }, OTHER_SEED);
      expect(verifyTrustStatement(s, { rootKey: ROOT_KEY })).toBeNull();
    });

    test("takedown and verified need the root", async () => {
      for (const u of [takedownUnsigned, verifiedUnsigned]) {
        const byRoot = await signTrustStatement(u, ROOT_SEED);
        expect(verifyTrustStatement(byRoot, { rootKey: ROOT_KEY })).toBe("root");
        const byPublisher = await signTrustStatement({ ...u, signerKey: PUB_KEY }, PUB_SEED);
        expect(verifyTrustStatement(byPublisher, { rootKey: ROOT_KEY })).toBeNull();
      }
    });

    test("a rotate is valid only when signed by its fromKey", async () => {
      const s = await signTrustStatement(rotateUnsigned, PUB_SEED);
      expect(verifyTrustStatement(s, { rootKey: ROOT_KEY })).toBe("publisher");
      const byTo = await signTrustStatement(
        { ...rotateUnsigned, signerKey: OTHER_KEY },
        OTHER_SEED,
      );
      expect(verifyTrustStatement(byTo, { rootKey: ROOT_KEY })).toBeNull();
      const byRoot = await signTrustStatement(
        { ...rotateUnsigned, signerKey: ROOT_KEY },
        ROOT_SEED,
      );
      expect(verifyTrustStatement(byRoot, { rootKey: ROOT_KEY })).toBeNull();
    });

    test("a signature that does not match signerKey has no authority", async () => {
      // Signed by OTHER while claiming PUB as signer.
      const s = naclSign(revokeUnsigned, OTHER_SEED);
      expect(verifyTrustStatement(s, {})).toBeNull();
    });

    test("a field changed after signing has no authority", async () => {
      const s = await signTrustStatement(revokeUnsigned, PUB_SEED);
      expect(verifyTrustStatement({ ...s, reason: "other" } as TrustStatement, {})).toBeNull();
    });
  });

  test("isKnownStatementKind", () => {
    for (const kind of ["key.revoke", "extension.takedown", "key.rotate", "publisher.verified"]) {
      expect(isKnownStatementKind({ kind })).toBe(true);
    }
    expect(isKnownStatementKind({ kind: "key.unrevoke" })).toBe(false);
    expect(isKnownStatementKind(null)).toBe(false);
    expect(isKnownStatementKind("x")).toBe(false);
  });
});
