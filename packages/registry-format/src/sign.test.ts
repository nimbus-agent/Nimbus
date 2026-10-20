import { describe, expect, test } from "bun:test";

import type { RegistryIndex } from "./index-format.ts";
import { emptyIndex, publicKeyFromSeed, signIndex, verifyIndexSignature } from "./sign.ts";

// The golden vector (fixed seed → pinned signature) lives once, in `index-format.test.ts`.
const SEED = Uint8Array.from({ length: 32 }, (_, i) => 50 + i);
const ROOT_KEY = Buffer.from(publicKeyFromSeed(SEED)).toString("base64");

describe("registry index signer", () => {
  test("emptyIndex starts at sequence 1 with no extensions", () => {
    expect(emptyIndex(ROOT_KEY)).toMatchObject({
      format: 1,
      rootKey: ROOT_KEY,
      sequence: 1,
      extensions: {},
    });
  });

  test("a signed index verifies; a changed field or a different root key does not", async () => {
    const signed = await signIndex(emptyIndex(ROOT_KEY), SEED);
    expect(verifyIndexSignature(signed)).toBe(true);
    expect(verifyIndexSignature({ ...signed, sequence: 2 })).toBe(false);
    const other = Buffer.from(publicKeyFromSeed(new Uint8Array(32).fill(9))).toString("base64");
    expect(verifyIndexSignature({ ...signed, rootKey: other })).toBe(false);
  });

  test("re-signing an already-signed index ignores its old signature", async () => {
    const first = await signIndex(emptyIndex(ROOT_KEY), SEED);
    const again = await signIndex(first as Omit<RegistryIndex, "signature">, SEED);
    expect(again.signature).toBe(first.signature);
  });

  test("an undecodable root key verifies false rather than throwing", () => {
    const bad = { ...emptyIndex("not-a-key"), signature: "AAAA" } as RegistryIndex;
    expect(verifyIndexSignature(bad)).toBe(false);
  });

  test("a seed that is not 32 bytes is refused", () => {
    expect(() => publicKeyFromSeed(new Uint8Array(31))).toThrow("Ed25519 seed must be 32 bytes");
  });
});
