import { describe, expect, test } from "bun:test";

import { serviceOf } from "../../engine/service-of.ts";
import type { ChatopsChannelBinding, ChatopsPolicy } from "../../policy/types.ts";
import { CONNECTOR_WRITE_ROWS } from "./index.ts";
import { isModelOfferableRow } from "./model-offerable.ts";
import {
  BROADCAST_MENTION_REFUSAL,
  CHATOPS_CHANNEL_REFUSAL,
  isChatopsDestinationRow,
  isKnowledgeBaseCapableRow,
  KNOWLEDGE_BASE_REFUSAL,
  messagingDestinationRefusal,
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

  test("Confluence: a non-canonical page id cannot be proven distinct and is refused (positive control: canonical other id)", () => {
    for (const v of ["098765", "0", "", "98765 ", " 98765", "9876x", "https://x/98765"]) {
      expect(kb("confluence_comment_add", { pageId: v }), v).toBe(KNOWLEDGE_BASE_REFUSAL);
    }
    expect(kb("confluence_comment_add", { pageId: "12345" })).toBeUndefined();
    expect(kb("confluence_page_create", { parentPageId: "012345" })).toBe(KNOWLEDGE_BASE_REFUSAL);
  });

  test("an empty configured Notion database id or Confluence parent refuses nothing", () => {
    expect(
      kb("notion_block_append", { parentBlockId: "x" }, { notion: { databaseId: " - " } }),
    ).toBeUndefined();
    expect(
      kb(
        "confluence_comment_add",
        { pageId: "0" },
        { confluence: { spaceKey: "K", parentPageId: " " } },
      ),
    ).toBeUndefined();
  });

  test("a configured ChatOps entry that does not canonicalise is still compared raw", () => {
    const odd = chatops({ "%E0%A4%A": [] });
    expect(slack("%E0%A4%A", odd)).toBe(CHATOPS_CHANNEL_REFUSAL);
    // A shape-unknown entry may belong to any platform: no Slack id can be proven distinct.
    expect(slack("C9999ZZZZ", odd)).toBe(CHATOPS_CHANNEL_REFUSAL);
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

describe("completeness tripwire (plan R6): every offerable messaging/KB row is covered", () => {
  const offerable = CONNECTOR_WRITE_ROWS.filter(isModelOfferableRow);
  const bySvc = (svcs: readonly string[]) =>
    offerable.filter((r) => svcs.includes(serviceOf(r.actionType)));
  const BOTH = chatops({ C0123ABCD: [], "19:abc@thread.tacv2": [] });

  test("every model-offerable Slack/Teams row is a ChatOps destination row", () => {
    const rows = bySvc(["slack", "teams"]);
    expect(rows.map((r) => r.toolId).sort((a, b) => a.localeCompare(b))).toEqual([
      "slack_message_post",
      "slack_message_post_dm",
      "teams_message_post",
      "teams_message_post_chat",
    ]);
    expect(rows.filter((r) => !isChatopsDestinationRow(r.toolId)).map((r) => r.toolId)).toEqual([]);
  });

  test("every model-offerable Notion/Confluence row is knowledge-base capable", () => {
    const rows = bySvc(["notion", "confluence"]);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.filter((r) => !isKnowledgeBaseCapableRow(r.toolId)).map((r) => r.toolId)).toEqual(
      [],
    );
  });

  test("Discord has no ChatOps transport: never a ChatOps destination, never refused by it", () => {
    expect(isChatopsDestinationRow("discord_message_post")).toBe(false);
    expect(
      modelWriteRefusal(
        "discord_message_post",
        { channelId: "123456789012345678", content: "hi @everyone" },
        { chatops: BOTH, kb: KB },
      ),
    ).toBeUndefined();
  });

  test("the GitHub/GitLab/Jira/Linear comment rows are never refused by the ChatOps or KB rule", () => {
    for (const [toolId, input] of [
      ["github_issue_comment_create", { owner: "o", repo: "r", issueNumber: 1, body: "C0123ABCD" }],
      ["gitlab_issue_note_create", { projectPath: "g/r", issueIid: 1, body: "98765" }],
      ["gitlab_mr_note_create", { projectPath: "g/r", mergeRequestIid: 1, body: "x" }],
      ["jira_comment_add", { issueKey: "C0123ABCD", body: NOTION_ID_CANONICAL }],
      ["linear_comment_create", { issueId: NOTION_ID_CANONICAL, body: "98765" }],
    ] as const) {
      expect(isChatopsDestinationRow(toolId), toolId).toBe(false);
      expect(isKnowledgeBaseCapableRow(toolId), toolId).toBe(false);
      expect(modelWriteRefusal(toolId, input, { chatops: BOTH, kb: KB }), toolId).toBeUndefined();
      expect(
        modelWriteRefusal(toolId, input, { chatops: undefined, kb: KB }),
        toolId,
      ).toBeUndefined();
    }
  });
});

describe("Antigravity fix 2: destinations are folded before they are compared", () => {
  const ZWSP = String.fromCodePoint(0x200b);
  const FW_C = String.fromCodePoint(0xff23);

  test("a Teams thread id with U+200B inserted is refused when the clean id is bound", () => {
    expect(teamsChannel(`19:abc${ZWSP}DEF123@thread.tacv2`)).toBe(CHATOPS_CHANNEL_REFUSAL);
    expect(teamsChat(`19${ZWSP}:abcDEF123@thread.tacv2`)).toBe(CHATOPS_CHANNEL_REFUSAL);
    // Percent-encoded invisible characters are folded after the decode too.
    expect(teamsChannel("19:abc%E2%80%8BDEF123@thread.tacv2")).toBe(CHATOPS_CHANNEL_REFUSAL);
    // A fullwidth percent sign folds BEFORE the decode, so the escape it starts decodes too.
    const FW_PERCENT = String.fromCodePoint(0xff05);
    expect(teamsChannel(`19:abcDEF123${FW_PERCENT}40thread.tacv2`)).toBe(CHATOPS_CHANNEL_REFUSAL);
    // Positive control: a genuinely different thread is still allowed.
    expect(teamsChannel(`19:other${ZWSP}@thread.tacv2`)).toBeUndefined();
  });

  test("a Slack id with U+200B inserted, or written fullwidth, is refused when the clean id is bound", () => {
    // (Also refused before fix 2: an unfolded value is not a Slack id, and a non-id destination
    // cannot be proven distinct. Folding makes it compare as the bound id itself.)
    expect(slack(`C0123${ZWSP}ABCD`)).toBe(CHATOPS_CHANNEL_REFUSAL);
    expect(slack(`${FW_C}0123ABCD`)).toBe(CHATOPS_CHANNEL_REFUSAL);
    expect(slack(`C9999${ZWSP}ZZZZ`)).toBeUndefined();
  });
});

describe("modelWriteRefusal = messagingDestinationRefusal, then the KB (OR1/OR2)", () => {
  const POLICY = chatops({ C0123ABCD: [], "19:abc@thread.tacv2": [] });
  const MESSAGING: ReadonlyArray<[string, Record<string, unknown>]> = [
    ["slack_message_post", { channel: "C0123ABCD", text: "hi" }],
    ["slack_message_post", { channel: "C9999ZZZZ", text: "hi <!here>" }],
    ["slack_message_post", { channel: "C9999ZZZZ", text: "hi" }],
    ["slack_message_post_dm", { user_ids: "U1", text: "hi" }],
    ["teams_message_post", { teamId: "t", channelId: "19:x@thread.v2", body: "<at/>" }],
    ["teams_message_post_chat", { chatId: "19:abc@thread.tacv2", body: "hi" }],
    ["github_issue_comment_create", { owner: "o", repo: "r", issueNumber: 1, body: "@o/t" }],
    ["gitlab_issue_note_create", { projectPath: "g/r", issueIid: 1, body: "@alice" }],
    ["gitlab_mr_note_create", { projectPath: "g/r", mergeRequestIid: 1, body: "@all" }],
  ];

  test("for every messaging row the two agree, with and without a readable policy", () => {
    for (const [toolId, input] of MESSAGING) {
      for (const policy of [POLICY, undefined]) {
        expect(modelWriteRefusal(toolId, input, { chatops: policy, kb: KB }), toolId).toBe(
          messagingDestinationRefusal(toolId, input, { chatops: policy }),
        );
      }
    }
  });

  test("ChatOps is checked first: a ChatOps-channel post with a mention reports the ChatOps reason", () => {
    expect(
      messagingDestinationRefusal(
        "slack_message_post",
        { channel: "C0123ABCD", text: "<!here>" },
        { chatops: POLICY },
      ),
    ).toBe(CHATOPS_CHANNEL_REFUSAL);
  });

  test("the KB refusal stays model-door-only: messagingDestinationRefusal never returns it", () => {
    const input = { pageId: NOTION_ID_CANONICAL, text: "x" };
    expect(modelWriteRefusal("notion_comment_create", input, { chatops: POLICY, kb: KB })).toBe(
      KNOWLEDGE_BASE_REFUSAL,
    );
    expect(
      messagingDestinationRefusal("notion_comment_create", input, { chatops: POLICY }),
    ).toBeUndefined();
    expect(
      modelWriteRefusal(
        "confluence_comment_add",
        { pageId: "98765", storageHtml: "<p>x</p>" },
        { chatops: POLICY, kb: KB },
      ),
    ).toBe(KNOWLEDGE_BASE_REFUSAL);
  });

  test("stated scope: Discord, Jira, Linear, Notion and Confluence bodies are not scanned", () => {
    const loud = "<!channel> @all @o/t <at/>";
    for (const [toolId, input] of [
      ["discord_message_post", { channelId: "123456789012345678", content: loud }],
      ["jira_comment_add", { issueKey: "NIM-1", body: loud }],
      ["linear_comment_create", { issueId: "u", body: loud }],
      ["notion_comment_create", { pageId: "ffff", text: loud }],
      ["confluence_comment_add", { pageId: "12345", storageHtml: loud }],
    ] as const) {
      expect(modelWriteRefusal(toolId, input, { chatops: POLICY, kb: KB }), toolId).toBeUndefined();
    }
  });

  test("the broadcast text is fixed and echoes nothing", () => {
    expect(BROADCAST_MENTION_REFUSAL).toBe(
      "the model cannot post a message that notifies a whole channel, group or team; rephrase without the broadcast mention",
    );
  });
});
