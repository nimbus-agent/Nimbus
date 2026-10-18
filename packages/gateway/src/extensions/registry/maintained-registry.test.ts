import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseRegistryIndex, verifyRegistryIndexPinned } from "@nimbus-dev/registry-format";
import nacl from "tweetnacl";

import { encodeBase64 } from "../../util/base64.ts";

const SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const ROOT_KEY = encodeBase64(nacl.sign.keyPair.fromSeed(SEED).publicKey);

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
