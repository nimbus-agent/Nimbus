import { describe, expect, test } from "bun:test";
import nacl from "tweetnacl";

import { publisherKeyFingerprint } from "./fingerprint.ts";
import type { RegistryExtensionEntry, RegistryIndex } from "./index-format.ts";
import {
  alreadyCarried,
  assertRequestSignable,
  parseRegistryRequest,
  type RegistryRequest,
  signRegistryRequest,
} from "./registry-requests.ts";
import { signTrustStatement, verifyTrustStatement } from "./trust-statement.ts";

const b64 = (u: Uint8Array): string => Buffer.from(u).toString("base64");
const ROOT_SEED = new Uint8Array(32).fill(81);
const ROOT_KEY = b64(nacl.sign.keyPair.fromSeed(ROOT_SEED).publicKey);
const OTHER_SEED = new Uint8Array(32).fill(82);
const OTHER_KEY = b64(nacl.sign.keyPair.fromSeed(OTHER_SEED).publicKey);
const PUB_KEY = b64(nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(83)).publicKey);
const ISSUED = "2026-10-27T12:00:00Z";

function entry(publisherId: string): RegistryExtensionEntry {
  const hex = "a".repeat(64);
  return {
    publisher: { id: publisherId, key: PUB_KEY },
    versions: {
      "1.0.0": {
        channel: "stable",
        name: "Tool",
        manifest: "m",
        manifestSha256: hex,
        package: "p",
        packageSha256: hex,
        packageSizeBytes: 1,
        entryHash: hex,
        publishedAt: ISSUED,
      },
    },
  };
}

type Idx = Pick<RegistryIndex, "extensions" | "rootKey" | "statements">;
const INDEX: Idx = { rootKey: ROOT_KEY, extensions: { "acme/tool": entry("acme") } };

const revoke: RegistryRequest = {
  kind: "key.revoke",
  publisherId: "acme",
  keyFingerprint: publisherKeyFingerprint(PUB_KEY),
  reason: "leaked",
};

describe("parseRegistryRequest", () => {
  test("accepts each kind, exactly", () => {
    expect(parseRegistryRequest(revoke)).toEqual(revoke);
    const takedown = {
      kind: "extension.takedown",
      extensionId: "acme/tool",
      versions: "*",
      reason: "malware",
    };
    expect(parseRegistryRequest(takedown)).toEqual(takedown);
    expect(parseRegistryRequest({ ...takedown, publisherId: "acme", versions: ["1.0.0"] })).toEqual(
      {
        ...takedown,
        publisherId: "acme",
        versions: ["1.0.0"],
      },
    );
  });

  test("refuses unknown keys, a bad fingerprint, a long reason, an unknown kind, a non-object", () => {
    expect(() => parseRegistryRequest({ ...revoke, extra: 1 })).toThrow(
      "ERR_TRUST_STATEMENT_INVALID",
    );
    expect(() => parseRegistryRequest({ ...revoke, keyFingerprint: "nothex" })).toThrow();
    expect(() => parseRegistryRequest({ ...revoke, reason: "x".repeat(501) })).toThrow();
    expect(() => parseRegistryRequest({ ...revoke, kind: "key.rotate" })).toThrow();
    expect(() => parseRegistryRequest([])).toThrow();
    expect(() =>
      parseRegistryRequest({
        kind: "extension.takedown",
        extensionId: "../x",
        versions: "*",
        reason: "r",
      }),
    ).toThrow();
  });
});

describe("signRegistryRequest", () => {
  test("a revocation is signed by the registry root and verifies as `registry`", async () => {
    const s = await signRegistryRequest(revoke, INDEX, ROOT_SEED, ISSUED);
    expect(s).toMatchObject({ kind: "key.revoke", signerKey: ROOT_KEY, issuedAt: ISSUED });
    expect(verifyTrustStatement(s, { registryRootKey: ROOT_KEY })).toBe("registry");
    expect(Object.keys(s).sort()).toEqual(
      [
        "issuedAt",
        "keyFingerprint",
        "kind",
        "publisherId",
        "reason",
        "signature",
        "signerKey",
      ].sort(),
    );
  });

  test("a takedown takes the index's publisher id, and refuses a different explicit one", async () => {
    const req: RegistryRequest = {
      kind: "extension.takedown",
      extensionId: "acme/tool",
      versions: "*",
      reason: "r",
    };
    const s = await signRegistryRequest(req, INDEX, ROOT_SEED, ISSUED);
    expect(s).toMatchObject({ publisherId: "acme", extensionId: "acme/tool" });
    expect(verifyTrustStatement(s, { registryRootKey: ROOT_KEY })).toBe("registry");
    await expect(
      signRegistryRequest({ ...req, publisherId: "evil" }, INDEX, ROOT_SEED, ISSUED),
    ).rejects.toThrow("acme");
  });

  test("an id the index no longer carries needs an explicit publisher id", async () => {
    const req: RegistryRequest = {
      kind: "extension.takedown",
      extensionId: "gone/tool",
      versions: "*",
      reason: "r",
    };
    await expect(signRegistryRequest(req, INDEX, ROOT_SEED, ISSUED)).rejects.toThrow("--publisher");
    const s = await signRegistryRequest({ ...req, publisherId: "gone" }, INDEX, ROOT_SEED, ISSUED);
    expect(s).toMatchObject({ publisherId: "gone", extensionId: "gone/tool" });
  });

  test("a seed that is not the index's root is refused (it would sign a statement clients ignore)", async () => {
    await expect(signRegistryRequest(revoke, INDEX, OTHER_SEED, ISSUED)).rejects.toThrow("root");
  });
});

describe("alreadyCarried (once per block, by meaning)", () => {
  test("a revocation of the same key is carried; another key is not", async () => {
    const s = await signRegistryRequest(revoke, INDEX, ROOT_SEED, ISSUED);
    const idx = { ...INDEX, statements: [s] };
    expect(alreadyCarried(idx, { ...revoke, reason: "a different reason" })).toBe(true);
    expect(alreadyCarried(idx, { ...revoke, keyFingerprint: "b".repeat(32) })).toBe(false);
  });

  test("a takedown covering the versions is carried; a narrower existing one does not cover a wider request", async () => {
    const narrow = await signRegistryRequest(
      { kind: "extension.takedown", extensionId: "acme/tool", versions: ["1.0.0"], reason: "r" },
      INDEX,
      ROOT_SEED,
      ISSUED,
    );
    const idx = { ...INDEX, statements: [narrow] };
    const wide: RegistryRequest = {
      kind: "extension.takedown",
      extensionId: "acme/tool",
      versions: "*",
      reason: "r",
    };
    expect(alreadyCarried(idx, { ...wide, versions: ["1.0.0"] })).toBe(true);
    expect(alreadyCarried(idx, wide)).toBe(false);
    const all = await signRegistryRequest(wide, INDEX, ROOT_SEED, ISSUED);
    expect(alreadyCarried({ ...INDEX, statements: [all] }, { ...wide, versions: ["2.0.0"] })).toBe(
      true,
    );
  });

  test("a statement not signed by the index's own root never counts — publisher-signed or forged", async () => {
    const forged = await signTrustStatement(
      {
        kind: "key.revoke",
        issuedAt: ISSUED,
        signerKey: OTHER_KEY,
        publisherId: "acme",
        keyFingerprint: revoke.keyFingerprint,
        reason: "spoof",
      },
      OTHER_SEED,
    );
    const real = await signRegistryRequest(revoke, INDEX, ROOT_SEED, ISSUED);
    const tampered = { ...real, signerKey: ROOT_KEY, reason: "edited after signing" };
    expect(alreadyCarried({ ...INDEX, statements: [forged, tampered] }, revoke)).toBe(false);
  });
});

describe("assertRequestSignable (one rule for check and sign)", () => {
  test("a revocation of the registry root's own key is refused (it would never read as carried)", () => {
    const own: RegistryRequest = {
      kind: "key.revoke",
      publisherId: "acme",
      keyFingerprint: publisherKeyFingerprint(ROOT_KEY),
      reason: "x",
    };
    expect(() => assertRequestSignable(own, INDEX)).toThrow("root key");
    expect(() => assertRequestSignable(revoke, INDEX)).not.toThrow();
  });

  test("a takedown the sign job would refuse is refused here too", () => {
    const req: RegistryRequest = {
      kind: "extension.takedown",
      extensionId: "gone/tool",
      versions: "*",
      reason: "r",
    };
    expect(() => assertRequestSignable(req, INDEX)).toThrow("--publisher");
    expect(() =>
      assertRequestSignable(
        {
          kind: "extension.takedown",
          extensionId: "acme/tool",
          publisherId: "evil",
          versions: "*",
          reason: "r",
        },
        INDEX,
      ),
    ).toThrow("acme");
  });
});
