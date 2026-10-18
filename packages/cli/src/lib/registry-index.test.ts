import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  emptyIndex,
  publicKeyFromSeed,
  type RegistryIndex,
  signIndex,
} from "@nimbus-dev/registry-format";

import { readIndexFile, writeIndexAtomic } from "./registry-index.ts";

// The golden vector pinning the signed bytes lives once, in `@nimbus-dev/registry-format`.
const SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const ROOT_KEY = Buffer.from(publicKeyFromSeed(SEED)).toString("base64");

describe("registry index files", () => {
  test("writeIndexAtomic leaves no tmp file and replaces atomically", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-reg-idx-"));
    try {
      const first = await signIndex({ ...emptyIndex(ROOT_KEY), sequence: 42 }, SEED);
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
