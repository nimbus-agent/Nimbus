import { describe, expect, test } from "bun:test";
import { decodeBase64 } from "@nimbus-dev/sdk";
import nacl from "tweetnacl";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { digestEgressWindow, signWindowDigest } from "./egress-sign.ts";

/** A complete in-memory NimbusVault implementation for testing. */
function fakeVault(): NimbusVault {
  const m = new Map<string, string>();
  return {
    get: async (k) => m.get(k) ?? null,
    set: async (k, v) => {
      m.set(k, v);
    },
    delete: async (k) => {
      m.delete(k);
    },
    listKeys: async (prefix) =>
      [...m.keys()].filter((k) => prefix === undefined || k.startsWith(prefix)),
  };
}

describe("digestEgressWindow", () => {
  test("is a stable 64-char hex over the row hashes", () => {
    const d1 = digestEgressWindow([{ rowHash: "a".repeat(64) }, { rowHash: "b".repeat(64) }]);
    const d2 = digestEgressWindow([{ rowHash: "a".repeat(64) }, { rowHash: "b".repeat(64) }]);
    expect(d1).toBe(d2);
    expect(d1).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("signWindowDigest", () => {
  test("produces a signature that verifies against the returned pubkey", async () => {
    const vault = fakeVault();
    const digest = digestEgressWindow([{ rowHash: "c".repeat(64) }]);
    const { sigB64, pubkeyB64 } = await signWindowDigest(vault, digest);
    const ok = nacl.sign.detached.verify(
      new TextEncoder().encode(digest),
      decodeBase64(sigB64),
      decodeBase64(pubkeyB64),
    );
    expect(ok).toBe(true);
  });

  test("never returns the private key material", async () => {
    const vault = fakeVault();
    const out = await signWindowDigest(vault, digestEgressWindow([{ rowHash: "d".repeat(64) }]));
    expect(Object.keys(out).sort()).toEqual(["pubkeyB64", "sigB64"]);
    expect(JSON.stringify(out)).not.toContain("privkey");
  });
});
