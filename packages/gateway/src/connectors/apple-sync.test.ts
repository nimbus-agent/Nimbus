/**
 * Tests for the Apple (iCloud Mail) gateway sync.
 *
 * Uses a real in-memory SQLite index (via createMemoryIndexDb) and a fake
 * ImapMessageFetcher — no real IMAP socket is opened.
 *
 * Coverage targets:
 *  - Happy path: two messages are fetched and upserted as `apple:email` rows.
 *  - Correct external_id: prefers RFC message-id; falls back to mailbox:uv:uid.
 *  - Preview cap: body_preview is at most 2000 chars.
 *  - loadMailConfig null path: returns null when creds are absent → sync is a noop.
 *  - loadMailConfig uses fixed iCloud IMAP constants (host, port, secure).
 *  - loadMailConfig mailbox fallback: defaults to "INBOX" when vault key absent.
 */
import { describe, expect, test } from "bun:test";
import { type AppleSyncableOptions, createAppleSyncable, loadMailConfig } from "./apple-sync.ts";
import {
  createMemoryIndexDb,
  createStubVault,
  expectServiceItemCount,
  expectSyncNoopResult,
  syncTestContext,
} from "./connector-sync-test-helpers.ts";
import type { ImapMessageInput } from "./imap-email-mapping.ts";
import type { ImapFetchOutcome } from "./imap-sync.ts";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeMessage(overrides: Partial<ImapMessageInput> = {}): ImapMessageInput {
  return {
    uid: 1,
    mailbox: "INBOX",
    uidValidity: "99",
    messageId: "<msg-1@icloud.com>",
    subject: "Test subject",
    date: new Date(Date.now() - 3_600_000).toISOString(),
    from: ["sender@icloud.com"],
    to: ["recipient@example.com"],
    cc: [],
    attachments: [],
    preview: "Short preview text",
    ...overrides,
  };
}

/** A fake fetcher that returns `messages` immediately (no network). */
function fakeFetcher(messages: ImapMessageInput[]): AppleSyncableOptions["fetchMessages"] {
  return async (_config, _limit): Promise<ImapFetchOutcome> => ({
    ok: true,
    messages,
  });
}

/** A fake fetcher that returns `{ ok: false }` to simulate a connection error. */
function errorFetcher(): AppleSyncableOptions["fetchMessages"] {
  return async (_config, _limit): Promise<ImapFetchOutcome> => ({
    ok: false,
    error: "IMAP connection refused",
  });
}

/** Vault with both required secrets present. */
function credsVault(email = "user@icloud.com", appPw = "xxxx-yyyy-zzzz-aaaa") {
  return createStubVault({
    "apple.icloud_email": email,
    "apple.icloud_app_password": appPw,
  });
}

/** Vault with no apple secrets (simulates unconfigured connector). */
function emptyVault() {
  return createStubVault({
    "apple.icloud_email": null,
    "apple.icloud_app_password": null,
  });
}

// ─── loadMailConfig ────────────────────────────────────────────────────────────

describe("loadMailConfig", () => {
  test("returns null when icloud_email is absent", async () => {
    const db = createMemoryIndexDb();
    const vault = createStubVault({
      "apple.icloud_email": null,
      "apple.icloud_app_password": "xxxx-yyyy-zzzz-aaaa",
    });
    const result = await loadMailConfig(syncTestContext(db, vault));
    expect(result).toBeNull();
  });

  test("returns null when icloud_app_password is absent", async () => {
    const db = createMemoryIndexDb();
    const vault = createStubVault({
      "apple.icloud_email": "user@icloud.com",
      "apple.icloud_app_password": null,
    });
    const result = await loadMailConfig(syncTestContext(db, vault));
    expect(result).toBeNull();
  });

  test("returns null when icloud_email is empty string", async () => {
    const db = createMemoryIndexDb();
    const vault = createStubVault({
      "apple.icloud_email": "",
      "apple.icloud_app_password": "xxxx-yyyy-zzzz-aaaa",
    });
    const result = await loadMailConfig(syncTestContext(db, vault));
    expect(result).toBeNull();
  });

  test("returns null when icloud_app_password is empty string", async () => {
    const db = createMemoryIndexDb();
    const vault = createStubVault({
      "apple.icloud_email": "user@icloud.com",
      "apple.icloud_app_password": "",
    });
    const result = await loadMailConfig(syncTestContext(db, vault));
    expect(result).toBeNull();
  });

  test("returns fixed iCloud IMAP config when both secrets are present", async () => {
    const db = createMemoryIndexDb();
    const vault = credsVault();
    const result = await loadMailConfig(syncTestContext(db, vault));
    expect(result).not.toBeNull();
    expect(result?.host).toBe("imap.mail.me.com");
    expect(result?.port).toBe(993);
    expect(result?.secure).toBe(true);
    expect(result?.username).toBe("user@icloud.com");
    expect(result?.password).toBe("xxxx-yyyy-zzzz-aaaa");
  });

  test("defaults mailbox to INBOX when apple.mailbox is absent", async () => {
    const db = createMemoryIndexDb();
    const vault = credsVault();
    const result = await loadMailConfig(syncTestContext(db, vault));
    expect(result?.mailbox).toBe("INBOX");
  });

  test("uses configured mailbox when apple.mailbox is set", async () => {
    const db = createMemoryIndexDb();
    const vault = createStubVault({
      "apple.icloud_email": "user@icloud.com",
      "apple.icloud_app_password": "xxxx-yyyy-zzzz-aaaa",
      "apple.mailbox": "Archive",
    });
    const result = await loadMailConfig(syncTestContext(db, vault));
    expect(result?.mailbox).toBe("Archive");
  });
});

// ─── createAppleSyncable ───────────────────────────────────────────────────────

describe("createAppleSyncable", () => {
  test("serviceId is 'apple'", () => {
    const syncable = createAppleSyncable({
      ensureAppleMcpRunning: async () => {},
      fetchMessages: fakeFetcher([]),
    });
    expect(syncable.serviceId).toBe("apple");
  });

  test("noop when vault creds are absent (no rows upserted, null cursor)", async () => {
    const db = createMemoryIndexDb();
    const syncable = createAppleSyncable({
      ensureAppleMcpRunning: async () => {},
      fetchMessages: fakeFetcher([makeMessage()]),
    });
    const r = await syncable.sync(syncTestContext(db, emptyVault()), null);
    expectSyncNoopResult(r);
    expectServiceItemCount(db, "apple", 0);
  });

  test("upserts two apple:email rows on happy path", async () => {
    const db = createMemoryIndexDb();
    const messages = [
      makeMessage({ uid: 1, messageId: "<m1@icloud.com>", subject: "First" }),
      makeMessage({ uid: 2, messageId: "<m2@icloud.com>", subject: "Second" }),
    ];
    const syncable = createAppleSyncable({
      ensureAppleMcpRunning: async () => {},
      fetchMessages: fakeFetcher(messages),
    });
    const r = await syncable.sync(syncTestContext(db, credsVault()), null);
    expect(r.itemsUpserted).toBe(2);
    expectServiceItemCount(db, "apple", 2);
  });

  test("external_id is the RFC message-id when present", async () => {
    const db = createMemoryIndexDb();
    const syncable = createAppleSyncable({
      ensureAppleMcpRunning: async () => {},
      fetchMessages: fakeFetcher([makeMessage({ messageId: "<unique@icloud.com>" })]),
    });
    await syncable.sync(syncTestContext(db, credsVault()), null);
    const row = db.prepare("SELECT external_id FROM item WHERE service = 'apple' LIMIT 1").get() as
      | { external_id: string }
      | undefined;
    expect(row?.external_id).toBe("<unique@icloud.com>");
  });

  test("external_id falls back to mailbox:uidValidity:uid when messageId absent", async () => {
    const db = createMemoryIndexDb();
    const syncable = createAppleSyncable({
      ensureAppleMcpRunning: async () => {},
      fetchMessages: fakeFetcher([
        makeMessage({ uid: 42, mailbox: "INBOX", uidValidity: "77", messageId: null }),
      ]),
    });
    await syncable.sync(syncTestContext(db, credsVault()), null);
    const row = db.prepare("SELECT external_id FROM item WHERE service = 'apple' LIMIT 1").get() as
      | { external_id: string }
      | undefined;
    expect(row?.external_id).toBe("INBOX:77:42");
  });

  test("body_preview is capped at 2000 chars", async () => {
    const db = createMemoryIndexDb();
    const longPreview = "A".repeat(5000);
    const syncable = createAppleSyncable({
      ensureAppleMcpRunning: async () => {},
      fetchMessages: fakeFetcher([makeMessage({ preview: longPreview })]),
    });
    await syncable.sync(syncTestContext(db, credsVault()), null);
    const row = db.prepare("SELECT body_preview FROM item WHERE service = 'apple' LIMIT 1").get() as
      | { body_preview: string }
      | undefined;
    expect((row?.body_preview ?? "").length).toBeLessThanOrEqual(2000);
  });

  test("service column is 'apple' for all upserted rows", async () => {
    const db = createMemoryIndexDb();
    const syncable = createAppleSyncable({
      ensureAppleMcpRunning: async () => {},
      fetchMessages: fakeFetcher([makeMessage()]),
    });
    await syncable.sync(syncTestContext(db, credsVault()), null);
    const rows = db.prepare("SELECT service FROM item WHERE service = 'apple'").all() as {
      service: string;
    }[];
    expect(rows.length).toBe(1);
    expect(rows[0]?.service).toBe("apple");
  });

  test("returns a cursor string on success", async () => {
    const db = createMemoryIndexDb();
    const syncable = createAppleSyncable({
      ensureAppleMcpRunning: async () => {},
      fetchMessages: fakeFetcher([]),
    });
    const r = await syncable.sync(syncTestContext(db, credsVault()), null);
    expect(typeof r.cursor).toBe("string");
    expect(r.cursor).toContain("nimbus-apple1:");
  });

  test("fetch error returns a transient result (preserves cursor, 0 upserts)", async () => {
    const db = createMemoryIndexDb();
    const syncable = createAppleSyncable({
      ensureAppleMcpRunning: async () => {},
      fetchMessages: errorFetcher(),
    });
    const r = await syncable.sync(syncTestContext(db, credsVault()), "existing-cursor");
    expect(r.itemsUpserted).toBe(0);
    // On {ok:false} with an existing cursor, the cursor is preserved.
    expect(r.cursor).toBe("existing-cursor");
    expectServiceItemCount(db, "apple", 0);
  });

  test("skips messages that map to null (no messageId and invalid uid)", async () => {
    const db = createMemoryIndexDb();
    // uid=0 is invalid (<=0); messageId is null → mapImapLikeMessageToItem returns null
    const syncable = createAppleSyncable({
      ensureAppleMcpRunning: async () => {},
      fetchMessages: fakeFetcher([makeMessage({ uid: 0, messageId: null })]),
    });
    const r = await syncable.sync(syncTestContext(db, credsVault()), null);
    expect(r.itemsUpserted).toBe(0);
    expectServiceItemCount(db, "apple", 0);
  });

  test("ensureAppleMcpRunning is called before fetch", async () => {
    const db = createMemoryIndexDb();
    const calls: string[] = [];
    const syncable = createAppleSyncable({
      ensureAppleMcpRunning: async () => {
        calls.push("ensure");
      },
      fetchMessages: async (config, limit) => {
        calls.push("fetch");
        return fakeFetcher([])(config, limit);
      },
    });
    await syncable.sync(syncTestContext(db, credsVault()), null);
    expect(calls[0]).toBe("ensure");
    expect(calls[1]).toBe("fetch");
  });
});
