import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ChatPlatform } from "../chatops/types.ts";
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

    const rows = listEgress(db, { limit: 10 });
    expect(rows.map((r) => r.method)).toEqual([
      "chatops.reply",
      "chatops.approvalCard",
      "chatops.agentBrief",
    ]);
    expect(rows.every((r) => r.sourceType === "chatops")).toBe(true);
    expect(rows.map((r) => r.destination)).toEqual(["slack", "slack", "teams"]);
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
    expect(s.calls.length).toBe(0);
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
