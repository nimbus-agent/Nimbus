import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { ImapConnectionConfig, ImapFetchOutcome } from "../../../src/connectors/imap-sync.ts";
import { createProtonmailSyncable } from "../../../src/connectors/protonmail-sync.ts";
import {
  type ConnectorSyncFixture,
  createConnectorSyncFixture,
} from "../../helpers/connector-sync-harness.ts";

const CURSOR_PREFIX = "nimbus-protonmail1:";
function encodeCursor(payload: unknown): string {
  return CURSOR_PREFIX + Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}
const PASS_1_CURSOR = encodeCursor({ pass: 1 });

function okMessages(): ImapFetchOutcome {
  return {
    ok: true,
    messages: [
      {
        uid: 5,
        mailbox: "INBOX",
        uidValidity: "100",
        messageId: "<a@proton.me>",
        subject: "First",
        date: "2026-05-31T00:00:00.000Z",
        from: ["a@proton.me"],
        to: ["b@proton.me"],
        attachments: [],
        preview: "hello",
      },
    ],
  };
}

describe("protonmail-sync", () => {
  let fx: ConnectorSyncFixture;
  const ensureCalls: number[] = [];
  let lastConfig: ImapConnectionConfig | null = null;

  beforeEach(() => {
    fx = createConnectorSyncFixture();
    ensureCalls.length = 0;
    lastConfig = null;
  });
  afterEach(() => {
    fx.cleanup();
  });

  function makeSyncable(outcome: ImapFetchOutcome | (() => Promise<ImapFetchOutcome>)) {
    return createProtonmailSyncable({
      ensureProtonmailMcpRunning: async (): Promise<void> => {
        ensureCalls.push(1);
      },
      fetchMessages: async (config): Promise<ImapFetchOutcome> => {
        lastConfig = config;
        return typeof outcome === "function" ? await outcome() : outcome;
      },
    });
  }

  test("missing Bridge credentials → noop, preserves cursor, still ensures the mesh", async () => {
    const res = await makeSyncable(okMessages()).sync(fx.createSyncContext("protonmail"), "prev");
    expect(res.itemsUpserted).toBe(0);
    expect(res.cursor).toBe("prev");
    expect(ensureCalls).toHaveLength(1);
    expect(lastConfig).toBeNull();
  });

  test("defaults to the Bridge loopback (127.0.0.1:1143, STARTTLS, self-signed)", async () => {
    await fx.vault.set("protonmail.username", "bridge-user");
    await fx.vault.set("protonmail.password", "bridge-pass");
    const res = await makeSyncable(okMessages()).sync(fx.createSyncContext("protonmail"), null);
    expect(res.itemsUpserted).toBe(1);
    expect(res.cursor).toBe(PASS_1_CURSOR);
    expect(lastConfig?.host).toBe("127.0.0.1");
    expect(lastConfig?.port).toBe(1143);
    expect(lastConfig?.secure).toBe(false);
    expect(lastConfig?.tlsRejectUnauthorized).toBe(false);

    const rows = fx.db
      .query<{ external_id: string }, []>(
        "SELECT external_id FROM item WHERE service = 'protonmail'",
      )
      .all();
    expect(rows.map((r) => r.external_id)).toEqual(["<a@proton.me>"]);
  });

  test("honors a custom Bridge host/port override", async () => {
    await fx.vault.set("protonmail.username", "u");
    await fx.vault.set("protonmail.password", "p");
    await fx.vault.set("protonmail.imap_host", "proton-bridge.test");
    await fx.vault.set("protonmail.imap_port", "11143");
    await makeSyncable(okMessages()).sync(fx.createSyncContext("protonmail"), null);
    expect(lastConfig?.host).toBe("proton-bridge.test");
    expect(lastConfig?.port).toBe(11143);
  });

  test("connection failure preserves the cursor with zero upserts", async () => {
    await fx.vault.set("protonmail.username", "u");
    await fx.vault.set("protonmail.password", "p");
    const res = await makeSyncable({ ok: false, error: "ECONNREFUSED (Bridge not running?)" }).sync(
      fx.createSyncContext("protonmail"),
      PASS_1_CURSOR,
    );
    expect(res.itemsUpserted).toBe(0);
    expect(res.cursor).toBe(PASS_1_CURSOR);
  });

  test("a thrown fetcher is treated as transient", async () => {
    await fx.vault.set("protonmail.username", "u");
    await fx.vault.set("protonmail.password", "p");
    const res = await makeSyncable(() => {
      throw new Error("bridge down");
    }).sync(fx.createSyncContext("protonmail"), null);
    expect(res.itemsUpserted).toBe(0);
    expect(res.cursor).toBe(PASS_1_CURSOR);
  });
});
