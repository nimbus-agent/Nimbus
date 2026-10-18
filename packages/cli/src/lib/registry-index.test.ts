import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emptyIndex,
  publicKeyFromSeed,
  type RegistryIndex,
  readIndexFile,
  signIndex,
  writeIndexAtomic,
} from "./registry-index.ts";

const SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const ROOT_KEY = "ebVWLo/mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ=";
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

const PUBKEY_B = Buffer.from(
  publicKeyFromSeed(Uint8Array.from({ length: 32 }, (_, i) => 100 + i)),
).toString("base64");

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

describe("registry index signer", () => {
  test("golden vector matches the gateway's", async () => {
    expect(Buffer.from(publicKeyFromSeed(SEED)).toString("base64")).toBe(ROOT_KEY);
    const signed = await signIndex(unsigned, SEED);
    expect(signed.signature).toBe(PINNED_SIGNATURE);
  });

  test("emptyIndex starts at sequence 1 with no extensions", () => {
    expect(emptyIndex(ROOT_KEY)).toMatchObject({
      format: 1,
      rootKey: ROOT_KEY,
      sequence: 1,
      extensions: {},
    });
  });

  test("writeIndexAtomic leaves no tmp file and replaces atomically", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-reg-idx-"));
    try {
      const first = await signIndex(unsigned, SEED);
      writeIndexAtomic(dir, first);
      const second: RegistryIndex = { ...first, sequence: 43 };
      writeIndexAtomic(dir, second);
      expect(readdirSync(dir)).toEqual(["index.json"]);
      expect(readIndexFile(join(dir, "index.json")).sequence).toBe(43);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("readIndexFile rejects a non-object document", () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-reg-idx-"));
    try {
      const p = join(dir, "index.json");
      writeFileSync(p, "[]");
      expect(() => readIndexFile(p)).toThrow();
      expect(existsSync(p)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
