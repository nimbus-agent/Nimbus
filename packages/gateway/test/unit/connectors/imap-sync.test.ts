import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  createImapSyncable,
  type ImapConnectionConfig,
  type ImapFetchOutcome,
} from "../../../src/connectors/imap-sync.ts";
import {
  type ConnectorSyncFixture,
  createConnectorSyncFixture,
} from "../../helpers/connector-sync-harness.ts";

const CURSOR_PREFIX = "nimbus-imap1:";
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
        messageId: "<a@x>",
        subject: "First",
        date: "2026-05-31T00:00:00.000Z",
        from: ["a@x"],
        to: ["b@x"],
        attachments: [],
        preview: "hello",
      },
      {
        uid: 6,
        mailbox: "INBOX",
        uidValidity: "100",
        messageId: "<b@x>",
        subject: "Second",
        date: "2026-05-31T01:00:00.000Z",
        from: ["a@x"],
        to: ["b@x"],
        attachments: [{ filename: "f.pdf", sizeBytes: 1, mimeType: "application/pdf" }],
        preview: "world",
      },
    ],
  };
}

describe("imap-sync", () => {
  let fx: ConnectorSyncFixture;
  const ensureCalls: number[] = [];
  let lastFetchConfig: ImapConnectionConfig | null = null;
  let lastFetchLimit = 0;

  beforeEach(() => {
    fx = createConnectorSyncFixture();
    ensureCalls.length = 0;
    lastFetchConfig = null;
    lastFetchLimit = 0;
  });
  afterEach(() => {
    fx.cleanup();
  });

  function makeSyncable(outcome: ImapFetchOutcome | (() => Promise<ImapFetchOutcome>)) {
    return createImapSyncable({
      ensureImapMcpRunning: async (): Promise<void> => {
        ensureCalls.push(1);
      },
      fetchMessages: async (config, limit): Promise<ImapFetchOutcome> => {
        lastFetchConfig = config;
        lastFetchLimit = limit;
        return typeof outcome === "function" ? await outcome() : outcome;
      },
    });
  }

  async function setCreds(extra: Record<string, string> = {}): Promise<void> {
    await fx.vault.set("imap.host", "imap.example.com");
    await fx.vault.set("imap.username", "user@example.com");
    await fx.vault.set("imap.password", "secret");
    for (const [k, v] of Object.entries(extra)) {
      await fx.vault.set(k, v);
    }
  }

  test("missing credentials → noop, preserves cursor, still ensures the mesh", async () => {
    const res = await makeSyncable(okMessages()).sync(fx.createSyncContext("imap"), "prev");
    expect(res.itemsUpserted).toBe(0);
    expect(res.cursor).toBe("prev");
    expect(ensureCalls).toHaveLength(1);
    expect(lastFetchConfig).toBeNull();
  });

  test("upserts one imap:email item per message and returns the pass-1 cursor", async () => {
    await setCreds();
    const res = await makeSyncable(okMessages()).sync(fx.createSyncContext("imap"), null);
    expect(res.itemsUpserted).toBe(2);
    expect(res.cursor).toBe(PASS_1_CURSOR);
    expect(res.hasMore).toBe(false);

    const rows = fx.db
      .query<{ external_id: string }, []>(
        "SELECT external_id FROM item WHERE service = 'imap' ORDER BY external_id",
      )
      .all();
    expect(rows.map((r) => r.external_id)).toEqual(["<a@x>", "<b@x>"]);
  });

  test("defaults to port 993 / INBOX and resolves the configured port + mailbox", async () => {
    await setCreds({ "imap.port": "1143", "imap.mailbox": "Archive" });
    await makeSyncable(okMessages()).sync(fx.createSyncContext("imap"), null);
    expect(lastFetchConfig?.port).toBe(1143);
    expect(lastFetchConfig?.mailbox).toBe("Archive");

    // A fresh fixture with no port/mailbox → defaults.
    fx.cleanup();
    fx = createConnectorSyncFixture();
    await setCreds();
    await makeSyncable(okMessages()).sync(fx.createSyncContext("imap"), null);
    expect(lastFetchConfig?.port).toBe(993);
    expect(lastFetchConfig?.mailbox).toBe("INBOX");
  });

  test("connection failure (ok:false) preserves the cursor with zero upserts", async () => {
    await setCreds();
    const res = await makeSyncable({ ok: false, error: "ECONNREFUSED" }).sync(
      fx.createSyncContext("imap"),
      PASS_1_CURSOR,
    );
    expect(res.itemsUpserted).toBe(0);
    expect(res.cursor).toBe(PASS_1_CURSOR);
    expect(res.hasMore).toBe(false);
  });

  test("a thrown fetcher is treated as transient — no crash, cursor preserved", async () => {
    await setCreds();
    const res = await makeSyncable(() => {
      throw new Error("socket exploded");
    }).sync(fx.createSyncContext("imap"), null);
    expect(res.itemsUpserted).toBe(0);
    // null cursor → falls back to the pass-1 cursor.
    expect(res.cursor).toBe(PASS_1_CURSOR);
  });

  test("requests at most MAX_MESSAGES (200) per pass", async () => {
    await setCreds();
    await makeSyncable(okMessages()).sync(fx.createSyncContext("imap"), null);
    expect(lastFetchLimit).toBe(200);
  });
});
