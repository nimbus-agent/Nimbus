/**
 * Firebase App Distribution paths the fake-server suite does not reach: an `app_ids` value made
 * only of separators, release bodies of the wrong shape, release entries that are not objects or
 * carry no name, and the DEFAULT token minter (every other test injects `mintToken`).
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";

import { StubFetch } from "../../test/helpers/stub-fetch.ts";
import {
  createMemoryIndexDb,
  createStubVault,
  syncTestContext,
} from "./connector-sync-test-helpers.ts";
import { createFirebaseSyncable } from "./firebase-sync.ts";

const RELEASES_RE = /^https:\/\/firebaseappdistribution\.googleapis\.com\/v1\/projects\//;
const APP_A = "1:111:android:aaa";
const APP_B = "1:222:ios:bbb";

let fetchStub: StubFetch;
let db: Database;

beforeEach(() => {
  fetchStub = new StubFetch();
  fetchStub.install();
  db = createMemoryIndexDb();
});

afterEach(() => {
  fetchStub.restore();
  db.close();
});

function saJson(extra: Record<string, string> = {}): string {
  return JSON.stringify({
    client_email: "sa@p.iam.gserviceaccount.com",
    private_key: "k",
    ...extra,
  });
}

function ctxWith(appIds: string, serviceAccountJson = saJson()) {
  return syncTestContext(
    db,
    createStubVault({
      "firebase.service_account_json": serviceAccountJson,
      "firebase.app_ids": appIds,
    }),
    "firebase",
  );
}

/** A minter that records how often it was asked, so "never minted" is assertable. */
function countingMinter(): { mint: () => Promise<string>; calls: { n: number } } {
  const calls = { n: 0 };
  return {
    calls,
    mint: () => {
      calls.n += 1;
      return Promise.resolve("injected-token");
    },
  };
}

function firebaseExternalIds(): string[] {
  return (
    db
      .query("SELECT external_id FROM item WHERE service = 'firebase' ORDER BY external_id")
      .all() as { external_id: string }[]
  ).map((r) => r.external_id);
}

describe("firebase-sync — app_ids with no usable id", () => {
  test("separators and whitespace only → treated as unconfigured: no mint, no request, cursor kept", async () => {
    const { mint, calls } = countingMinter();
    const res = await createFirebaseSyncable({
      ensureFirebaseMcpRunning: async () => {},
      mintToken: mint,
    }).sync(ctxWith(" , ,, "), "prev-cursor");

    expect(res.cursor).toBe("prev-cursor");
    expect(res.itemsUpserted).toBe(0);
    expect(calls.n).toBe(0);
    expect(fetchStub.calls).toHaveLength(0);
  });
});

describe("firebase-sync — malformed release bodies", () => {
  test("a non-object body and a non-array `releases` both index nothing but still count their bytes", async () => {
    // Both bodies carry a release that WOULD map on its own — a bare array of one, and a lone
    // object under `releases` — so "indexes nothing" proves each shape was ignored, not read as a
    // list of something unmappable.
    const bodyA: unknown = [{ name: "projects/111/apps/x/releases/r1" }];
    const bodyB = { releases: { name: "projects/222/apps/y/releases/r1" } };
    fetchStub.respond("GET", /\/projects\/111\/apps\//, bodyA);
    fetchStub.respond("GET", /\/projects\/222\/apps\//, bodyB);

    const res = await createFirebaseSyncable({
      ensureFirebaseMcpRunning: async () => {},
      mintToken: countingMinter().mint,
    }).sync(ctxWith(`${APP_A},${APP_B}`), null);

    expect(res.itemsUpserted).toBe(0);
    expect(res.bytesTransferred).toBe(JSON.stringify(bodyA).length + JSON.stringify(bodyB).length);
    expect(fetchStub.calls.map((c) => c.url.match(/projects\/(\d+)\//)?.[1])).toEqual([
      "111",
      "222",
    ]);
    expect(firebaseExternalIds()).toEqual([]);
  });

  test("non-object entries and nameless releases are skipped; the named release is indexed", async () => {
    const named = `projects/111/apps/${APP_A}/releases/ok-1`;
    fetchStub.respond("GET", RELEASES_RE, {
      releases: [null, "release-as-string", 7, { displayVersion: "2.0" }, { name: named }],
    });

    const res = await createFirebaseSyncable({
      ensureFirebaseMcpRunning: async () => {},
      mintToken: countingMinter().mint,
    }).sync(ctxWith(APP_A), null);

    expect(res.itemsUpserted).toBe(1);
    expect(firebaseExternalIds()).toEqual([named]);
  });
});

describe("firebase-sync — default token minter", () => {
  test("without an injected minter it exchanges the service-account assertion at the SA's token_uri", async () => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const tokenUri = "https://oauth2.firebase-test.invalid/token";
    fetchStub.respond("POST", tokenUri, { access_token: "minted-by-default", expires_in: 3600 });
    fetchStub.respond("GET", RELEASES_RE, { releases: [] });

    const res = await createFirebaseSyncable({ ensureFirebaseMcpRunning: async () => {} }).sync(
      ctxWith(APP_A, saJson({ private_key: privateKey, token_uri: tokenUri })),
      null,
    );

    expect(res.itemsUpserted).toBe(0);
    expect(fetchStub.calls.map((c) => `${c.method} ${c.url.split("?")[0]}`)).toEqual([
      `POST ${tokenUri}`,
      `GET https://firebaseappdistribution.googleapis.com/v1/projects/111/apps/${encodeURIComponent(APP_A)}/releases`,
    ]);
    expect(fetchStub.calls[1]?.headers["authorization"]).toBe("Bearer minted-by-default");
  });
});
