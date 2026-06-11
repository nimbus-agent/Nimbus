import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { V34_IDENTITY_SQL } from "../index/identity-v34-sql.ts";
import { makeSignedJwt } from "./identity-test-helpers.ts";
import { BOT_FRAMEWORK_ISSUER, buildTeamsBotJwtValidator } from "./teams-bot-jwt.ts";

function memDb(): Database {
  const db = new Database(":memory:");
  for (const stmt of V34_IDENTITY_SQL) db.exec(stmt);
  return db;
}

const APP_ID = "bot-app-1";
const JWKS_URI = "https://login.botframework.com/v1/keys";

function fetchServing(jwk: unknown): typeof fetch {
  return ((url: string | URL) => {
    const u = String(url);
    if (u.includes("openidconfiguration")) {
      return Promise.resolve(Response.json({ jwks_uri: JWKS_URI }));
    }
    if (u === JWKS_URI) {
      return Promise.resolve(Response.json({ keys: [jwk] }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  }) as typeof fetch;
}

async function mintedToken(
  claims: Record<string, unknown>,
): Promise<{ jwt: string; jwk: unknown }> {
  return makeSignedJwt(
    {
      iss: BOT_FRAMEWORK_ISSUER,
      aud: APP_ID,
      sub: "bot-service",
      exp: 2_000_000_000,
      ...claims,
    },
    "kid-1",
  );
}

describe("buildTeamsBotJwtValidator (I18 reuse; aud === teamsBotAppId; fail-closed)", () => {
  test("accepts a valid Bot Framework JWT", async () => {
    const { jwt, jwk } = await mintedToken({});
    const validate = buildTeamsBotJwtValidator({
      db: memDb(),
      teamsBotAppId: APP_ID,
      fetchLike: fetchServing(jwk),
    });
    expect(await validate(`Bearer ${jwt}`, 1_700_000_000_000)).toBe(true);
  });

  test("accepts a case-insensitive `bearer` scheme (RFC 7235)", async () => {
    const { jwt, jwk } = await mintedToken({});
    const validate = buildTeamsBotJwtValidator({
      db: memDb(),
      teamsBotAppId: APP_ID,
      fetchLike: fetchServing(jwk),
    });
    expect(await validate(`bearer ${jwt}`, 1_700_000_000_000)).toBe(true);
  });

  test("rejects a token minted for a different audience", async () => {
    const { jwt, jwk } = await mintedToken({ aud: "someone-else" });
    const validate = buildTeamsBotJwtValidator({
      db: memDb(),
      teamsBotAppId: APP_ID,
      fetchLike: fetchServing(jwk),
    });
    expect(await validate(`Bearer ${jwt}`, 1_700_000_000_000)).toBe(false);
  });

  test("fail-closed: missing / non-Bearer header and garbage tokens", async () => {
    const validate = buildTeamsBotJwtValidator({
      db: memDb(),
      teamsBotAppId: APP_ID,
      fetchLike: fetchServing({}),
    });
    expect(await validate(null, 0)).toBe(false);
    expect(await validate("Basic abc", 0)).toBe(false);
    expect(await validate("Bearer not.a.jwt", 0)).toBe(false);
  });

  test("fail-closed: non-ok discovery response → false (no verifier built)", async () => {
    const validate = buildTeamsBotJwtValidator({
      db: memDb(),
      teamsBotAppId: APP_ID,
      fetchLike: ((_url: string | URL) =>
        Promise.resolve(new Response("upstream down", { status: 503 }))) as typeof fetch,
    });
    expect(await validate("Bearer x.y.z", 1_700_000_000_000)).toBe(false);
  });

  test("fail-closed: discovery doc missing a usable jwks_uri → false", async () => {
    const noJwks = buildTeamsBotJwtValidator({
      db: memDb(),
      teamsBotAppId: APP_ID,
      fetchLike: ((_url: string | URL) =>
        Promise.resolve(Response.json({ jwks_uri: "" }))) as typeof fetch,
    });
    expect(await noJwks("Bearer x.y.z", 1_700_000_000_000)).toBe(false);

    const wrongType = buildTeamsBotJwtValidator({
      db: memDb(),
      teamsBotAppId: APP_ID,
      fetchLike: ((_url: string | URL) =>
        Promise.resolve(Response.json({ jwks_uri: 42 }))) as typeof fetch,
    });
    expect(await wrongType("Bearer x.y.z", 1_700_000_000_000)).toBe(false);
  });

  test("default log sink: a discovery throw is swallowed without a provided logger", async () => {
    // Omitting `log` exercises the `deps.log ?? (() => {})` default-sink branch.
    const validate = buildTeamsBotJwtValidator({
      db: memDb(),
      teamsBotAppId: APP_ID,
      fetchLike: ((_url: string | URL) => Promise.reject(new Error("offline"))) as typeof fetch,
    });
    expect(await validate("Bearer x.y.z", 1_700_000_000_000)).toBe(false);
  });

  test("caches the verifier: discovery is fetched once across repeated validations", async () => {
    // The second valid call must take the `if (verifier !== undefined) return verifier` fast path
    // (no re-discovery): the OpenID config is fetched exactly once for two successful validations.
    const { jwt, jwk } = await mintedToken({});
    let discoveryFetches = 0;
    const inner = fetchServing(jwk);
    const counting = ((url: string | URL, init?: RequestInit) => {
      if (String(url).includes("openidconfiguration")) discoveryFetches++;
      return inner(url as never, init as never);
    }) as typeof fetch;
    const validate = buildTeamsBotJwtValidator({
      db: memDb(),
      teamsBotAppId: APP_ID,
      fetchLike: counting,
    });
    expect(await validate(`Bearer ${jwt}`, 1_700_000_000_000)).toBe(true);
    expect(await validate(`Bearer ${jwt}`, 1_700_000_000_000)).toBe(true);
    expect(discoveryFetches).toBe(1);
  });

  test("fail-closed: a whitespace-only token trims to empty → false (never reaches the verifier)", async () => {
    // `/^Bearer\s+(.+)$/i` backtracks so `(.+)` captures a trailing space; `.trim()` empties it,
    // hitting the `token === ""` guard before any discovery/verify runs.
    let fetched = false;
    const validate = buildTeamsBotJwtValidator({
      db: memDb(),
      teamsBotAppId: APP_ID,
      fetchLike: ((_url: string | URL) => {
        fetched = true;
        return Promise.resolve(Response.json({ jwks_uri: JWKS_URI }));
      }) as typeof fetch,
    });
    expect(await validate("Bearer   ", 1_700_000_000_000)).toBe(false);
    expect(fetched).toBe(false);
  });

  test("default log sink swallows a non-Error discovery rejection", async () => {
    // The discovery catch logs `e instanceof Error ? e.message : e`; rejecting with a non-Error
    // value (a string) exercises the `: e` branch of that ternary, still fail-closed to false.
    const validate = buildTeamsBotJwtValidator({
      db: memDb(),
      teamsBotAppId: APP_ID,
      log: () => {},
      fetchLike: ((_url: string | URL) => Promise.reject("string-failure")) as typeof fetch,
    });
    expect(await validate("Bearer x.y.z", 1_700_000_000_000)).toBe(false);
  });

  test("fail-closed: discovery outage → false, and recovers on a later call", async () => {
    const { jwt, jwk } = await mintedToken({});
    let healthy = false;
    const inner = fetchServing(jwk);
    const flaky = ((url: string | URL, init?: RequestInit) => {
      if (!healthy) return Promise.reject(new Error("offline"));
      return inner(url as never, init as never);
    }) as typeof fetch;
    const validate = buildTeamsBotJwtValidator({
      db: memDb(),
      teamsBotAppId: APP_ID,
      fetchLike: flaky,
    });
    expect(await validate(`Bearer ${jwt}`, 1_700_000_000_000)).toBe(false);
    healthy = true;
    expect(await validate(`Bearer ${jwt}`, 1_700_000_000_000)).toBe(true);
  });
});
