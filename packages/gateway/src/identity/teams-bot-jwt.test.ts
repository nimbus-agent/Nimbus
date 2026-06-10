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
