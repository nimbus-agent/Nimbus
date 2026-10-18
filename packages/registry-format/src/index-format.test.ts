import { describe, expect, test } from "bun:test";
import nacl from "tweetnacl";

import {
  MAX_INDEX_BYTES,
  parseRegistryIndex,
  type RegistryIndex,
  registryIndexSigningBytes,
  verifyRegistryIndexPinned,
  verifyRegistryIndexSelf,
} from "./index-format.ts";
import { publicKeyFromSeed, signIndex } from "./sign.ts";

const encodeBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

const SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const KEYPAIR = nacl.sign.keyPair.fromSeed(SEED);
const ROOT_KEY = encodeBase64(KEYPAIR.publicKey);
const PINNED_SIGNATURE =
  "Ah7Z9mXTsZFk9wHntv4fQ1eqKJ81aoErmiTDsuyg/Saqk/bodOcEZ2qT7Nv6Z5zj8tirj9sSHc2Dn9sNsam4AQ==";

const h = (c: string): string => c.repeat(64);

function version(id: string, v: string, channel: "stable" | "beta", name: string) {
  return {
    channel,
    name,
    manifest: `extensions/${id}/${v}/manifest.json`,
    manifestSha256: h("a"),
    package: `extensions/${id}/${v}/package.tgz`,
    packageSha256: h("b"),
    packageSizeBytes: 12345,
    entryHash: h("c"),
    publishedAt: "2026-10-18T12:00:00Z",
  };
}

const PUBKEY_B = encodeBase64(
  nacl.sign.keyPair.fromSeed(Uint8Array.from({ length: 32 }, (_, i) => 100 + i)).publicKey,
);

const unsigned = {
  format: 1 as const,
  rootKey: ROOT_KEY,
  sequence: 42,
  generatedAt: "2026-10-18T12:00:00Z",
  extensions: {
    "acme/deploy": {
      publisher: { id: "acme", key: PUBKEY_B },
      versions: {
        "1.0.0": version("acme/deploy", "1.0.0", "stable", "Zoë Deploy"),
        "1.1.0-beta.1": version("acme/deploy", "1.1.0-beta.1", "beta", "Zoë Deploy"),
      },
    },
  },
};

function sign(idx: unknown): RegistryIndex {
  const base = idx as Omit<RegistryIndex, "signature">;
  const sig = nacl.sign.detached(registryIndexSigningBytes(base), KEYPAIR.secretKey);
  return { ...base, signature: encodeBase64(sig) };
}

const enc = (v: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(v));

type Mutable = {
  extensions: Record<string, { versions: Record<string, Record<string, unknown>> }>;
};

describe("registry index format", () => {
  test("golden vector: fixed key signs the fixture index to the pinned signature", async () => {
    expect(ROOT_KEY).toBe("ebVWLo/mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ=");
    expect(sign(unsigned).signature).toBe(PINNED_SIGNATURE);
    // The node:crypto signer the maintainer and publishing tools use produces the same bytes.
    expect(encodeBase64(publicKeyFromSeed(SEED))).toBe(ROOT_KEY);
    expect((await signIndex(unsigned, SEED)).signature).toBe(PINNED_SIGNATURE);
  });

  test("parse accepts a BOM and CRLF", () => {
    const text = `﻿${JSON.stringify(sign(unsigned), null, 2).replaceAll("\n", "\r\n")}`;
    const parsed = parseRegistryIndex(new TextEncoder().encode(text));
    expect(parsed.sequence).toBe(42);
  });

  test("rejects a manifest path that is not the canonical location", () => {
    const bad = structuredClone(unsigned) as unknown as Mutable;
    bad.extensions["acme/deploy"]!.versions["1.0.0"]!["manifest"] = "../../etc/passwd";
    expect(() => parseRegistryIndex(enc(sign(bad)))).toThrow("ERR_REGISTRY_INDEX_INVALID");
  });

  test("rejects an id that fails assertSafeExtensionId", () => {
    const bad = { ...unsigned, extensions: { "../evil": unsigned.extensions["acme/deploy"] } };
    expect(() => parseRegistryIndex(enc(sign(bad)))).toThrow("ERR_REGISTRY_INDEX_INVALID");
  });

  test("rejects a non-semver version key", () => {
    const e = unsigned.extensions["acme/deploy"];
    const bad = {
      ...unsigned,
      extensions: { "acme/deploy": { ...e, versions: { "not-a-version": e.versions["1.0.0"] } } },
    };
    expect(() => parseRegistryIndex(enc(sign(bad)))).toThrow("ERR_REGISTRY_INDEX_INVALID");
  });

  test("pinned verify reports ROOT_KEY_CHANGED before checking the signature", async () => {
    const idx = sign(unsigned);
    const broken = { ...idx, signature: encodeBase64(new Uint8Array(64)) };
    await expect(verifyRegistryIndexPinned(broken, PUBKEY_B)).rejects.toThrow(
      "ERR_REGISTRY_ROOT_KEY_CHANGED",
    );
    await expect(verifyRegistryIndexPinned(idx, ROOT_KEY)).resolves.toBeUndefined();
  });

  test("a flipped byte in any version entry fails SIGNATURE_INVALID", async () => {
    const idx = sign(unsigned);
    await expect(verifyRegistryIndexSelf(idx)).resolves.toBeUndefined();
    const tampered = structuredClone(idx) as unknown as Mutable;
    tampered.extensions["acme/deploy"]!.versions["1.0.0"]!["packageSha256"] = h("d");
    await expect(verifyRegistryIndexSelf(tampered as unknown as RegistryIndex)).rejects.toThrow(
      "ERR_REGISTRY_SIGNATURE_INVALID",
    );
  });

  test("rejects version keys that are not strict SemVer", () => {
    const e = unsigned.extensions["acme/deploy"];
    for (const v of ["1.0.0/../x", "v1.0.0", "1.0.0 || 2.0.0", "01.0.0", "", "1.0.0 "]) {
      const bad = {
        ...unsigned,
        extensions: { "acme/deploy": { ...e, versions: { [v]: e.versions["1.0.0"] } } },
      };
      expect(() => parseRegistryIndex(enc(sign(bad)))).toThrow("ERR_REGISTRY_INDEX_INVALID");
    }
  });

  test("accepts prerelease and build-metadata versions", () => {
    const e = unsigned.extensions["acme/deploy"];
    for (const v of ["1.1.0-beta.1", "1.0.0+build.5"]) {
      const entry = version("acme/deploy", v, "stable", "X");
      const ok = { ...unsigned, extensions: { "acme/deploy": { ...e, versions: { [v]: entry } } } };
      expect(parseRegistryIndex(enc(sign(ok)))).toBeDefined();
    }
  });

  test("unknown keys are tolerated and still covered by the signature; format 2 is refused", async () => {
    const e = unsigned.extensions["acme/deploy"];
    const extra = {
      ...unsigned,
      description: "later field",
      extensions: {
        "acme/deploy": {
          ...e,
          versions: { "1.0.0": { ...e.versions["1.0.0"], note: "later field" } },
        },
      },
    };
    const parsed = parseRegistryIndex(enc(sign(extra)));
    await expect(verifyRegistryIndexSelf(parsed)).resolves.toBeUndefined();
    const tampered = parseRegistryIndex(enc({ ...sign(extra), description: "changed" }));
    await expect(verifyRegistryIndexSelf(tampered)).rejects.toThrow(
      "ERR_REGISTRY_SIGNATURE_INVALID",
    );
    expect(() => parseRegistryIndex(enc(sign({ ...unsigned, format: 2 })))).toThrow(
      "ERR_REGISTRY_INDEX_INVALID",
    );
  });

  test("rejects index over MAX_INDEX_BYTES before JSON.parse", () => {
    const big = new Uint8Array(MAX_INDEX_BYTES + 1024 * 1024);
    expect(() => parseRegistryIndex(big)).toThrow("ERR_REGISTRY_TOO_LARGE");
  });
});

describe("registry index parser refusals", () => {
  type Json = Record<string, unknown>;
  const ID = "acme/deploy";
  const V = "1.0.0";

  /** A signed index whose ONE version entry has been edited by `edit` (fresh clone each call). */
  function withEntry(edit: (entry: Json) => void): Uint8Array {
    const idx = structuredClone(unsigned) as unknown as Mutable;
    const entry = idx.extensions[ID]!.versions[V]!;
    edit(entry);
    return enc(sign(idx));
  }

  /** A signed index whose extension entry for ID has been replaced by `edit`'s result. */
  function withExtension(edit: (ext: Json) => unknown): Uint8Array {
    const idx = structuredClone(unsigned) as unknown as { extensions: Record<string, unknown> };
    idx.extensions[ID] = edit(idx.extensions[ID] as Json);
    return enc(sign(idx));
  }

  /** The top-level index with `edit` applied to a signed copy (signature kept as signed). */
  function withTop(edit: (top: Json) => void): Uint8Array {
    const top = structuredClone(sign(unsigned)) as unknown as Json;
    edit(top);
    return enc(top);
  }

  const cases: ReadonlyArray<readonly [string, Uint8Array, string]> = [
    ["invalid UTF-8", new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]), "not valid UTF-8"],
    ["invalid JSON", new TextEncoder().encode("{not json"), "not valid JSON"],
    ["a top-level array", enc([1, 2]), "index must be an object"],
    ["a top-level null", enc(null), "index must be an object"],
    ["a missing signature key", withTop((t) => delete t["signature"]), "missing key: signature"],
    ["a zero sequence", withTop((t) => (t["sequence"] = 0)), "sequence must be a positive"],
    ["a string sequence", withTop((t) => (t["sequence"] = "42")), "sequence must be a positive"],
    ["a fractional sequence", withTop((t) => (t["sequence"] = 1.5)), "sequence must be a positive"],
    ["extensions as an array", withTop((t) => (t["extensions"] = [])), "index.extensions must be"],
    ["a malformed rootKey", withTop((t) => (t["rootKey"] = "short")), "index.rootKey is malformed"],
    ["an empty rootKey", withTop((t) => (t["rootKey"] = "")), "index.rootKey must be a non-empty"],
    [
      "a non-timestamp generatedAt",
      withTop((t) => (t["generatedAt"] = "yesterday")),
      "generatedAt is not a timestamp",
    ],
    ["a malformed signature", withTop((t) => (t["signature"] = "AAAA")), "signature is malformed"],
    ["an extension entry that is a string", withExtension(() => "x"), `extensions.${ID} must be`],
    [
      "an extension with no versions key",
      withExtension((e) => ({ publisher: e["publisher"] })),
      "missing key: versions",
    ],
    [
      "a publisher with no key",
      withExtension((e) => ({ ...e, publisher: { id: "acme" } })),
      "publisher is missing key: key",
    ],
    [
      "a publisher id with upper case",
      withExtension((e) => ({ ...e, publisher: { id: "ACME", key: PUBKEY_B } })),
      "publisher.id is malformed",
    ],
    [
      "a publisher id over 64 chars",
      withExtension((e) => ({ ...e, publisher: { id: "a".repeat(65), key: PUBKEY_B } })),
      "publisher.id is malformed",
    ],
    [
      "a malformed publisher key",
      withExtension((e) => ({ ...e, publisher: { id: "acme", key: "nope" } })),
      "publisher.key is malformed",
    ],
    ["an empty versions object", withExtension((e) => ({ ...e, versions: {} })), "has no versions"],
    [
      "a version entry that is an array",
      withExtension((e) => ({ ...e, versions: { [V]: [] } })),
      `versions.${V} must be an object`,
    ],
    [
      "a version entry missing entryHash",
      withEntry((v) => delete v["entryHash"]),
      "missing key: entryHash",
    ],
    ["an unknown channel", withEntry((v) => (v["channel"] = "nightly")), "channel is not known"],
    [
      "a non-canonical package path",
      withEntry((v) => (v["package"] = "elsewhere/package.tgz")),
      "package is not canonical",
    ],
    [
      "a zero package size",
      withEntry((v) => (v["packageSizeBytes"] = 0)),
      "packageSizeBytes must be a positive",
    ],
    [
      "a string package size",
      withEntry((v) => (v["packageSizeBytes"] = "12")),
      "packageSizeBytes must be a positive",
    ],
    [
      "an unsafe-integer package size",
      withEntry((v) => (v["packageSizeBytes"] = 2 ** 60)),
      "packageSizeBytes must be a positive",
    ],
    ["an empty name", withEntry((v) => (v["name"] = "")), "name must be a non-empty string"],
    [
      "an upper-case manifest hash",
      withEntry((v) => (v["manifestSha256"] = "A".repeat(64))),
      "manifestSha256 is malformed",
    ],
    [
      "a short package hash",
      withEntry((v) => (v["packageSha256"] = "b".repeat(63))),
      "packageSha256 is malformed",
    ],
    [
      "a non-hex entry hash",
      withEntry((v) => (v["entryHash"] = "z".repeat(64))),
      "entryHash is malformed",
    ],
    [
      "a non-timestamp publishedAt",
      withEntry((v) => (v["publishedAt"] = "not a date")),
      "publishedAt is not a timestamp",
    ],
  ];

  for (const [label, bytes, detail] of cases) {
    test(`refuses ${label}`, () => {
      let thrown: unknown;
      try {
        parseRegistryIndex(bytes);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(Error);
      const message = (thrown as Error).message;
      expect(message).toStartWith("ERR_REGISTRY_INDEX_INVALID: ");
      expect(message).toContain(detail);
    });
  }

  test("an index without a BOM parses to the same document as the BOM-prefixed one", () => {
    const plain = parseRegistryIndex(enc(sign(unsigned)));
    expect(plain.rootKey).toBe(ROOT_KEY);
    expect(Object.keys(plain.extensions["acme/deploy"]!.versions).sort()).toEqual([
      "1.0.0",
      "1.1.0-beta.1",
    ]);
  });

  test("a signature that is not decodable base64 fails SIGNATURE_INVALID rather than throwing raw", async () => {
    const idx = sign(unsigned);
    const garbled = { ...idx, signature: "!!!not-base64!!!" };
    await expect(verifyRegistryIndexSelf(garbled)).rejects.toThrow(
      "ERR_REGISTRY_SIGNATURE_INVALID",
    );
  });

  test("a signature by a different key fails SIGNATURE_INVALID", async () => {
    const other = nacl.sign.keyPair.fromSeed(Uint8Array.from({ length: 32 }, (_, i) => 200 - i));
    const idx = sign(unsigned);
    const forged = {
      ...idx,
      signature: encodeBase64(nacl.sign.detached(registryIndexSigningBytes(idx), other.secretKey)),
    };
    await expect(verifyRegistryIndexSelf(forged)).rejects.toThrow("ERR_REGISTRY_SIGNATURE_INVALID");
  });
});
