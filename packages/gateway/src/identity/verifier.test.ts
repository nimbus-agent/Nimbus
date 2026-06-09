// verifier.test.ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { IdentityStore } from "./identity-store.ts";
import { makeSignedJwt } from "./identity-test-helpers.ts";
import { JwksCache } from "./jwks-cache.ts";
import { IdTokenValidationError, IdTokenVerifier, isOperatorValid } from "./verifier.ts";

/** Inline base64url encoder for crafting hand-built JWT segments in tests. */
function b64urlEncode(s: string): string {
  return Buffer.from(new TextEncoder().encode(s))
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/** Build a raw 3-segment JWT string without signing — for testing parse/alg/kid errors. */
function rawJwt(header: unknown, payload: unknown, sig = "fakesig"): string {
  return `${b64urlEncode(JSON.stringify(header))}.${b64urlEncode(JSON.stringify(payload))}.${sig}`;
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

  // Branch 1: parseJwt — fewer than 3 segments
  test("rejects a JWT without exactly 3 dot-separated segments", async () => {
    const db = freshDb();
    const cache = new JwksCache(db, async () => new Response(JSON.stringify({ keys: [] })), {
      maxAgeSeconds: 3600,
    });
    const v = new IdTokenVerifier(cache, {
      issuer: "https://acme",
      clientId: "client-1",
      jwksUri: "https://acme/jwks",
    });
    await expect(v.validateIdToken("a.b", 1_000_000)).rejects.toThrow(/malformed JWT/);
    await expect(v.validateIdToken("a.b", 1_000_000)).rejects.toBeInstanceOf(
      IdTokenValidationError,
    );
  });

  // Branch 2: b64urlToJson — segment decodes to a non-object (JSON array)
  test("rejects a JWT whose header decodes to a JSON array", async () => {
    const db = freshDb();
    const cache = new JwksCache(db, async () => new Response(JSON.stringify({ keys: [] })), {
      maxAgeSeconds: 3600,
    });
    const v = new IdTokenVerifier(cache, {
      issuer: "https://acme",
      clientId: "client-1",
      jwksUri: "https://acme/jwks",
    });
    // Header segment encodes a JSON array — b64urlToJson must throw
    const jwt = rawJwt([1, 2, 3], { iss: "https://acme" });
    await expect(v.validateIdToken(jwt, 1_000_000)).rejects.toThrow(/JWT segment is not an object/);
  });

  // Branch 3: verifySignature — unsupported alg
  test("rejects a JWT with alg HS256 instead of RS256", async () => {
    const db = freshDb();
    const cache = new JwksCache(db, async () => new Response(JSON.stringify({ keys: [] })), {
      maxAgeSeconds: 3600,
    });
    const v = new IdTokenVerifier(cache, {
      issuer: "https://acme",
      clientId: "client-1",
      jwksUri: "https://acme/jwks",
    });
    const jwt = rawJwt({ alg: "HS256", kid: "k1" }, { iss: "https://acme" });
    await expect(v.validateIdToken(jwt, 1_000_000)).rejects.toThrow(/unsupported alg/);
  });

  // Branch 4: verifySignature — missing kid
  test("rejects a JWT with alg RS256 but no kid in header", async () => {
    const db = freshDb();
    const cache = new JwksCache(db, async () => new Response(JSON.stringify({ keys: [] })), {
      maxAgeSeconds: 3600,
    });
    const v = new IdTokenVerifier(cache, {
      issuer: "https://acme",
      clientId: "client-1",
      jwksUri: "https://acme/jwks",
    });
    const jwt = rawJwt({ alg: "RS256" }, { iss: "https://acme" });
    await expect(v.validateIdToken(jwt, 1_000_000)).rejects.toThrow(/missing kid/);
  });

  // Branch 5: verifySignature — no usable signing key (JWKS returns empty keys array)
  test("rejects when JWKS has no key matching the token kid", async () => {
    const db = freshDb();
    const now = 1_000_000;
    const { jwt } = await makeSignedJwt(
      { iss: "https://acme", aud: "client-1", sub: "s", exp: now / 1000 + 3600 },
      "k1",
    );
    // Serve empty JWKS — no key for kid "k1"
    const cache = new JwksCache(db, async () => new Response(JSON.stringify({ keys: [] })), {
      maxAgeSeconds: 3600,
    });
    const v = new IdTokenVerifier(cache, {
      issuer: "https://acme",
      clientId: "client-1",
      jwksUri: "https://acme/jwks",
    });
    await expect(v.validateIdToken(jwt, now)).rejects.toThrow(/no usable signing key/);
  });

  // Branch 6: verifySignature — signature verification failed (key mismatch, same kid)
  test("rejects when the JWKS serves a different key for the same kid", async () => {
    const db = freshDb();
    const now = 1_000_000;
    // Sign with pair A
    const { jwt } = await makeSignedJwt(
      { iss: "https://acme", aud: "client-1", sub: "s", exp: now / 1000 + 3600 },
      "k1",
    );
    // Mint pair B — same kid "k1", different key material
    const { jwk: wrongJwk } = await makeSignedJwt(
      { iss: "https://acme", aud: "client-1", sub: "s", exp: now / 1000 + 3600 },
      "k1",
    );
    // Serve pair B's JWK for kid "k1"
    const cache = new JwksCache(
      db,
      async () => new Response(JSON.stringify({ keys: [wrongJwk] })),
      { maxAgeSeconds: 3600 },
    );
    const v = new IdTokenVerifier(cache, {
      issuer: "https://acme",
      clientId: "client-1",
      jwksUri: "https://acme/jwks",
    });
    await expect(v.validateIdToken(jwt, now)).rejects.toThrow(/signature verification failed/);
  });

  // Branch 7: assertIssuerAudience — issuer mismatch
  test("rejects a token whose iss does not match cfg.issuer", async () => {
    const db = freshDb();
    const now = 1_000_000;
    // Sign with iss "https://evil" but serve the matching JWK so signature passes
    const { jwt, jwk } = await makeSignedJwt(
      { iss: "https://evil", aud: "client-1", sub: "s", exp: now / 1000 + 3600 },
      "k1",
    );
    const cache = new JwksCache(db, async () => new Response(JSON.stringify({ keys: [jwk] })), {
      maxAgeSeconds: 3600,
    });
    const v = new IdTokenVerifier(cache, {
      issuer: "https://acme", // different from token iss
      clientId: "client-1",
      jwksUri: "https://acme/jwks",
    });
    await expect(v.validateIdToken(jwt, now)).rejects.toThrow(/issuer mismatch/);
  });

  // Branch 8: assertIssuerAudience — array aud that includes clientId → accepted
  test("accepts a token whose aud is an array containing the clientId", async () => {
    const db = freshDb();
    const now = 1_000_000;
    const { jwt, jwk } = await makeSignedJwt(
      {
        iss: "https://acme",
        aud: ["other-client", "client-1"],
        sub: "sub-array",
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
    expect(claims.sub).toBe("sub-array");
    expect(claims.aud).toBe("client-1");
  });

  // Branch 9: assertTimeWindow — nbf in the future (not yet valid)
  test("rejects a token with nbf far in the future", async () => {
    const db = freshDb();
    const now = 1_000_000;
    const nowSec = now / 1000;
    const { jwt, jwk } = await makeSignedJwt(
      {
        iss: "https://acme",
        aud: "client-1",
        sub: "s",
        exp: nowSec + 3600,
        nbf: nowSec + 7200, // well past clock_skew of 60s
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
    await expect(v.validateIdToken(jwt, now)).rejects.toThrow(/token not yet valid/);
  });

  // Branch 10: assertTimeWindow — nbf present and in the past → accepted, claims include nbf
  test("accepts a token with a past nbf and returns nbf in claims", async () => {
    const db = freshDb();
    const now = 1_000_000;
    const nowSec = now / 1000;
    const nbfVal = nowSec - 100;
    const { jwt, jwk } = await makeSignedJwt(
      {
        iss: "https://acme",
        aud: "client-1",
        sub: "sub-nbf",
        exp: nowSec + 3600,
        nbf: nbfVal,
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
    expect(claims.sub).toBe("sub-nbf");
    expect(claims.nbf).toBe(nbfVal);
  });

  // Branch 11: validateClaims — missing sub (empty string)
  test("rejects a token with an empty sub claim", async () => {
    const db = freshDb();
    const now = 1_000_000;
    const { jwt, jwk } = await makeSignedJwt(
      { iss: "https://acme", aud: "client-1", sub: "", exp: now / 1000 + 3600 },
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
    await expect(v.validateIdToken(jwt, now)).rejects.toThrow(/missing sub/);
  });

  // Branch 12: validateClaims — no email claim → claims.email is undefined
  test("accepts a token without email and returns claims.email as undefined", async () => {
    const db = freshDb();
    const now = 1_000_000;
    const { jwt, jwk } = await makeSignedJwt(
      { iss: "https://acme", aud: "client-1", sub: "sub-no-email", exp: now / 1000 + 3600 },
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
    expect(claims.sub).toBe("sub-no-email");
    expect(claims.email).toBeUndefined();
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
