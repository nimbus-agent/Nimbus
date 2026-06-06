// identity-test-helpers.ts — shared fixtures for the identity unit tests.
// Not a *.test.ts file, so Bun never runs it directly; it is imported by the
// identity test suite to keep the RS256 signing + fake-Vault setup in one place.
import type { NimbusVault } from "../vault/nimbus-vault.ts";

function b64url(bytes: Uint8Array): string {
  // base64url: swap +/ for -_ and drop the trailing `=` padding run.
  return Buffer.from(bytes)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function b64urlJson(obj: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(obj)));
}

/** Mints a real RS256-signed JWT plus the matching public JWK (with `kid`/`alg`). */
export async function makeSignedJwt(claims: Record<string, unknown>, kid: string) {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const header = { alg: "RS256", kid, typ: "JWT" };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(claims)}`;
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: "RSASSA-PKCS1-v1_5" },
      pair.privateKey,
      new TextEncoder().encode(signingInput),
    ),
  );
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { jwt: `${signingInput}.${b64url(sig)}`, jwk: { ...jwk, kid, alg: "RS256" } };
}

/** A Map-backed fake NimbusVault — no backend, no key-format validation; round-trips raw bytes. */
export function fakeVault(): { vault: NimbusVault; store: Map<string, string> } {
  const store = new Map<string, string>();
  const vault: NimbusVault = {
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: string) => {
      store.set(k, v);
    },
    delete: async (k: string) => {
      store.delete(k);
    },
    listKeys: async (prefix?: string) =>
      [...store.keys()].filter((k) => prefix === undefined || k.startsWith(prefix)),
  };
  return { vault, store };
}
