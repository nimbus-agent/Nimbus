import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import nacl from "tweetnacl";
import { encodeBase64 } from "../../util/base64.ts";
import {
  MAX_INDEX_BYTES,
  parseRegistryIndex,
  type RegistryIndex,
  registryIndexSigningBytes,
  verifyRegistryIndexPinned,
  verifyRegistryIndexSelf,
} from "./index-format.ts";

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
  test("golden vector: fixed key signs the fixture index to the pinned signature", () => {
    expect(ROOT_KEY).toBe("ebVWLo/mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ=");
    expect(sign(unsigned).signature).toBe(PINNED_SIGNATURE);
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

describe("maintainer flow", () => {
  test("verifies an index produced by the maintainer flow", async () => {
    const root = join(import.meta.dir, "__fixtures__", "maintained-registry");
    const index = parseRegistryIndex(readFileSync(join(root, "index.json")));
    await verifyRegistryIndexPinned(index, ROOT_KEY);
    const entry = index.extensions["com.example.maintained"]?.versions["1.0.0"];
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    const sha = (rel: string): string =>
      createHash("sha256")
        .update(readFileSync(join(root, rel)))
        .digest("hex");
    expect(sha(entry.manifest)).toBe(entry.manifestSha256);
    expect(sha(entry.package)).toBe(entry.packageSha256);
  });
});
