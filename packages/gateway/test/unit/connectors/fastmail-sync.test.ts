import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createFastmailSyncable } from "../../../src/connectors/fastmail-sync.ts";
import {
  type ConnectorSyncFixture,
  createConnectorSyncFixture,
} from "../../helpers/connector-sync-harness.ts";

const CURSOR_PREFIX = "nimbus-fastmail1:";
function encodeCursor(payload: unknown): string {
  return CURSOR_PREFIX + Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}
const PASS_1_CURSOR = encodeCursor({ pass: 1 });

const SESSION_URL = "https://api.fastmail.com/jmap/session";
const API_URL = "https://api.fastmail.com/jmap/api/";

function sessionBody() {
  return { apiUrl: API_URL, primaryAccounts: { "urn:ietf:params:jmap:mail": "acc1" } };
}

function emailGetResponse(emails: unknown[]) {
  return {
    methodResponses: [
      ["Email/query", { accountId: "acc1", ids: emails.map((_, i) => `M${String(i)}`) }, "q"],
      ["Email/get", { accountId: "acc1", list: emails }, "e"],
    ],
  };
}

function rawEmail(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "M1",
    messageId: ["<a@x>"],
    subject: "First",
    from: [{ name: "A", email: "a@x" }],
    to: [{ email: "b@x" }],
    receivedAt: "2026-05-31T00:00:00Z",
    attachments: [],
    preview: "hello preview",
    textBody: [{ partId: "1" }],
    bodyValues: { "1": { value: "hello body text" } },
    ...over,
  };
}

describe("fastmail-sync", () => {
  let fx: ConnectorSyncFixture;
  const ensureCalls: number[] = [];

  beforeEach(() => {
    fx = createConnectorSyncFixture();
    ensureCalls.length = 0;
    fx.fetchMock.install();
  });
  afterEach(() => {
    fx.cleanup();
  });

  function makeSyncable() {
    return createFastmailSyncable({
      ensureFastmailMcpRunning: async (): Promise<void> => {
        ensureCalls.push(1);
      },
    });
  }

  test("missing api token → noop, preserves cursor, still ensures the mesh", async () => {
    const res = await makeSyncable().sync(fx.createSyncContext("fastmail"), "prev");
    expect(res.itemsUpserted).toBe(0);
    expect(res.cursor).toBe("prev");
    expect(ensureCalls).toHaveLength(1);
    expect(fx.fetchMock.calls).toHaveLength(0);
  });

  test("discovers the session then upserts one fastmail:email per Email/get entry", async () => {
    await fx.vault.set("fastmail.api_token", "tok");
    fx.fetchMock.respond("GET", SESSION_URL, sessionBody());
    fx.fetchMock.respond(
      "POST",
      API_URL,
      emailGetResponse([
        rawEmail({ id: "M1", messageId: ["<a@x>"], subject: "First" }),
        rawEmail({ id: "M2", messageId: ["<b@x>"], subject: "Second" }),
      ]),
    );

    const res = await makeSyncable().sync(fx.createSyncContext("fastmail"), null);
    expect(res.itemsUpserted).toBe(2);
    expect(res.cursor).toBe(PASS_1_CURSOR);
    expect(res.hasMore).toBe(false);

    const rows = fx.db
      .query<{ external_id: string; body_preview: string }, []>(
        "SELECT external_id, body_preview FROM item WHERE service = 'fastmail' ORDER BY external_id",
      )
      .all();
    expect(rows.map((r) => r.external_id)).toEqual(["<a@x>", "<b@x>"]);
    // The preview comes from the truncated textBody body value.
    expect(rows[0]?.body_preview).toBe("hello body text");
  });

  test("sends the Bearer token + a batched Email/query+get request", async () => {
    await fx.vault.set("fastmail.api_token", "tok");
    fx.fetchMock.respond("GET", SESSION_URL, sessionBody());
    fx.fetchMock.respond("POST", API_URL, emailGetResponse([rawEmail()]));

    await makeSyncable().sync(fx.createSyncContext("fastmail"), null);
    const sessionCall = fx.fetchMock.calls.find((c) => c.url === SESSION_URL);
    expect(sessionCall?.headers["authorization"]).toBe("Bearer tok");

    const postBody = fx.fetchMock.bodiesFor("POST", API_URL)[0] as Record<string, unknown>;
    const methodCalls = postBody["methodCalls"] as unknown[];
    expect((methodCalls[0] as unknown[])[0]).toBe("Email/query");
    expect((methodCalls[1] as unknown[])[0]).toBe("Email/get");
    const getArgs = (methodCalls[1] as unknown[])[1] as Record<string, unknown>;
    expect(getArgs["maxBodyValueBytes"]).toBe(2048);
  });

  test("session HTTP error preserves the cursor with zero upserts", async () => {
    await fx.vault.set("fastmail.api_token", "tok");
    fx.fetchMock.respond("GET", SESSION_URL, { error: "nope" }, { status: 401 });
    const res = await makeSyncable().sync(fx.createSyncContext("fastmail"), PASS_1_CURSOR);
    expect(res.itemsUpserted).toBe(0);
    expect(res.cursor).toBe(PASS_1_CURSOR);
  });

  test("a session response missing apiUrl/account → parse-empty, no api call", async () => {
    await fx.vault.set("fastmail.api_token", "tok");
    fx.fetchMock.respond("GET", SESSION_URL, { primaryAccounts: {} });
    const res = await makeSyncable().sync(fx.createSyncContext("fastmail"), null);
    expect(res.itemsUpserted).toBe(0);
    expect(res.cursor).toBe(PASS_1_CURSOR);
    expect(fx.fetchMock.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  test("an Email/query HTTP error after session preserves the cursor", async () => {
    await fx.vault.set("fastmail.api_token", "tok");
    fx.fetchMock.respond("GET", SESSION_URL, sessionBody());
    fx.fetchMock.respond("POST", API_URL, { error: "boom" }, { status: 500 });
    const res = await makeSyncable().sync(fx.createSyncContext("fastmail"), null);
    expect(res.itemsUpserted).toBe(0);
    expect(res.cursor).toBe(PASS_1_CURSOR);
  });

  test("honors a custom base_url override", async () => {
    await fx.vault.set("fastmail.api_token", "tok");
    await fx.vault.set("fastmail.base_url", "https://jmap.example.org/");
    fx.fetchMock.respond("GET", "https://jmap.example.org/jmap/session", {
      apiUrl: "https://jmap.example.org/api/",
      primaryAccounts: { "urn:ietf:params:jmap:mail": "acc1" },
    });
    fx.fetchMock.respond("POST", "https://jmap.example.org/api/", emailGetResponse([rawEmail()]));
    const res = await makeSyncable().sync(fx.createSyncContext("fastmail"), null);
    expect(res.itemsUpserted).toBe(1);
  });
});
