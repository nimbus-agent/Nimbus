import { Database } from "bun:sqlite";
import { afterEach, expect, jest, test } from "bun:test";
import { requestUrl } from "../../test/helpers/request-url.ts";
import type { NimbusIdentityToml, NimbusScimToml } from "../config/nimbus-toml.ts";
import { LocalIndex } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { buildIdentityBoot } from "./identity-boot.ts";
import { fakeVault, makeSignedJwt } from "./testing/identity-test-helpers.ts";

/**
 * The PRODUCTION device-code poll, on a fake clock: when the IdP answers `authorization_pending`,
 * the real `sleep` the boot wires in must hold the next token request for the full RFC 8628
 * interval (5 s) — polling early is what RFC 8628 answers with `slow_down`. `identity-boot.test.ts`
 * only ever answers the first poll with a token, so that wait never ran.
 */

const ISSUER = "https://acme";
const CFG: NimbusIdentityToml = {
  enabled: true,
  issuer: ISSUER,
  clientId: "c1",
  flow: "device_code",
  scopes: ["openid"],
  sessionGraceSeconds: 1000,
  revalidateIntervalSeconds: 3600,
  tokenRefreshSkewSeconds: 300,
  jwksMaxAgeSeconds: 86400,
};
const SCIM: NimbusScimToml = { enabled: false };

const dbs: Database[] = [];
afterEach(() => {
  jest.useRealTimers();
  for (const db of dbs.splice(0)) db.close();
});

function freshIndex(): LocalIndex {
  const db = new Database(":memory:");
  dbs.push(db);
  runIndexedSchemaMigrations(db, 34);
  return new LocalIndex(db);
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/**
 * Yields microtasks until `done()` holds (bounded), never waiting on a timer. Under fake timers
 * bun's per-test timeout never fires, so a step that did not happen must be detected this way: an
 * unbounded await on it would hang the whole test process instead of failing this test.
 */
async function flushUntil(done: () => boolean): Promise<void> {
  for (let i = 0; i < 1_000 && !done(); i++) await Promise.resolve();
}

/** Races `p` against a REAL timer, so a login that never settles fails. Real clock only. */
async function withinRealMs<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${what} did not settle within ${String(ms)} ms`));
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("an authorization_pending answer holds the next poll for the full 5 s interval", async () => {
  const realNow = Date.now();
  const { jwt, jwk } = await makeSignedJwt(
    { iss: ISSUER, aud: "c1", sub: "user-pending", exp: Math.floor(realNow / 1000) + 3600 },
    "pending-k1",
  );

  let tokenPolls = 0;
  let firstPollSeen: () => void = () => {};
  const firstPoll = new Promise<void>((resolve) => {
    firstPollSeen = resolve;
  });
  const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
    const url = requestUrl(input);
    if (url.endsWith("/.well-known/openid-configuration")) {
      return json({
        issuer: ISSUER,
        device_authorization_endpoint: `${ISSUER}/device`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/jwks`,
      });
    }
    if (url.endsWith("/device")) {
      return json({
        device_code: "dc-pending",
        user_code: "UC-0001",
        verification_uri: `${ISSUER}/verify`,
        interval: 5,
        expires_in: 600,
      });
    }
    if (url.endsWith("/token")) {
      tokenPolls += 1;
      if (tokenPolls === 1) {
        firstPollSeen();
        return json({ error: "authorization_pending" }, 400);
      }
      return json({ id_token: jwt });
    }
    if (url.endsWith("/jwks")) return json({ keys: [jwk] });
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;

  jest.useFakeTimers();
  jest.setSystemTime(realNow);
  const { vault } = fakeVault();
  const boot = buildIdentityBoot(CFG, SCIM, freshIndex(), vault, { fetchImpl });
  const finished = new Promise<string>((resolve) => {
    boot.bindLoginNotify((method) => {
      if (method === "identity.loginDone" || method === "identity.loginError") resolve(method);
    });
  });

  boot.startLogin();
  // Raced with the login's own outcome: a login that fails before its first poll settles `finished`
  // with loginError and fails HERE, instead of waiting forever for a poll that never comes.
  const first = await Promise.race([firstPoll.then(() => "first poll"), finished]);
  expect(first).toBe("first poll");
  // The pending answer is parsed and the production sleep armed within a few microtasks; the
  // sleep is the ONLY timer on the login path.
  for (let i = 0; i < 200 && jest.getTimerCount() === 0; i++) await Promise.resolve();
  expect(jest.getTimerCount()).toBe(1);

  jest.advanceTimersByTime(4_999);
  await flushMicrotasks();
  expect(tokenPolls).toBe(1);

  jest.advanceTimersByTime(1);
  await flushUntil(() => tokenPolls === 2);
  expect(tokenPolls).toBe(2);

  // What remains (verifying the id_token) waits on no timer; bound it on the REAL clock.
  jest.useRealTimers();
  expect(await withinRealMs(finished, 10_000, "the login")).toBe("identity.loginDone");
  expect(boot.store.getSession(ISSUER)?.externalId).toBe("user-pending");
});
