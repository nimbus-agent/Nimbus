import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createWatcherChatNotifier } from "../automation/watcher-chat-notifier.ts";
import type { ChatPlatform } from "../chatops/types.ts";
import { DEFAULT_WATCHER_CHATOPS_CONFIG } from "../config/watcher-chatops-toml.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { buildLedgeredChatPosts } from "./chatops-egress.ts";
import { listEgress } from "./egress-verify.ts";
import { EgressAppendFailedError } from "./model-egress.ts";

const SALT = Buffer.alloc(32, 7).toString("base64");

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
});
afterEach(() => {
  db.close();
});

function spy(): { calls: Array<[ChatPlatform, string, string]>; fn: typeof post } {
  const calls: Array<[ChatPlatform, string, string]> = [];
  const post = async (p: ChatPlatform, c: string, t: string): Promise<void> => {
    calls.push([p, c, t]);
  };
  return { calls, fn: post };
}

describe("chatops egress appender", () => {
  test("appends one row per post, with the kind's own method", async () => {
    const s = spy();
    const posts = buildLedgeredChatPosts(db, s.fn, SALT);
    await posts.reply("slack", "C123", "hello");
    await posts.approvalCard("slack", "C123", "approve?");
    await posts.agentBrief("teams", "19:abc", "## Gaps");
    await posts.pushedBrief("slack", "C123", "P1 · svc — t");
    await posts.watcherNotice("slack", "C123", "Nimbus watcher notice");

    const rows = listEgress(db, { limit: 10 });
    expect(rows.map((r) => r.method)).toEqual([
      "chatops.reply",
      "chatops.approvalCard",
      "chatops.agentBrief",
      "chatops.pushedBrief",
      "chatops.watcherNotice",
    ]);
    expect(rows.every((r) => r.sourceType === "chatops")).toBe(true);
    expect(rows.map((r) => r.destination)).toEqual(["slack", "slack", "teams", "slack", "slack"]);
  });

  test("pushedBrief stores the byte count, never the headline text", async () => {
    const s = spy();
    await buildLedgeredChatPosts(db, s.fn, SALT).pushedBrief("slack", "C1", "SECRET-HEADLINE-TEXT");
    const rows = listEgress(db, { limit: 10 });
    expect(rows.map((r) => r.method)).toEqual(["chatops.pushedBrief"]);
    expect(JSON.stringify(rows)).not.toContain("SECRET-HEADLINE-TEXT");
    expect(rows[0]?.payloadSummary).toContain(
      `"bytes":${Buffer.byteLength("SECRET-HEADLINE-TEXT", "utf8")}`,
    );
    expect(s.calls).toHaveLength(1);
  });

  test("I29: a watcher notice appends one chatops.watcherNotice row BEFORE the post, bytes only", async () => {
    const seen: string[] = [];
    const raw = async (_p: ChatPlatform, _c: string, _t: string): Promise<void> => {
      seen.push(`rows-at-post-time:${listEgress(db, { limit: 10 }).length}`);
    };
    const text = "Nimbus watcher SECRET-NOTICE-TEXT";
    await buildLedgeredChatPosts(db, raw, SALT).watcherNotice("slack", "C01ABC2DEF3", text);
    expect(seen).toEqual(["rows-at-post-time:1"]);
    const rows = listEgress(db, { limit: 10 });
    expect(rows.map((r) => r.method)).toEqual(["chatops.watcherNotice"]);
    expect(rows[0]?.sourceId).toMatch(/^[0-9a-f]{64}$/);
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain("C01ABC2DEF3");
    expect(dump).not.toContain("SECRET-NOTICE-TEXT");
    expect(rows[0]?.payloadSummary).toContain(`"bytes":${Buffer.byteLength(text, "utf8")}`);
  });

  test("I29: a failed append on a watcher notice posts nothing and the notifier contains it", async () => {
    const s = spy();
    const posts = buildLedgeredChatPosts(db, s.fn, SALT);
    db.close();
    const failures: unknown[] = [];
    const notifier = createWatcherChatNotifier({
      config: {
        ...DEFAULT_WATCHER_CHATOPS_CONFIG,
        enabled: true,
        namespace: "ns",
        watchers: ["*"],
      },
      demo: false,
      now: () => 1_000,
      onFailure: (e) => failures.push(e),
      warn: () => {},
    });
    notifier?.settle(async (text) => {
      await posts.watcherNotice("slack", "C1", text);
      return 1;
    });
    notifier?.notify({
      watcherId: "w1",
      name: "n",
      conditionType: "alert_fired",
      matchCount: 1,
      capped: false,
      firedAt: 1,
    });
    await notifier?.whenIdle();
    expect(s.calls).toHaveLength(0);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toBeInstanceOf(EgressAppendFailedError);
    db = new Database(":memory:");
  });

  test("Slack-bound text is escaped BEFORE the append, so the ledger counts the bytes that leave", async () => {
    const s = spy();
    const posts = buildLedgeredChatPosts(db, s.fn, SALT);
    await posts.agentBrief("slack", "C1", "brief <!channel> & more");
    const wire = "brief &lt;!channel&gt; &amp; more";
    expect(s.calls).toEqual([["slack", "C1", wire]]);
    expect(listEgress(db, { limit: 1 })[0]?.payloadSummary).toContain(
      `"bytes":${Buffer.byteLength(wire, "utf8")}`,
    );
  });

  test("Teams-bound text is posted unchanged", async () => {
    const s = spy();
    await buildLedgeredChatPosts(db, s.fn, SALT).reply("teams", "19:abc", "a <b> & c");
    expect(s.calls).toEqual([["teams", "19:abc", "a <b> & c"]]);
  });

  test("the channel id is never stored in cleartext", async () => {
    const s = spy();
    await buildLedgeredChatPosts(db, s.fn, SALT).reply("slack", "C01ABC2DEF3", "hi");
    const raw = JSON.stringify(listEgress(db, { limit: 10 }));
    expect(raw).not.toContain("C01ABC2DEF3");
    expect(listEgress(db, { limit: 1 })[0]?.sourceId).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the message text is never stored", async () => {
    const s = spy();
    await buildLedgeredChatPosts(db, s.fn, SALT).reply("slack", "C1", "SECRET-BODY-TEXT");
    expect(JSON.stringify(listEgress(db, { limit: 10 }))).not.toContain("SECRET-BODY-TEXT");
  });

  test("a failed append POSTS NOTHING — assert the call count, not just the throw", async () => {
    const s = spy();
    const posts = buildLedgeredChatPosts(db, s.fn, SALT);
    db.close(); // make the append fail
    await expect(posts.reply("slack", "C1", "hi")).rejects.toBeInstanceOf(EgressAppendFailedError);
    // The whole point of fail-closed: proving it threw is not proving nothing left.
    expect(s.calls).toHaveLength(0);
    db = new Database(":memory:"); // so afterEach's close() is valid
  });

  test("the row is appended BEFORE the post, not after", async () => {
    const seen: string[] = [];
    const raw = async (): Promise<void> => {
      seen.push(`rows-at-post-time:${listEgress(db, { limit: 10 }).length}`);
    };
    await buildLedgeredChatPosts(db, raw, SALT).reply("slack", "C1", "hi");
    expect(seen).toEqual(["rows-at-post-time:1"]);
  });
});
