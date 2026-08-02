import { describe, expect, mock, test } from "bun:test";

// Must be registered before `./slack-sync.ts` is imported (mirrors the pattern in
// test/unit/connectors/slack-sync.test.ts) so the module-level import inside
// slack-sync.ts resolves to this stub instead of hitting the real OAuth refresh flow.
mock.module("../auth/slack-access-token.ts", () => ({
  getValidSlackAccessToken: async (): Promise<string> => "slack-stub-token",
}));

import { createConnectorSyncFixture } from "../../test/helpers/connector-sync-harness.ts";
import { createOAuthConnectorTestSetup, requestUrlString } from "../testing/bun-test-support.ts";
import {
  createMemoryIndexDb,
  createStubVault,
  syncTestContext,
  urlFromFetchInput,
} from "./connector-sync-test-helpers.ts";
import { createDiscordSyncable } from "./discord-sync.ts";
import { createSlackSyncable } from "./slack-sync.ts";
import { createTeamsSyncable } from "./teams-sync.ts";

/**
 * The hazard under test: all three chat connectors derive a short item TITLE
 * from what used to be the *only* text they kept (a 512-char preview). Now that
 * `upsertIndexedItemForSync` also accepts a declared-full `body`, it would be an
 * easy mistake to widen the same local variable that feeds the title deriver,
 * so the title deriver (and, for Discord, a whitespace-collapsing regex) runs
 * over the whole prose-cap-sized body instead of a short slice.
 *
 * For Slack and Discord — which pass the raw message text straight through with
 * no pre-processing — this is caught with an adversarial fixture: the message
 * text is 512+ characters of pure whitespace followed by real content. The
 * *preview* (first 512 chars) trims to empty, so the title deriver must fall
 * back to its "no text" placeholder. A regression that fed the FULL text to the
 * title deriver instead would find the real content past position 512 and
 * produce a completely different (non-fallback) title, so this assertion is a
 * real correctness discriminator, not just a length check.
 *
 * Teams' body goes through `plainTextPreviewFromHtml`, which collapses
 * whitespace and trims over the *entire* input before any slicing happens, so
 * a "long whitespace prefix" fixture can't exist there (any real content
 * anywhere in the message is pulled forward by the collapse). Its assertion
 * instead pins the title to the exact value the short-preview algorithm
 * produces, so any change to what feeds the title deriver would still be
 * caught by the fixed expected string.
 */
describe("chat connectors — full body storage keeps title short (task 9)", () => {
  const ENSURE_SLACK_MCP = { ensureSlackMcpRunning: async (): Promise<void> => {} };
  const ENSURE_DISCORD_MCP = { ensureDiscordMcpRunning: async (): Promise<void> => {} };
  const ENSURE_TEAMS_MCP = { ensureMicrosoftMcpRunning: async (): Promise<void> => {} };

  const WHITESPACE_HAZARD_TEXT = " ".repeat(600) + "y".repeat(3400); // 4000 chars total

  test("slack: full 4000-char message body is stored complete; title stays the short fallback", async () => {
    const fixture = createConnectorSyncFixture();
    fixture.fetchMock.install();
    try {
      await fixture.vault.set("slack.oauth", "slack-stub-oauth-blob");

      const cursorPayload = {
        phase: "history",
        floorTs: "1700000000.000000",
        ids: ["C1"],
        nextIdx: 0,
        hw: {},
        listCursor: null,
        histCursor: null,
        teamSubdomain: null,
      };
      const cursor = `nimbus-slk1:${Buffer.from(JSON.stringify(cursorPayload), "utf8").toString("base64url")}`;

      fixture.fetchMock.respond("POST", "https://slack.com/api/auth.test", { ok: false });
      fixture.fetchMock.respond("POST", "https://slack.com/api/conversations.history", {
        ok: true,
        messages: [{ ts: "1700000001.000100", text: WHITESPACE_HAZARD_TEXT, user: "U1" }],
        response_metadata: { next_cursor: "" },
      });

      const res = await createSlackSyncable(ENSURE_SLACK_MCP).sync(
        fixture.createSyncContext(),
        cursor,
      );
      expect(res.itemsUpserted).toBe(1);

      const row = fixture.db
        .query(
          "SELECT title, body, body_complete FROM item WHERE service = 'slack' AND external_id = ?",
        )
        .get("C1:1700000001.000100") as
        | { title: string; body: string; body_complete: number }
        | undefined;
      expect(row).toBeDefined();
      expect(row?.body).toHaveLength(4000);
      expect(row?.body).toBe(WHITESPACE_HAZARD_TEXT);
      expect(row?.body_complete).toBe(1);
      // The preview (first 512 chars) is pure whitespace, so the title deriver
      // must fall back to "(no text)" — a regression feeding the full 4000-char
      // text into the deriver would instead surface the "y" content past 512.
      expect(row?.title).toBe("(no text)");
      expect(row?.title.length).toBeLessThanOrEqual(120);
    } finally {
      fixture.cleanup();
    }
  });

  test("discord: full 4000-char message body is stored complete; title stays the short fallback", async () => {
    const db = createMemoryIndexDb();
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
        const u = urlFromFetchInput(input);
        if (u.includes("/users/@me/guilds")) {
          return new Response(JSON.stringify([{ id: "g1" }]), { status: 200 });
        }
        if (/\/guilds\/[^/]+\/channels/.test(u)) {
          return new Response(JSON.stringify([{ id: "c1", type: 0 }]), { status: 200 });
        }
        if (/\/channels\/[^/]+\/messages/.test(u)) {
          return new Response(
            JSON.stringify([
              {
                id: "m1",
                content: WHITESPACE_HAZARD_TEXT,
                author: { id: "u1" }, // no global_name/username -> displayName falls back to "unknown"
              },
            ]),
            { status: 200 },
          );
        }
        return new Response("[]", { status: 200 });
      }) as typeof fetch;

      const sync = createDiscordSyncable(ENSURE_DISCORD_MCP);
      const vault = createStubVault({ "discord.enabled": "1", "discord.bot_token": "bot-tok" });
      const res = await sync.sync(syncTestContext(db, vault), null);
      // Discord's single sync() tick can re-poll the same channel more than once
      // (see discord-sync.test.ts's own "full flow" test, which asserts
      // `toBeGreaterThanOrEqual`, not an exact count) — every re-poll re-upserts
      // the same externalId, so the row count below stays 1 regardless.
      expect(res.itemsUpserted).toBeGreaterThanOrEqual(1);

      const row = db
        .query(
          "SELECT title, body, body_complete FROM item WHERE service = 'discord' AND external_id = ?",
        )
        .get("c1:m1") as { title: string; body: string; body_complete: number } | undefined;
      expect(row).toBeDefined();
      expect(row?.body).toHaveLength(4000);
      expect(row?.body).toBe(WHITESPACE_HAZARD_TEXT);
      expect(row?.body_complete).toBe(1);
      // The preview (first 512 chars) is pure whitespace, so the title deriver
      // must fall back to the author's display name ("unknown" here) — a
      // regression running the whitespace-collapse regex over the full 4000
      // chars would instead surface the "y" content past 512.
      expect(row?.title).toBe("unknown");
      expect(row?.title.length).toBeLessThanOrEqual(120);
    } finally {
      globalThis.fetch = originalFetch;
      db.close();
    }
  });

  test("teams: full 4000-char message body is stored complete; title stays the short preview-derived value", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("microsoft");
    const originalFetch = globalThis.fetch;
    try {
      const teamsContent = "y".repeat(4000); // no whitespace/HTML: survives plainTextPreviewFromHtml unchanged
      const syncable = createTeamsSyncable(ENSURE_TEAMS_MCP);

      globalThis.fetch = (async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
        const url = requestUrlString(input);
        if (url.includes("/joinedTeams")) {
          return new Response(JSON.stringify({ value: [{ id: "team-1", displayName: "T" }] }), {
            status: 200,
          });
        }
        if (url.includes("/teams/team-1/channels") && !url.includes("/messages")) {
          return new Response(
            JSON.stringify({ value: [{ id: "chan-1", membershipType: "standard" }] }),
            { status: 200 },
          );
        }
        if (url.includes("/messages/delta")) {
          return new Response(
            JSON.stringify({
              value: [
                {
                  id: "msg-1",
                  createdDateTime: "2024-05-01T10:00:00Z",
                  body: { contentType: "text", content: teamsContent },
                  from: { user: { id: "ms-user-1", displayName: "Pat" } },
                },
              ],
              "@odata.deltaLink":
                "https://graph.microsoft.com/v1.0/teams/x/channels/y/messages/delta?token=z",
            }),
            { status: 200 },
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      }) as typeof fetch;

      const r1 = await syncable.sync(ctx, null); // teams phase
      expect(r1.hasMore).toBe(true);
      const r2 = await syncable.sync(ctx, r1.cursor); // channels phase
      expect(r2.hasMore).toBe(true);
      const r3 = await syncable.sync(ctx, r2.cursor); // channels -> messages transition
      expect(r3.hasMore).toBe(true);
      const r4 = await syncable.sync(ctx, r3.cursor); // messages phase
      expect(r4.itemsUpserted).toBe(1);
      expect(r4.hasMore).toBe(false);

      const row = db
        .query("SELECT title, body, body_complete FROM item WHERE service = 'teams' LIMIT 1")
        .get() as { title: string; body: string; body_complete: number } | undefined;
      expect(row).toBeDefined();
      expect(row?.body).toHaveLength(4000);
      expect(row?.body).toBe(teamsContent);
      expect(row?.body_complete).toBe(1);
      // Pinned to exactly what the short-preview title algorithm produces for
      // the first 512 chars of "y" — the same value the pre-full-body code
      // produced, proving the title deriver still only ever sees a preview.
      expect(row?.title).toBe(`${"y".repeat(117)}…`);
      expect(row?.title.length).toBeLessThanOrEqual(120);
    } finally {
      globalThis.fetch = originalFetch;
      db.close();
    }
  });
});
