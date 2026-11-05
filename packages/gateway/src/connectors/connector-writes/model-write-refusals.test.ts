import { describe, expect, test } from "bun:test";

import type { ChatopsChannelBinding, ChatopsPolicy } from "../../policy/types.ts";
import {
  CHATOPS_CHANNEL_REFUSAL,
  KNOWLEDGE_BASE_REFUSAL,
  modelWriteRefusal,
  type TribalKbConfig,
} from "./model-write-refusals.ts";

function chatops(channels: Record<string, readonly string[]>): ChatopsPolicy {
  const map = new Map<string, ChatopsChannelBinding>();
  for (const [id, notify] of Object.entries(channels)) {
    map.set(id, { namespace: "ns", unmapped: "refuse", notify });
  }
  return { channels: map, ownership: new Map() };
}

const NONE = chatops({});
const SLACK_ONLY = chatops({ C0123ABCD: [] });
const TEAMS_CHANNEL = "19:abcDEF123@thread.tacv2";
const TEAMS_ONLY = chatops({ [`${TEAMS_CHANNEL};messageid=1700000000000`]: [] });

const slack = (channel: unknown, policy: ChatopsPolicy | undefined = SLACK_ONLY) =>
  modelWriteRefusal(
    "slack_message_post",
    { channel, text: "hi" },
    { chatops: policy, kb: undefined },
  );
const teamsChannel = (channelId: unknown, policy: ChatopsPolicy | undefined = TEAMS_ONLY) =>
  modelWriteRefusal(
    "teams_message_post",
    { teamId: "t", channelId, body: "hi" },
    { chatops: policy, kb: undefined },
  );
const teamsChat = (chatId: unknown, policy: ChatopsPolicy | undefined = TEAMS_ONLY) =>
  modelWriteRefusal(
    "teams_message_post_chat",
    { chatId, body: "hi" },
    { chatops: policy, kb: undefined },
  );

describe("F3: a Slack DM to the ChatOps bot", () => {
  const dm = (user_ids: unknown, policy: ChatopsPolicy | undefined) =>
    modelWriteRefusal(
      "slack_message_post_dm",
      { user_ids, text: "hi" },
      { chatops: policy, kb: undefined },
    );

  test("no Slack ChatOps entry: a DM is allowed (positive control), Teams-only included", () => {
    expect(dm("U0123ABCD", NONE)).toBeUndefined();
    expect(dm("U0123ABCD,U0999ZZZZ", TEAMS_ONLY)).toBeUndefined();
  });

  test("Slack ChatOps configured: the bot's user id is not knowable offline, so EVERY DM is refused", () => {
    for (const ids of ["U0123ABCD", " u0123abcd , U0999ZZZZ ", "", 7, undefined]) {
      expect(dm(ids, SLACK_ONLY), String(ids)).toBe(CHATOPS_CHANNEL_REFUSAL);
    }
    // An entry whose platform its shape cannot tell counts as possibly Slack.
    expect(dm("U0123ABCD", chatops({ general: [] }))).toBe(CHATOPS_CHANNEL_REFUSAL);
  });

  test("an unreadable policy refuses a DM", () => {
    expect(dm("U0123ABCD", undefined)).toBe(CHATOPS_CHANNEL_REFUSAL);
  });
});

describe("F3: a Teams 1:1 chat with the ChatOps bot", () => {
  test("a bound personal (a:) conversation refuses every Teams chat post, even a different-looking one", () => {
    const personal = chatops({ "a:1botPERSONALconv": [] });
    expect(teamsChat("19:abc_def@unq.gbl.spaces", personal)).toBe(CHATOPS_CHANNEL_REFUSAL);
    expect(teamsChat("19:x@thread.v2", personal)).toBe(CHATOPS_CHANNEL_REFUSAL);
  });

  test("an unbound 1:1 chat is not a ChatOps destination (ChatOps stays silent on unbound conversations)", () => {
    expect(teamsChat("19:abc_def@unq.gbl.spaces", TEAMS_ONLY)).toBeUndefined();
  });
});

describe("F3: ChatOps channels", () => {
  test("the configured Slack channel is refused however it is spelled", () => {
    for (const c of ["C0123ABCD", " c0123abcd ", "#C0123ABCD", "%23C0123ABCD", "C0123%41BCD"]) {
      expect(slack(c), c).toBe(CHATOPS_CHANNEL_REFUSAL);
    }
  });

  test("a different Slack channel ID is allowed (positive control), and no ChatOps allows anything", () => {
    expect(slack("C9999ZZZZ")).toBeUndefined();
    expect(slack("#general", NONE)).toBeUndefined();
    expect(slack("C0123ABCD", NONE)).toBeUndefined();
  });

  test("a Slack channel NAME cannot be mapped to an id without the network: refused", () => {
    for (const c of ["#general", "general", "#General", "random"]) {
      expect(slack(c), c).toBe(CHATOPS_CHANNEL_REFUSAL);
    }
  });

  test("a configured channel NAME matches its spellings, and then no id can be proven distinct", () => {
    const byName = chatops({ general: [] });
    expect(slack("#General", byName)).toBe(CHATOPS_CHANNEL_REFUSAL);
    expect(slack(" GENERAL ", byName)).toBe(CHATOPS_CHANNEL_REFUSAL);
    expect(slack("C9999ZZZZ", byName)).toBe(CHATOPS_CHANNEL_REFUSAL);
  });

  test("a notify channel counts as a ChatOps channel", () => {
    const notify = chatops({ C0123ABCD: ["C0NOTIFY01"] });
    expect(slack("c0notify01", notify)).toBe(CHATOPS_CHANNEL_REFUSAL);
    expect(slack("C9999ZZZZ", notify)).toBeUndefined();
  });

  test("a missing, non-string, empty or undecodable destination is refused when Slack ChatOps is configured", () => {
    for (const c of [undefined, 7, "", "  ", "%E0%A4%A"]) {
      expect(slack(c), String(c)).toBe(CHATOPS_CHANNEL_REFUSAL);
    }
  });

  test("an unreadable policy refuses every ChatOps-platform post", () => {
    expect(
      modelWriteRefusal(
        "slack_message_post",
        { channel: "C9999ZZZZ" },
        { chatops: undefined, kb: undefined },
      ),
    ).toBe(CHATOPS_CHANNEL_REFUSAL);
  });

  test("Teams: the bound conversation is refused as a Graph channel id, percent-encoded or not", () => {
    expect(teamsChannel(TEAMS_CHANNEL)).toBe(CHATOPS_CHANNEL_REFUSAL);
    expect(teamsChannel(encodeURIComponent(TEAMS_CHANNEL))).toBe(CHATOPS_CHANNEL_REFUSAL);
    expect(teamsChannel(TEAMS_CHANNEL.toLowerCase())).toBe(CHATOPS_CHANNEL_REFUSAL);
    expect(teamsChat(TEAMS_CHANNEL)).toBe(CHATOPS_CHANNEL_REFUSAL);
  });

  test("Teams: another thread id is allowed (positive control); a non-id destination is refused", () => {
    expect(teamsChannel("19:other@thread.tacv2")).toBeUndefined();
    expect(teamsChat("19:meeting_x@thread.v2")).toBeUndefined();
    expect(teamsChannel("General")).toBe(CHATOPS_CHANNEL_REFUSAL);
  });

  test("platforms are kept apart: Slack-only ChatOps does not block Teams, nor Teams-only Slack", () => {
    expect(teamsChannel("19:other@thread.tacv2", SLACK_ONLY)).toBeUndefined();
    expect(slack("#general", TEAMS_ONLY)).toBeUndefined();
  });

  test("a personal Teams conversation (no Graph spelling) refuses every Teams post", () => {
    const personal = chatops({ "a:1xyzPERSONAL": [] });
    expect(teamsChat("19:other@thread.v2", personal)).toBe(CHATOPS_CHANNEL_REFUSAL);
    expect(slack("C9999ZZZZ", personal)).toBeUndefined();
  });

  test("rows that are not ChatOps-platform posts are not checked against ChatOps", () => {
    expect(
      modelWriteRefusal(
        "github_issue_create",
        { channel: "C0123ABCD" },
        { chatops: SLACK_ONLY, kb: undefined },
      ),
    ).toBeUndefined();
  });
});

const KB: TribalKbConfig = {
  notion: { databaseId: "1A2B3C4D-5E6F-7a8b-9c0d-112233445566" },
  confluence: { spaceKey: "KB", parentPageId: "98765" },
};
const kb = (
  toolId: string,
  input: Record<string, unknown>,
  config: TribalKbConfig | undefined = KB,
) => modelWriteRefusal(toolId, input, { chatops: NONE, kb: config });
const NOTION_ID_CANONICAL = "1a2b3c4d5e6f7a8b9c0d112233445566";

describe("F4: the knowledge base", () => {
  test("every Notion KB-capable key naming the KB database is refused, in any spelling", () => {
    expect(kb("notion_page_create", { parentPageId: NOTION_ID_CANONICAL })).toBe(
      KNOWLEDGE_BASE_REFUSAL,
    );
    expect(kb("notion_page_update", { pageId: "1a2b3c4d-5e6f-7a8b-9c0d-112233445566" })).toBe(
      KNOWLEDGE_BASE_REFUSAL,
    );
    expect(kb("notion_block_append", { parentBlockId: NOTION_ID_CANONICAL.toUpperCase() })).toBe(
      KNOWLEDGE_BASE_REFUSAL,
    );
    expect(
      kb("notion_comment_create", { pageId: `https://www.notion.so/KB-${NOTION_ID_CANONICAL}` }),
    ).toBe(KNOWLEDGE_BASE_REFUSAL);
  });

  test("a Notion write elsewhere is allowed (positive control), and a non-string target is refused", () => {
    expect(
      kb("notion_page_create", { parentPageId: "ffffffffffffffffffffffffffffffff" }),
    ).toBeUndefined();
    expect(kb("notion_block_append", { parentBlockId: "ffff" })).toBeUndefined();
    expect(kb("notion_block_append", { parentBlockId: 7 })).toBe(KNOWLEDGE_BASE_REFUSAL);
  });

  test("Confluence: a page create in the KB space under the KB parent is refused; elsewhere allowed", () => {
    expect(
      kb("confluence_page_create", {
        spaceKey: "kb",
        title: "t",
        storageHtml: "x",
        parentPageId: "98765",
      }),
    ).toBe(KNOWLEDGE_BASE_REFUSAL);
    expect(
      kb("confluence_page_create", {
        spaceKey: "KB",
        title: "t",
        storageHtml: "x",
        parentPageId: "11111",
      }),
    ).toBeUndefined();
    expect(
      kb("confluence_page_create", { spaceKey: "ENG", title: "t", storageHtml: "x" }),
    ).toBeUndefined();
  });

  test("Confluence: overwriting or commenting on the KB parent page is refused", () => {
    expect(
      kb("confluence_page_update", {
        pageId: " 98765 ",
        versionNumber: 2,
        title: "t",
        storageHtml: "x",
      }),
    ).toBe(KNOWLEDGE_BASE_REFUSAL);
    expect(kb("confluence_comment_add", { pageId: "98765", storageHtml: "x" })).toBe(
      KNOWLEDGE_BASE_REFUSAL,
    );
    expect(kb("confluence_comment_add", { pageId: "12345", storageHtml: "x" })).toBeUndefined();
  });

  test("no KB configured: nothing is refused for it", () => {
    expect(
      modelWriteRefusal(
        "notion_page_create",
        { parentPageId: NOTION_ID_CANONICAL },
        { chatops: NONE, kb: undefined },
      ),
    ).toBeUndefined();
    expect(kb("confluence_comment_add", { pageId: "98765" }, {})).toBeUndefined();
  });
});
