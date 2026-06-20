import { describe, expect, test } from "bun:test";
import { decodeBase64 } from "@nimbus-dev/sdk";
import nacl from "tweetnacl";
import { digestEgressWindow, signWindowDigest } from "./egress-sign.ts";

/** A minimal in-memory NimbusVault stand-in (only get/set are exercised). */
function fakeVault(): {
  get: (k: string) => Promise<string | null>;
  set: (k: string, v: string) => Promise<void>;
} {
  const m = new Map<string, string>();
  return {
    get: async (k) => m.get(k) ?? null,
    set: async (k, v) => {
      m.set(k, v);
    },
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
    // biome-ignore lint/suspicious/noExplicitAny: test stand-in for NimbusVault
    const vault = fakeVault() as any;
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
    // biome-ignore lint/suspicious/noExplicitAny: test stand-in for NimbusVault
    const vault = fakeVault() as any;
    const out = await signWindowDigest(vault, digestEgressWindow([{ rowHash: "d".repeat(64) }]));
    expect(Object.keys(out).sort()).toEqual(["pubkeyB64", "sigB64"]);
    expect(JSON.stringify(out)).not.toContain("privkey");
  });
});
