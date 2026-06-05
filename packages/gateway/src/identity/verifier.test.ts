// verifier.test.ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { IdentityStore } from "./identity-store.ts";
import { JwksCache } from "./jwks-cache.ts";
import { IdTokenVerifier, isOperatorValid } from "./verifier.ts";

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
function b64urlJson(obj: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(obj)));
}

async function makeSignedJwt(
  claims: Record<string, unknown>,
  kid: string,
): Promise<{ jwt: string; jwk: JsonWebKey }> {
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
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return { jwt: `${signingInput}.${b64url(sig)}`, jwk: { ...jwk, kid, alg: "RS256" } };
}

function freshDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 34);
  return db;
}

describe("IdTokenVerifier", () => {
  test("accepts a correctly-signed token with matching iss/aud/exp", async () => {
    const db = freshDb();
    const now = 1_000_000;
    const { jwt, jwk } = await makeSignedJwt(
      {
        iss: "https://acme",
        aud: "client-1",
        sub: "sub-1",
        email: "a@acme.com",
        exp: now / 1000 + 3600,
      },
      "k1",
    );
    const cache = new JwksCache(db, async () => new Response(JSON.stringify({ keys: [jwk] })), {
      maxAgeSeconds: 3600,
    });
    const v = new IdTokenVerifier(cache, {
      issuer: "https://acme",
      clientId: "client-1",
      jwksUri: "https://acme/jwks",
    });
    const claims = await v.validateIdToken(jwt, now);
    expect(claims.sub).toBe("sub-1");
    expect(claims.email).toBe("a@acme.com");
  });

  test("rejects a token whose aud does not match the client_id", async () => {
    const db = freshDb();
    const now = 1_000_000;
    const { jwt, jwk } = await makeSignedJwt(
      { iss: "https://acme", aud: "WRONG", sub: "s", exp: now / 1000 + 60 },
      "k1",
    );
    const cache = new JwksCache(db, async () => new Response(JSON.stringify({ keys: [jwk] })), {
      maxAgeSeconds: 3600,
    });
    const v = new IdTokenVerifier(cache, {
      issuer: "https://acme",
      clientId: "client-1",
      jwksUri: "https://acme/jwks",
    });
    await expect(v.validateIdToken(jwt, now)).rejects.toThrow();
  });

  test("rejects an expired token", async () => {
    const db = freshDb();
    const now = 1_000_000;
    const { jwt, jwk } = await makeSignedJwt(
      { iss: "https://acme", aud: "client-1", sub: "s", exp: now / 1000 - 10 },
      "k1",
    );
    const cache = new JwksCache(db, async () => new Response(JSON.stringify({ keys: [jwk] })), {
      maxAgeSeconds: 3600,
    });
    const v = new IdTokenVerifier(cache, {
      issuer: "https://acme",
      clientId: "client-1",
      jwksUri: "https://acme/jwks",
    });
    await expect(v.validateIdToken(jwt, now)).rejects.toThrow();
  });
});

describe("isOperatorValid", () => {
  test("true within grace, false past grace, false when deprovisioned", () => {
    const db = freshDb();
    const store = new IdentityStore(db);
    store.upsertSession({
      issuer: "https://acme",
      externalId: "s",
      email: null,
      validatedAt: 0,
      expiresAt: 1000,
      status: "active",
    });
    expect(isOperatorValid(store, "https://acme", 1500, 1)).toBe(true); // exp=1000ms, grace=1s → boundary 2000ms
    expect(isOperatorValid(store, "https://acme", 2500, 1)).toBe(false); // past grace
    store.setSessionStatus("https://acme", "deprovisioned");
    expect(isOperatorValid(store, "https://acme", 1500, 1)).toBe(false);
  });
  test("false when there is no session at all", () => {
    const db = freshDb();
    expect(isOperatorValid(new IdentityStore(db), "https://acme", 0, 1000)).toBe(false);
  });
});
