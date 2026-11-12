/**
 * The MB4 seam end to end: the briefing's chat section renders REAL unread Slack threads (rows the real Slack
 * syncable wrote, a read marker the real store wrote) through `readUnreadChatThreads`, the same function
 * `platform/assemble.ts` wires as `readUnreadChat`.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { StubFetch } from "../../test/helpers/stub-fetch.ts";
import { buildMorningBriefing } from "../agents/_lib/briefing-build.ts";
import { renderBriefing } from "../agents/_lib/briefing-render.ts";
import {
  createMemoryIndexDb,
  createStubVault,
  syncTestContext,
} from "../connectors/connector-sync-test-helpers.ts";
import { encodeSlackCursor } from "../connectors/slack-cursor.ts";
import { createSlackSyncable } from "../connectors/slack-sync.ts";
import { setChatReadMarkerRows } from "../index/chat-read-marker-store.ts";
import { readUnreadChatThreads } from "../index/chat-unread-query.ts";
import { setSchedulerCursor, upsertSchedulerRegistration } from "../sync/scheduler-store.ts";
import { markSynced } from "../testing/briefing-fixtures.ts";

const NOW = 1_700_001_000_000;

let db: Database;
let stub: StubFetch;
beforeEach(() => {
  db = createMemoryIndexDb();
  stub = new StubFetch();
});
afterEach(() => {
  stub.restore();
  db.close();
});

function cursor(selfUserId: string | null): string {
  return encodeSlackCursor({
    phase: "history",
    floorTs: "1700000000.000000",
    ids: ["C1", "ZZZZ"],
    nextIdx: 0,
    hw: {},
    listCursor: null,
    histCursor: null,
    teamSubdomain: "acme",
    selfUserId,
    mkIdx: 0,
    listPartial: false,
  });
}

async function indexUnread(): Promise<void> {
  stub.install();
  stub.respond("POST", "https://slack.com/api/conversations.history", {
    ok: true,
    messages: [{ ts: "1700000300.000000", user: "U2", text: "deploy is blocked" }],
    response_metadata: {},
  });
  const ctx = {
    ...syncTestContext(db, createStubVault({ "slack.oauth": "blob" }), "slack"),
    accessToken: () => Promise.resolve("xoxp-test"),
  };
  await createSlackSyncable({ ensureSlackMcpRunning: async () => {} }).sync(ctx, cursor(null));
  stub.restore();
}

describe("chat section through readUnreadChatThreads", () => {
  test("renders the real unread thread and the marker-age line", async () => {
    await indexUnread();
    setChatReadMarkerRows(
      db,
      "slack",
      [{ channelId: "C1", channelKind: "public_channel", lastReadTs: "1700000200.000000" }],
      undefined,
      NOW - 120_000,
    );
    upsertSchedulerRegistration(db, "slack", 300_000, 1, false);
    setSchedulerCursor(db, "slack", cursor("UME"));
    markSynced(db, "slack", NOW - 60_000);
    const brief = buildMorningBriefing({
      db,
      nowMs: NOW,
      tz: "UTC",
      gatewayZone: "UTC",
      sections: ["chat"],
      selfPersonId: null,
      serviceConfigs: [],
      readUnreadChat: readUnreadChatThreads,
    });
    expect(brief.counts.unreadChat).toBe(1);
    const md = renderBriefing(brief);
    expect(md).toContain("## Chat");
    expect(md).toContain("deploy is blocked");
    expect(md).toContain("2 min to 2 min old");
    expect(brief.gaps.some((g) => g.detail.includes("not available yet"))).toBe(false);
  });

  test("assemble.ts wires exactly this reader as readUnreadChat", () => {
    const src = readFileSync(join(import.meta.dir, "..", "platform", "assemble.ts"), "utf8");
    expect(src).toContain("readUnreadChat: readUnreadChatThreads,");
    expect(src).toMatch(
      /import \{ readUnreadChatThreads \} from "\.\.\/index\/chat-unread-query\.ts";/,
    );
  });
});
