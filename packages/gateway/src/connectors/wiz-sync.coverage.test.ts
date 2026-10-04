/**
 * Wiz paths the fake-server integration test does not reach: the default (unconfigured) API and
 * auth endpoints, a token response that is not JSON, an issues query that fails outright, and
 * GraphQL `data` envelopes whose parts are missing or the wrong shape.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { StubFetch } from "../../test/helpers/stub-fetch.ts";
import {
  createMemoryIndexDb,
  createStubVault,
  syncTestContext,
} from "./connector-sync-test-helpers.ts";
import { decodeNimbusJsonCursorPayload } from "./nimbus-json-cursor.ts";
import { createWizSyncable } from "./wiz-sync.ts";

const DEFAULT_AUTH = "https://auth.app.wiz.io/oauth/token";
const DEFAULT_API = "https://api.app.wiz.io/graphql";
const ENSURE = { ensureWizMcpRunning: async (): Promise<void> => {} };

let mock: StubFetch;

beforeEach(() => {
  mock = new StubFetch();
  mock.install();
});

afterEach(() => {
  mock.restore();
});

function ctxFor(db: Database) {
  // Only the client credentials: no api_url / auth_url, so the defaults apply.
  return syncTestContext(
    db,
    createStubVault({ "wiz.client_id": "cid", "wiz.client_secret": "csecret" }),
    "wiz",
  );
}

function isPass1(cursor: string | null): boolean {
  const p = decodeNimbusJsonCursorPayload(cursor ?? "", "nimbus-wiz1:") as
    | { pass?: unknown }
    | undefined;
  return p?.pass === 1;
}

describe("endpoints", () => {
  test("with no api_url or auth_url configured, it authenticates and queries Wiz's default endpoints", async () => {
    mock.respond("POST", DEFAULT_AUTH, { access_token: "tok" });
    mock.respond("POST", DEFAULT_API, {
      data: { issues: { nodes: [{ id: "issue-1" }], pageInfo: { hasNextPage: false } } },
    });
    const db = createMemoryIndexDb();

    const r = await createWizSyncable(ENSURE).sync(ctxFor(db), null);

    expect(mock.calls.map((c) => c.url)).toEqual([DEFAULT_AUTH, DEFAULT_API]);
    expect(mock.calls[1]?.headers["authorization"]).toBe("Bearer tok");
    expect(r.itemsUpserted).toBe(1);
    db.close();
  });

  test("a configured api_url and auth_url (trimmed) replace the defaults", async () => {
    const auth = "https://wiz.example.test/oauth/token";
    const api = "https://wiz.example.test/graphql";
    mock.respond("POST", auth, { access_token: "tok" });
    mock.respond("POST", api, { data: { issues: { nodes: [], pageInfo: {} } } });
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(
      db,
      createStubVault({
        "wiz.client_id": "cid",
        "wiz.client_secret": "csecret",
        "wiz.api_url": `  ${api}  `,
        "wiz.auth_url": `\t${auth}\n`,
      }),
      "wiz",
    );

    await createWizSyncable(ENSURE).sync(ctx, null);

    expect(mock.calls.map((c) => c.url)).toEqual([auth, api]);
    db.close();
  });

  test("a token response that is not JSON ends the pass before any issues query", async () => {
    mock.respondWithText("POST", DEFAULT_AUTH, "<html>gateway timeout</html>");
    const db = createMemoryIndexDb();

    const r = await createWizSyncable(ENSURE).sync(ctxFor(db), null);

    expect(mock.calls.map((c) => c.url)).toEqual([DEFAULT_AUTH]);
    expect(r.itemsUpserted).toBe(0);
    expect(r.hasMore).toBe(false);
    db.close();
  });
});

describe("issues query", () => {
  test.each([
    [
      "an HTTP error",
      (m: StubFetch) => m.respondWithText("POST", DEFAULT_API, "boom", { status: 500 }),
    ],
    [
      "a body that is not JSON",
      (m: StubFetch) => m.respondWithText("POST", DEFAULT_API, "not json"),
    ],
  ])("%s ends the cycle with nothing indexed and a pass-1 cursor", async (_label, stub) => {
    mock.respond("POST", DEFAULT_AUTH, { access_token: "tok" });
    stub(mock);
    const db = createMemoryIndexDb();

    const r = await createWizSyncable(ENSURE).sync(ctxFor(db), null);

    expect(mock.calls.map((c) => c.url)).toEqual([DEFAULT_AUTH, DEFAULT_API]);
    expect(r.itemsUpserted).toBe(0);
    expect(isPass1(r.cursor)).toBe(true);
    db.close();
  });

  test.each([
    ["no data at all", {}],
    ["data that is not an object", { data: ["unexpected"] }],
    ["issues that is not an object", { data: { issues: "none" } }],
    [
      "nodes that is not a list, and pageInfo that is not an object",
      {
        data: { issues: { nodes: { id: "issue-1" }, pageInfo: "end" } },
      },
    ],
  ])(
    "an envelope with %s indexes nothing and asks for no further page",
    async (_label, envelope) => {
      mock.respond("POST", DEFAULT_AUTH, { access_token: "tok" });
      mock.respond("POST", DEFAULT_API, envelope);
      const db = createMemoryIndexDb();

      const r = await createWizSyncable(ENSURE).sync(ctxFor(db), null);

      expect(mock.calls.filter((c) => c.url === DEFAULT_API)).toHaveLength(1);
      expect(r.itemsUpserted).toBe(0);
      expect(isPass1(r.cursor)).toBe(true);
      db.close();
    },
  );
});
