// OR1 (owner ruling 2026-11-05): the broadcast-mention refusal, plan R10 with the Antigravity
// review fixes 1 (loop order: fold, strip, decode until stable) and 4 (`<at/>`). Every invisible,
// bidi or fullwidth character is built with String.fromCodePoint: none is written literally.
import { describe, expect, test } from "bun:test";

import {
  BROADCAST_MENTION_REFUSAL,
  type BroadcastService,
  broadcastMentionIn,
  messagingDestinationRefusal,
} from "./model-write-refusals.ts";

const cp = (...points: number[]) => String.fromCodePoint(...points);
const ZWSP = cp(0x200b);
const WJ = cp(0x2060);
const RLO = cp(0x202e);
const LRI = cp(0x2066);
const TAG_A = cp(0xe0061);
const FW_AT = cp(0xff20);
const FW_BANG = cp(0xff01);
const FW_LT = cp(0xff1c);
const FW_GT = cp(0xff1e);
const FW_AMP = cp(0xff06);
const NBSP = cp(0xa0);

const text = { html: false } as const;
const html = { html: true } as const;
const hit = (s: BroadcastService, t: string, o: { readonly html: boolean } = text) =>
  broadcastMentionIn(s, t, o);

interface Table {
  readonly refused: readonly string[];
  readonly allowed: readonly string[];
}

const SLACK: Table = {
  refused: [
    "<!channel>",
    "hi <!here> all",
    "<!everyone>",
    "<!CHANNEL>",
    "<!here|here>",
    `<!chan${ZWSP}nel>`,
    `<${ZWSP}!here>`,
    "&lt;!here&gt;",
    "&LT;!here&GT;",
    "&amp;lt;!here&amp;gt;",
    "&#60;!everyone&#62;",
    "&#x3C;!here&#x3e;",
    "&#60!here",
    `${FW_LT}${FW_BANG}here${FW_GT}`,
    // Fix 1: an ampersand written fullwidth, and an invisible character inside the entity.
    `${FW_AMP}lt;!here${FW_AMP}gt;`,
    `&${ZWSP}lt;!here&gt;`,
    `&l${TAG_A}t;!here&gt;`,
    "<!subteam^S01|@eng>",
    "<!subteam^S01>",
    "<!date^1700000000^{date}|x> then <!here>",
    "@channel",
    "ping @here.",
    "@EVERYONE",
    `${FW_AT}channel`,
    `@chan${RLO}nel`,
    "line\n<!here>",
  ],
  allowed: [
    "hello",
    "<@U123>",
    "<#C123>",
    "<#C123|general>",
    "<!date^1700000000^{date}|x>",
    "@alice",
    "a@b.com",
    "a@here.com",
    "@heresy",
    "Tom &amp; Jerry",
    `see${NBSP}you`,
  ],
};

const GITHUB: Table = {
  refused: [
    "@Org/Team",
    "cc @nimbus-agent/core",
    `@org${WJ}/team`,
    `@org/${ZWSP}team`,
    `${FW_AT}org/team`,
    "&#64;org/team",
    "`@org/team` in a code span",
    "x@org/team",
  ],
  allowed: ["@alice", "@nimbus-agent", "a@b.com", "see org/team", "LGTM", "@ alice/x"],
};

const GITLAB: Table = {
  refused: [
    "@all",
    "@ALL",
    "cc @all.",
    `@all${RLO}`,
    `@all${RLO}x`,
    `@all${WJ}`,
    `@a${ZWSP}ll`,
    `${FW_AT}all`,
    "&#64;all please",
    "@group/sub",
    "@group/sub/deeper",
    "@my_group/project.x",
  ],
  allowed: ["@alice", "@allison", "@all.x", "@all-hands", "a@b.com", "note", "@group"],
};

const TEAMS: Table = {
  refused: [
    '<at id="0">General</at>',
    "<AT>x</AT>",
    "<at/>",
    "<at\nid=0>x</at>",
    "&lt;at id=0&gt;General&lt;/at&gt;",
    `<${LRI}at id="0">`,
    "@channel",
    "@team",
    "@Everyone",
  ],
  allowed: ["hello", "<b>hi</b>", "@alice", '<attachment id="1"></attachment>', "@teams"],
};

const TABLES: ReadonlyArray<[BroadcastService, Table]> = [
  ["slack", SLACK],
  ["github", GITHUB],
  ["gitlab", GITLAB],
  ["teams", TEAMS],
];

describe("broadcastMentionIn (OR1)", () => {
  for (const [service, table] of TABLES) {
    describe(service, () => {
      for (const t of table.refused) {
        test(`refused: ${JSON.stringify(t)}`, () => {
          expect(hit(service, t)).toBe(true);
        });
      }
      for (const t of table.allowed) {
        test(`allowed: ${JSON.stringify(t)}`, () => {
          expect(hit(service, t)).toBe(false);
          expect(hit(service, t, html)).toBe(false);
        });
      }
    });
  }

  test("Teams: an <at> tag is refused in both content types", () => {
    for (const body of ['<at id="0">General</at>', "<at/>", "&lt;at id=0&gt;"]) {
      expect(hit("teams", body, text), body).toBe(true);
      expect(hit("teams", body, html), body).toBe(true);
    }
  });

  test("an html body is also matched with its tags removed", () => {
    expect(hit("teams", "@<i></i>channel", text)).toBe(false);
    expect(hit("teams", "@<i></i>channel", html)).toBe(true);
    expect(hit("gitlab", "@<b>all</b>", html)).toBe(true);
  });

  test("the round cap is exactly 4: three decodes settle, a fourth is refused (fail closed)", () => {
    // `&` + `amp;` x n + `x` needs n decoding rounds plus one round that changes nothing.
    const chain = (n: number) => `&${"amp;".repeat(n)}x`;
    expect(hit("github", chain(3))).toBe(false);
    expect(hit("github", chain(4))).toBe(true);
    expect(hit("gitlab", chain(3))).toBe(false);
    expect(hit("gitlab", chain(4))).toBe(true);
  });

  test("a 10,000-deep chain is refused and does not hang", () => {
    expect(hit("slack", `&${"amp;".repeat(10_000)}lt;!here&gt;`)).toBe(true);
    expect(hit("github", `&${"amp;".repeat(10_000)}x`)).toBe(true);
    // No wall clock: the cap is proven above, and the test timeout catches a hang.
  });

  test("a chain shallow enough to settle decodes and is judged on its content", () => {
    expect(hit("slack", "&amp;amp;lt;!here&amp;amp;gt;")).toBe(true);
    expect(hit("slack", "a &amp;amp; b")).toBe(false);
  });

  test("an invalid numeric entity is left as is", () => {
    expect(hit("slack", "&#xD800;!here")).toBe(false);
    expect(hit("slack", "&#99999999;!here")).toBe(false);
    expect(hit("slack", "&bogus;!here")).toBe(false);
  });
});

describe("messagingDestinationRefusal: the broadcast rule on the rows (OR1)", () => {
  const NO_CHATOPS = {
    chatops: { channels: new Map(), ownership: new Map() },
  } as const;

  test("each scanned row refuses a broadcast with the fixed text, echoing nothing", () => {
    const cases: ReadonlyArray<[string, Record<string, unknown>]> = [
      ["slack_message_post", { channel: "C1", text: "hi <!here>" }],
      ["slack_message_post_dm", { user_ids: "U1", text: "<!channel>" }],
      ["teams_message_post", { teamId: "t", channelId: "19:a@thread.v2", body: "<at/>" }],
      [
        "teams_message_post_chat",
        { chatId: "19:a@thread.v2", body: "&lt;at id=0&gt;", contentType: "text" },
      ],
      ["github_issue_comment_create", { owner: "o", repo: "r", issueNumber: 1, body: "@o/t" }],
      ["gitlab_issue_note_create", { projectPath: "g/r", issueIid: 1, body: "@all" }],
      ["gitlab_mr_note_create", { projectPath: "g/r", mergeRequestIid: 1, body: "@g/sub" }],
    ];
    for (const [toolId, input] of cases) {
      expect(messagingDestinationRefusal(toolId, input, NO_CHATOPS), toolId).toBe(
        BROADCAST_MENTION_REFUSAL,
      );
    }
  });

  test("a non-string or missing scanned field is refused (fail closed)", () => {
    expect(
      messagingDestinationRefusal("slack_message_post", { channel: "C1", text: 7 }, NO_CHATOPS),
    ).toBe(BROADCAST_MENTION_REFUSAL);
    expect(
      messagingDestinationRefusal(
        "gitlab_mr_note_create",
        { projectPath: "g/r", mergeRequestIid: 1 },
        NO_CHATOPS,
      ),
    ).toBe(BROADCAST_MENTION_REFUSAL);
    // An inherited `body` is not the input's own field.
    const inherited = Object.create({ body: "fine" }) as Record<string, unknown>;
    expect(messagingDestinationRefusal("github_issue_comment_create", inherited, NO_CHATOPS)).toBe(
      BROADCAST_MENTION_REFUSAL,
    );
  });

  test("Teams html is decided by contentType: html strips tags for a third form", () => {
    const input = (contentType: string) => ({
      chatId: "19:a@thread.v2",
      body: "@<i></i>channel",
      contentType,
    });
    expect(
      messagingDestinationRefusal("teams_message_post_chat", input("text"), NO_CHATOPS),
    ).toBeUndefined();
    expect(messagingDestinationRefusal("teams_message_post_chat", input("html"), NO_CHATOPS)).toBe(
      BROADCAST_MENTION_REFUSAL,
    );
  });

  test("positive controls on the same rows are allowed", () => {
    expect(
      messagingDestinationRefusal(
        "slack_message_post",
        { channel: "C1", text: "<@U1>" },
        NO_CHATOPS,
      ),
    ).toBeUndefined();
    expect(
      messagingDestinationRefusal(
        "gitlab_mr_note_create",
        { projectPath: "g/r", mergeRequestIid: 1, body: "@alice" },
        NO_CHATOPS,
      ),
    ).toBeUndefined();
  });
});
