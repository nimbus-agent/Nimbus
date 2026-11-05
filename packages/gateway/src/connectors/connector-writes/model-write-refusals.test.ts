import { describe, expect, test } from "bun:test";

import { serviceOf } from "../../engine/service-of.ts";
import type { ChatopsChannelBinding, ChatopsPolicy } from "../../policy/types.ts";
import { CONNECTOR_WRITE_ROWS } from "./index.ts";
import { isModelOfferableRow } from "./model-offerable.ts";
import {
  ACT_DOOR_KB_CHILD_REFUSAL,
  actDoorRefusal,
  BROADCAST_MENTION_REFUSAL,
  CALENDAR_TEXT_REFUSAL,
  CALENDAR_TIME_REFUSAL,
  CHATOPS_CHANNEL_REFUSAL,
  calendarTimeIsExplicit,
  isChatopsDestinationRow,
  isKnowledgeBaseCapableRow,
  KNOWLEDGE_BASE_REFUSAL,
  LINEAR_ASSIGNEE_REFUSAL,
  messagingDestinationRefusal,
  modelWriteRefusal,
  nullOptionalFieldRefusal,
  nullRefusedOptionalKeys,
  quickActionTextKeys,
  scannedTextKeys,
  scopedLabelKeys,
  type TribalKbConfig,
} from "./model-write-refusals.ts";
import { previewTemplateKeys } from "./types.ts";

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
        "jira_issue_create",
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

  test("the KB refusal is not part of the messaging check: messagingDestinationRefusal never returns it", () => {
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

describe("B2 tripwires: every offerable GitHub/GitLab text and label field is scanned (plan R6)", () => {
  const offerable = CONNECTOR_WRITE_ROWS.filter(isModelOfferableRow);
  const ofSvc = (svcs: readonly string[]) =>
    offerable
      .filter((r) => svcs.includes(serviceOf(r.actionType)))
      .map((r) => r.toolId)
      .sort((a, b) => a.localeCompare(b));

  /** The broadcast-scanned keys of every offerable GitHub/GitLab row, spelled out. */
  const BROADCAST_KEYS: Readonly<Record<string, readonly string[]>> = {
    github_issue_comment_create: ["body"],
    github_issue_create: ["title", "body"],
    github_issue_labels_add: [],
    github_issue_assignees_add: [],
    github_issue_state_set: [],
    gitlab_issue_note_create: ["body"],
    gitlab_mr_note_create: ["body"],
    gitlab_issue_create: ["title", "description"],
    gitlab_issue_labels_add: [],
    gitlab_issue_assignees_add: [],
    gitlab_issue_state_set: [],
  };

  /** The quick-action keys of every offerable GitLab row (never a title: ruling R-QA). */
  const QUICK_ACTION_KEYS: Readonly<Record<string, readonly string[]>> = {
    gitlab_issue_note_create: ["body"],
    gitlab_mr_note_create: ["body"],
    gitlab_issue_create: ["description"],
    gitlab_issue_labels_add: [],
    gitlab_issue_assignees_add: [],
    gitlab_issue_state_set: [],
  };

  test("the broadcast map names exactly the offerable GitHub/GitLab rows, and each row scans those keys", () => {
    expect(ofSvc(["github", "gitlab"])).toEqual(
      Object.keys(BROADCAST_KEYS).sort((a, b) => a.localeCompare(b)),
    );
    for (const [toolId, keys] of Object.entries(BROADCAST_KEYS)) {
      expect(scannedTextKeys(toolId), toolId).toEqual(keys);
    }
  });

  test("the quick-action map names exactly the offerable GitLab rows, and each row scans those keys", () => {
    expect(ofSvc(["gitlab"])).toEqual(
      Object.keys(QUICK_ACTION_KEYS).sort((a, b) => a.localeCompare(b)),
    );
    for (const [toolId, keys] of Object.entries(QUICK_ACTION_KEYS)) {
      expect(quickActionTextKeys(toolId), toolId).toEqual(keys);
    }
  });

  test("every offerable GitLab row whose schema has labels is checked by the scoped-label rule", () => {
    const withLabels = offerable.filter(
      (r) =>
        serviceOf(r.actionType) === "gitlab" &&
        r.preview !== undefined &&
        previewTemplateKeys(r.preview).has("labels"),
    );
    expect(withLabels.map((r) => r.toolId).sort((a, b) => a.localeCompare(b))).toEqual([
      "gitlab_issue_create",
      "gitlab_issue_labels_add",
    ]);
    for (const r of withLabels) expect(scopedLabelKeys(r.toolId), r.toolId).toEqual(["labels"]);
    // And only those: no other row's input is read as a GitLab label list.
    for (const r of CONNECTOR_WRITE_ROWS) {
      if (!withLabels.includes(r)) expect(scopedLabelKeys(r.toolId), r.toolId).toEqual([]);
    }
  });

  test("Jira and Linear issue text is not scanned (stated scope): @all is allowed there", () => {
    for (const [toolId, input] of [
      ["jira_issue_create", { projectKey: "NIM", summary: "@all", description: "@all /close" }],
      ["jira_issue_update", { issueKey: "NIM-1", description: "@here" }],
      ["linear_issue_create", { teamId: "t", title: "@all", description: "@all" }],
      ["linear_issue_update", { issueId: "i", description: "@all" }],
    ] as const) {
      expect(scannedTextKeys(toolId), toolId).toEqual([]);
      expect(messagingDestinationRefusal(toolId, input, { chatops: undefined }), toolId).toBe(
        undefined,
      );
    }
  });

  test("the model door never applies the act-door Linear rule: the guard decides there", () => {
    for (const assigneeId of ["user-1", "", null, undefined]) {
      expect(
        modelWriteRefusal(
          "linear_issue_update",
          { issueId: "i", assigneeId },
          { chatops: undefined, kb: KB },
        ),
        String(assigneeId),
      ).toBeUndefined();
    }
    expect(LINEAR_ASSIGNEE_REFUSAL).toBe(
      "the model can assign a Linear issue only while it is unassigned; ask the owner to reassign it",
    );
  });
});

// ---- B3: the KB-target refusal on every page row (plan R5, Review Focus 1) --------------------

const B3_KB: TribalKbConfig = {
  notion: { databaseId: "0123abcd-0123-abcd-0123-abcd0123abcd" },
  confluence: { spaceKey: "KB", parentPageId: "4242" },
};
const B3_NOTION_KB = "0123abcd0123abcd0123abcd0123abcd";
const B3_NOTION_OTHER = "ffffffffffffffffffffffffffffffff";
const NOTION_SPELLINGS: readonly unknown[] = [
  B3_NOTION_KB,
  "0123abcd-0123-abcd-0123-abcd0123abcd",
  B3_NOTION_KB.toUpperCase(),
  `https://www.notion.so/Team-KB-${B3_NOTION_KB}`,
  42,
];
const CONFLUENCE_SPELLINGS: readonly unknown[] = [
  "4242",
  " 4242 ",
  "04242",
  4242,
  "https://acme.atlassian.net/wiki/spaces/KB/pages/4242",
];

/** The B3 page rows, the key that names their target, and a clean rest of the input. */
const B3_PAGE_ROWS: ReadonlyArray<readonly [string, string, Record<string, unknown>]> = [
  ["notion_page_create", "parentPageId", { title: "t" }],
  ["notion_page_update", "pageId", { propertiesJson: "{}" }],
  ["notion_block_append", "parentBlockId", { childrenJson: "[]" }],
  ["confluence_page_create", "parentPageId", { spaceKey: "ENG", title: "t", storageHtml: "x" }],
  ["confluence_page_update", "pageId", { versionNumber: 1, title: "t", storageHtml: "x" }],
  ["confluence_page_append", "pageId", { storageHtml: "x" }],
];

const B3_DRAFT_ROWS: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ["gmail_draft_create", { to: "a@x.com", subject: "s", body: "@all <!channel>" }],
  ["apple_mail_draft_create", { to: "a@x.com", subject: "s", body: "@here" }],
  [
    "outlook_draft_create",
    { to: "a@x.com", subject: "s", body: "<at>x</at>", contentType: "html" },
  ],
];

describe("B3: the KB-target refusal covers every page row (plan R5)", () => {
  const refusal = (toolId: string, input: Record<string, unknown>, cfg = B3_KB) =>
    modelWriteRefusal(toolId, input, { chatops: NONE, kb: cfg });

  test("every page row naming the KB destination, in every spelling, is refused", () => {
    for (const [toolId, key, rest] of B3_PAGE_ROWS) {
      const spellings = toolId.startsWith("notion") ? NOTION_SPELLINGS : CONFLUENCE_SPELLINGS;
      for (const v of spellings) {
        expect(refusal(toolId, { ...rest, [key]: v }), `${toolId} ${String(v)}`).toBe(
          KNOWLEDGE_BASE_REFUSAL,
        );
      }
    }
  });

  test("another canonical id is allowed; no KB configured refuses nothing", () => {
    for (const [toolId, key, rest] of B3_PAGE_ROWS) {
      const other = toolId.startsWith("notion") ? B3_NOTION_OTHER : "12345";
      expect(refusal(toolId, { ...rest, [key]: other }), toolId).toBeUndefined();
      const kbValue = toolId.startsWith("notion") ? B3_NOTION_KB : "4242";
      expect(
        modelWriteRefusal(toolId, { ...rest, [key]: kbValue }, { chatops: NONE, kb: undefined }),
        toolId,
      ).toBeUndefined();
      expect(refusal(toolId, { ...rest, [key]: kbValue }, {}), toolId).toBeUndefined();
    }
  });

  test("stated bound: a Confluence create in the KB space with no parent is not refused", () => {
    expect(
      refusal("confluence_page_create", { spaceKey: "KB", title: "t", storageHtml: "x" }),
    ).toBeUndefined();
  });

  test("every page row is KB-capable; no draft row is", () => {
    for (const [toolId] of B3_PAGE_ROWS)
      expect(isKnowledgeBaseCapableRow(toolId), toolId).toBe(true);
    for (const [toolId] of B3_DRAFT_ROWS) {
      expect(isKnowledgeBaseCapableRow(toolId), toolId).toBe(false);
    }
  });

  test("the messaging check refuses none of the nine, clean, KB-targeted or with mentions (R6)", () => {
    const mentions = [
      "@all @here <p>@channel</p>",
      '<ac:link><ri:user ri:account-id="5b10ac8d82e05b22cc7d4ef5"/></ac:link>',
      JSON.stringify([
        {
          type: "paragraph",
          paragraph: {
            rich_text: [{ type: "mention", mention: { type: "user", user: { id: "u" } } }],
          },
        },
      ]),
    ];
    for (const [toolId, key, rest] of B3_PAGE_ROWS) {
      const kbValue = toolId.startsWith("notion") ? B3_NOTION_KB : "4242";
      const bodyKey = Object.keys(rest).find((k) => k !== "spaceKey" && k !== "title") ?? "title";
      for (const input of [
        { ...rest, [key]: "12345" },
        { ...rest, [key]: kbValue },
        ...mentions.map((m) => ({ ...rest, [key]: "12345", [bodyKey]: m })),
      ]) {
        expect(
          messagingDestinationRefusal(toolId, input, { chatops: NONE }),
          `${toolId} ${JSON.stringify(input)}`,
        ).toBeUndefined();
        expect(scannedTextKeys(toolId), toolId).toEqual([]);
      }
    }
    for (const [toolId, input] of B3_DRAFT_ROWS) {
      expect(messagingDestinationRefusal(toolId, input, { chatops: NONE }), toolId).toBeUndefined();
      expect(refusal(toolId, input), toolId).toBeUndefined();
    }
  });
});

describe("B3: actDoorRefusal's KB rules (plan R5, R12)", () => {
  const KB = {
    notion: { databaseId: "0123abcd0123abcd0123abcd0123abcd" },
    confluence: { spaceKey: "KB", parentPageId: "4242" },
  } satisfies TribalKbConfig;
  const ctxWith = (kb: TribalKbConfig | undefined, kbUnreadable = false) => ({
    chatops: undefined,
    kb,
    kbUnreadable,
  });
  const PAGE_ROWS: ReadonlyArray<
    readonly [string, Record<string, unknown>, Record<string, unknown>]
  > = [
    [
      "notion_page_create",
      { parentPageId: "0123abcd0123abcd0123abcd0123abcd" },
      { parentPageId: "ffff" },
    ],
    ["notion_page_update", { pageId: "0123ABCD-0123-abcd-0123-abcd0123abcd" }, { pageId: "ffff" }],
    [
      "notion_block_append",
      { parentBlockId: "0123abcd0123abcd0123abcd0123abcd" },
      { parentBlockId: "ffff" },
    ],
    ["notion_comment_create", { pageId: "0123abcd0123abcd0123abcd0123abcd" }, { pageId: "ffff" }],
    ["confluence_page_create", { parentPageId: " 4242 " }, { parentPageId: "55" }],
    ["confluence_page_update", { pageId: "04242" }, { pageId: "55" }],
    ["confluence_page_append", { pageId: 4242 }, { pageId: "55" }],
    ["confluence_comment_add", { pageId: "4242" }, { pageId: "55" }],
  ];
  const KB_CHILD_ROWS = [
    "notion_page_update",
    "notion_block_append",
    "confluence_page_update",
    "confluence_page_append",
  ];

  test("equals messagingDestinationRefusal on every row that is not KB-capable", () => {
    for (const r of CONNECTOR_WRITE_ROWS) {
      if (isKnowledgeBaseCapableRow(r.toolId) || r.toolId === "linear_issue_update") continue;
      for (const kbUnreadable of [false, true]) {
        expect(actDoorRefusal(r.toolId, {}, ctxWith(KB, kbUnreadable)), r.toolId).toBe(
          messagingDestinationRefusal(r.toolId, {}, { chatops: undefined }),
        );
      }
    }
  });

  test("the KB-target cases refuse with KNOWLEDGE_BASE_REFUSAL, before the KB-child rule", () => {
    for (const [toolId, target] of PAGE_ROWS) {
      expect(actDoorRefusal(toolId, target, ctxWith(KB)), toolId).toBe(KNOWLEDGE_BASE_REFUSAL);
    }
  });

  test("R12: the four update/append rows refuse while their service's KB is configured, not otherwise", () => {
    for (const [toolId, , other] of PAGE_ROWS) {
      const child = KB_CHILD_ROWS.includes(toolId);
      expect(actDoorRefusal(toolId, other, ctxWith(KB)), toolId).toBe(
        child ? ACT_DOOR_KB_CHILD_REFUSAL : undefined,
      );
      expect(actDoorRefusal(toolId, other, ctxWith(undefined)), toolId).toBeUndefined();
      const otherService = toolId.startsWith("notion")
        ? { confluence: KB.confluence }
        : { notion: KB.notion };
      expect(actDoorRefusal(toolId, other, ctxWith(otherService)), toolId).toBeUndefined();
    }
  });

  test("an unreadable KB config refuses every KB-capable row with KNOWLEDGE_BASE_REFUSAL", () => {
    for (const [toolId, , other] of PAGE_ROWS) {
      expect(actDoorRefusal(toolId, other, ctxWith(undefined, true)), toolId).toBe(
        KNOWLEDGE_BASE_REFUSAL,
      );
    }
  });

  test("the order is messaging, Linear, KB target, KB child", () => {
    // Linear first: the KB never matters for it.
    expect(
      actDoorRefusal("linear_issue_update", { issueId: "i", assigneeId: null }, ctxWith(KB, true)),
    ).toBe(LINEAR_ASSIGNEE_REFUSAL);
    // A KB-target append reports the KB-target reason, not the KB-child one.
    expect(actDoorRefusal("confluence_page_append", { pageId: "4242" }, ctxWith(KB))).toBe(
      KNOWLEDGE_BASE_REFUSAL,
    );
    expect(ACT_DOOR_KB_CHILD_REFUSAL).toBe(
      "an MCP proposal cannot update or append to a Notion or Confluence page while a Nimbus knowledge base is configured there: the act door cannot check whether the page is in it",
    );
  });
});

// ---- B4a: the calendar refusals (plan R6, review fix 1; Review Focus 1 and 2) ------------------

describe("R6: calendar event times and iCloud event text (both doors)", () => {
  const OUTLOOK = "outlook_calendar_create";
  const APPLE = "apple_calendar_event_create";
  const outlookInput = (over: Record<string, unknown>): Record<string, unknown> => ({
    subject: "Review",
    startDateTime: "2026-11-05T10:00:00",
    endDateTime: "2026-11-05T11:00:00",
    timeZone: "Europe/Paris",
    ...over,
  });
  const appleInput = (over: Record<string, unknown>): Record<string, unknown> => ({
    summary: "Review",
    start: "20261105T100000Z",
    end: "20261105T110000Z",
    ...over,
  });
  const ACT_CTX = { chatops: NONE, kb: undefined, kbUnreadable: false };

  /** The same result through all three entry points (the rule is in the shared check). */
  function onAllDoors(toolId: string, input: Record<string, unknown>): string | undefined {
    const messaging = messagingDestinationRefusal(toolId, input, { chatops: NONE });
    expect(modelWriteRefusal(toolId, input, { chatops: NONE, kb: undefined })).toBe(messaging);
    expect(actDoorRefusal(toolId, input, ACT_CTX)).toBe(messaging);
    return messaging;
  }

  const FULLWIDTH_TWO = String.fromCodePoint(0xff12);
  const LS = String.fromCodePoint(0x2028);
  const NEL = String.fromCodePoint(0x85);
  const DEL = String.fromCodePoint(0x7f);
  const RLO = String.fromCodePoint(0x202e);

  test("the refusal texts are fixed", () => {
    expect(CALENDAR_TIME_REFUSAL).toBe(
      "the model must give an event time in the stated form so its time zone is shown: Outlook YYYY-MM-DDTHH:MM[:SS] with timeZone, iCloud YYYYMMDDTHHMMSSZ (UTC)",
    );
    expect(CALENDAR_TEXT_REFUSAL).toBe(
      "an iCloud event's title, description, location, calendar, id or attendees cannot contain a line break or control character, and an attendee cannot contain a space",
    );
  });

  test("Outlook: wall-clock times without an offset are allowed, any time zone shown", () => {
    for (const t of ["2026-11-05T10:00", "2026-11-05T10:00:00", "2026-11-05T10:00:00.1234567"]) {
      expect(onAllDoors(OUTLOOK, outlookInput({ startDateTime: t, endDateTime: t })), t).toBe(
        undefined,
      );
    }
    for (const timeZone of [undefined, "Pacific Standard Time", "Europe/Paris"]) {
      expect(onAllDoors(OUTLOOK, outlookInput({ timeZone }))).toBeUndefined();
    }
  });

  test("Outlook: an offset, Z, a date only, a space, a number, a separator or fullwidth digits are refused", () => {
    const bad: unknown[] = [
      "2026-11-05T10:00:00Z",
      "2026-11-05T10:00:00+02:00",
      "2026-11-05T10:00:00-0500",
      "2026-11-05",
      "2026-11-05 10:00",
      "2026-11-05T10:00:00.12345678",
      `2026-11-05T10:00${LS}`,
      "2026-11-05T10:00\n",
      `${FULLWIDTH_TWO}026-11-05T10:00`,
      20261105,
      null,
      "",
    ];
    for (const v of bad) {
      expect(onAllDoors(OUTLOOK, outlookInput({ startDateTime: v })), String(v)).toBe(
        CALENDAR_TIME_REFUSAL,
      );
      expect(onAllDoors(OUTLOOK, outlookInput({ endDateTime: v })), String(v)).toBe(
        CALENDAR_TIME_REFUSAL,
      );
    }
    const missing = outlookInput({});
    delete missing["endDateTime"];
    expect(onAllDoors(OUTLOOK, missing)).toBe(CALENDAR_TIME_REFUSAL);
  });

  test("iCloud: only YYYYMMDDTHHMMSSZ (UTC) is allowed", () => {
    expect(onAllDoors(APPLE, appleInput({}))).toBeUndefined();
    const bad: unknown[] = [
      "20261105T100000",
      "20261105",
      "2026-11-05T10:00:00Z",
      "20261105T100000Z\r\nATTENDEE:mailto:x@evil.example",
      "20261105T100000Z\n",
      `${FULLWIDTH_TWO}0261105T100000Z`,
      20261105,
      null,
    ];
    for (const v of bad) {
      expect(onAllDoors(APPLE, appleInput({ start: v })), String(v)).toBe(CALENDAR_TIME_REFUSAL);
      expect(onAllDoors(APPLE, appleInput({ end: v })), String(v)).toBe(CALENDAR_TIME_REFUSAL);
    }
  });

  test("iCloud: a control character in any text field is refused (hidden-invitee forms)", () => {
    const cases: ReadonlyArray<readonly [string, unknown]> = [
      ["summary", "Review\rATTENDEE:mailto:x@evil.example"],
      ["summary", "a\nb"],
      ["description", "line\r\nATTENDEE:mailto:x@evil.example"],
      ["location", "Room\t4"],
      ["calendar", `Work${NEL}`],
      ["calendar", `Work${DEL}`],
      ["uid", "a\rATTENDEE:mailto:x@evil.example"],
      ["summary", null],
      ["location", 42],
    ];
    for (const [key, v] of cases) {
      expect(onAllDoors(APPLE, appleInput({ [key]: v })), `${key}=${JSON.stringify(v)}`).toBe(
        CALENDAR_TEXT_REFUSAL,
      );
    }
  });

  test("iCloud: uid must match ^[A-Za-z0-9._@-]{1,200}$", () => {
    for (const ok of ["evt-1@example.com", "a", "x".repeat(200)]) {
      expect(onAllDoors(APPLE, appleInput({ uid: ok })), ok).toBeUndefined();
    }
    for (const bad of ["", "a b", "a;b", "x".repeat(201), "evt/1", "a:b"]) {
      expect(onAllDoors(APPLE, appleInput({ uid: bad })), bad).toBe(CALENDAR_TEXT_REFUSAL);
    }
  });

  test("iCloud attendees: each a non-empty string with no whitespace or control (review fix 1)", () => {
    const fifty = Array.from({ length: 50 }, (_, i) => `p${String(i)}@example.com`);
    expect(onAllDoors(APPLE, appleInput({ attendees: fifty }))).toBeUndefined();
    expect(onAllDoors(APPLE, appleInput({ attendees: [] }))).toBeUndefined();
    const bad: unknown[] = [
      ["a@x.com\r\nATTENDEE:mailto:x@evil.example"],
      ["a@x.com", "b@y.com\n"],
      ["a@x.com\t"],
      ["a @x.com"],
      [`a@x.com${NEL}`],
      [`a@x.com${LS}`],
      [""],
      [42],
      [null],
      "a@x.com",
      { 0: "a@x.com" },
    ];
    for (const attendees of bad) {
      expect(onAllDoors(APPLE, appleInput({ attendees })), JSON.stringify(attendees)).toBe(
        CALENDAR_TEXT_REFUSAL,
      );
    }
  });

  test("a non-control character (U+202E) is not refused: the preview sanitiser escapes it", () => {
    expect(onAllDoors(APPLE, appleInput({ summary: `a${RLO}b` }))).toBeUndefined();
  });

  test("order: a bad time AND a control character reports the time", () => {
    expect(onAllDoors(APPLE, appleInput({ start: "20261105", summary: "a\rATTENDEE:x" }))).toBe(
      CALENDAR_TIME_REFUSAL,
    );
  });

  test("the rule is row-scoped: every other row ignores calendar keys", () => {
    const junk = {
      startDateTime: "x",
      start: "x",
      end: "x",
      summary: "a\rb",
      uid: "a\rb",
      attendees: ["a\rb"],
    };
    for (const r of CONNECTOR_WRITE_ROWS) {
      if (r.toolId === OUTLOOK || r.toolId === APPLE) continue;
      const out = messagingDestinationRefusal(r.toolId, junk, { chatops: NONE });
      expect(out === CALENDAR_TIME_REFUSAL || out === CALENDAR_TEXT_REFUSAL, r.toolId).toBe(false);
    }
  });

  test("a well-shaped but impossible date or clock time is refused (CodeRabbit on #1906)", () => {
    const outlookBad = [
      "2026-02-30T10:00", // Feb 30
      "2026-02-29T10:00", // Feb 29 in a non-leap year
      "2100-02-29T10:00", // a century year that is not a leap year
      "2026-13-01T10:00", // month 13
      "2026-00-10T10:00", // month 0
      "2026-04-31T10:00", // April has 30 days
      "2026-11-00T10:00", // day 0
      "2026-11-05T24:00", // hour 24
      "2026-11-05T10:60", // minute 60
      "2026-11-05T10:00:60", // second 60
      "0050-02-29T10:00", // year 50 is not a leap year
    ];
    for (const t of outlookBad) {
      expect(onAllDoors(OUTLOOK, outlookInput({ startDateTime: t })), t).toBe(
        CALENDAR_TIME_REFUSAL,
      );
    }
    const appleBad = [
      "20260230T100000Z",
      "20260229T100000Z",
      "20261301T100000Z",
      "20261105T240000Z",
      "20261105T106000Z",
      "20261105T100060Z",
      "00500229T100000Z",
    ];
    for (const t of appleBad) {
      expect(onAllDoors(APPLE, appleInput({ start: t })), t).toBe(CALENDAR_TIME_REFUSAL);
    }
  });

  test("real dates are allowed, leap days and years 0000-0099 included (no Date.UTC 19xx mapping)", () => {
    const outlookOk = [
      "2028-02-29T10:00", // leap year
      "2000-02-29T23:59:59", // a century leap year
      "0000-02-29T00:00", // year 0 is a leap year (1900 is not)
      "0050-06-15T10:00", // year 50, not 1950
      "2026-12-31T23:59:59.9999999",
    ];
    for (const t of outlookOk) {
      expect(onAllDoors(OUTLOOK, outlookInput({ startDateTime: t, endDateTime: t })), t).toBe(
        undefined,
      );
    }
    for (const t of ["20280229T235959Z", "00000229T000000Z", "00500615T100000Z"]) {
      expect(onAllDoors(APPLE, appleInput({ start: t, end: t })), t).toBeUndefined();
    }
  });

  test("calendarTimeIsExplicit answers only for a calendar row's own time keys", () => {
    expect(calendarTimeIsExplicit(OUTLOOK, "startDateTime", "2026-11-05T10:00")).toBe(true);
    expect(calendarTimeIsExplicit(OUTLOOK, "start", "2026-11-05T10:00")).toBe(false);
    expect(calendarTimeIsExplicit(APPLE, "end", "20261105T100000Z")).toBe(true);
    expect(calendarTimeIsExplicit(APPLE, "endDateTime", "20261105T100000Z")).toBe(false);
    expect(calendarTimeIsExplicit("slack_message_post", "start", "20261105T100000Z")).toBe(false);
    expect(calendarTimeIsExplicit("toString", "start", "20261105T100000Z")).toBe(false);
  });
});

describe("B4a: a present-but-null optional field on the calendar and Drive creates (coordinator rulings, both doors)", () => {
  const ACT_CTX = { chatops: NONE, kb: undefined, kbUnreadable: false };
  const all = (toolId: string, input: Record<string, unknown>): Array<string | undefined> => [
    messagingDestinationRefusal(toolId, input, { chatops: NONE }),
    modelWriteRefusal(toolId, input, { chatops: NONE, kb: undefined }),
    actDoorRefusal(toolId, input, ACT_CTX),
  ];
  const CLEAN: Readonly<Record<string, Record<string, unknown>>> = {
    outlook_calendar_create: {
      subject: "Review",
      startDateTime: "2026-11-05T10:00",
      endDateTime: "2026-11-05T11:00",
    },
    apple_calendar_event_create: {
      summary: "Review",
      start: "20261105T100000Z",
      end: "20261105T110000Z",
    },
    gdrive_file_create: { name: "n.txt" },
  };
  const ROWS = Object.keys(CLEAN);

  test("the text names the schema key and nothing else", () => {
    expect(nullOptionalFieldRefusal("timeZone")).toBe(
      "the field `timeZone` cannot be null; omit it or give a value",
    );
  });

  test("the refused keys are exactly each row's optional (whenUnset) template keys", () => {
    for (const toolId of ROWS) {
      const r = CONNECTOR_WRITE_ROWS.find((x) => x.toolId === toolId);
      const optional = (r?.preview?.fields ?? [])
        .filter((f) => f.whenUnset !== undefined)
        .map((f) => f.key)
        .sort((a, b) => a.localeCompare(b));
      expect(
        [...nullRefusedOptionalKeys(toolId)].sort((a, b) => a.localeCompare(b)),
        toolId,
      ).toEqual(optional);
    }
    expect(nullRefusedOptionalKeys("slack_message_post")).toEqual([]);
  });

  for (const [toolId, key] of [
    ["outlook_calendar_create", "timeZone"],
    ["outlook_calendar_create", "attendees"],
    ["outlook_calendar_create", "body"],
    ["apple_calendar_event_create", "attendees"],
    ["apple_calendar_event_create", "description"],
    ["gdrive_file_create", "content"],
    ["gdrive_file_create", "mimeType"],
    ["gdrive_file_create", "parentId"],
  ] as const) {
    test(`${toolId}: ${key} null is refused on every entry point, naming ${key}`, () => {
      const refusal = nullOptionalFieldRefusal(key);
      expect(all(toolId, { ...CLEAN[toolId], [key]: null })).toEqual([refusal, refusal, refusal]);
    });
  }

  test("every optional key of every row: null refused; omitted or undefined allowed", () => {
    for (const toolId of ROWS) {
      expect(all(toolId, { ...CLEAN[toolId] }), toolId).toEqual([undefined, undefined, undefined]);
      for (const key of nullRefusedOptionalKeys(toolId)) {
        expect(all(toolId, { ...CLEAN[toolId], [key]: undefined }), `${toolId}.${key}`).toEqual([
          undefined,
          undefined,
          undefined,
        ]);
        expect(all(toolId, { ...CLEAN[toolId], [key]: null })[0], `${toolId}.${key}`).toBe(
          nullOptionalFieldRefusal(key),
        );
      }
    }
  });

  test("row-scoped: another row with these keys null is not refused by it", () => {
    const junk = { timeZone: null, attendees: null, body: null, content: null, parentId: null };
    for (const r of CONNECTOR_WRITE_ROWS) {
      if (ROWS.includes(r.toolId)) continue;
      const out = messagingDestinationRefusal(r.toolId, junk, { chatops: NONE });
      expect(out?.includes("cannot be null") ?? false, r.toolId).toBe(false);
    }
  });
});
