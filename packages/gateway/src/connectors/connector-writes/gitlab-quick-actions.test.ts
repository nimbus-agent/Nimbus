// Coordinator ruling (2026-11-05, recorded for the owner): a model-written GitLab note must not
// change state through a quick action (`/close`, `/merge`, `/approve`, `/assign @x`). Invisible,
// bidi and fullwidth characters are built with String.fromCodePoint: none is written literally.
import { describe, expect, test } from "bun:test";

import {
  BROADCAST_MENTION_REFUSAL,
  GITLAB_QUICK_ACTION_REFUSAL,
  gitlabQuickActionIn,
  messagingDestinationRefusal,
  modelWriteRefusal,
} from "./model-write-refusals.ts";

const cp = (...points: number[]) => String.fromCodePoint(...points);
const ZWSP = cp(0x200b);
const WJ = cp(0x2060);
const RLO = cp(0x202e);
const NBSP = cp(0xa0);
const FW_SLASH = cp(0xff0f);
const FW_C = cp(0xff43);
const LS = cp(0x2028);
const NEL = cp(0x85);

const REFUSED: readonly string[] = [
  "/close",
  "/CLOSE",
  "/merge",
  "/approve",
  "/assign @x",
  "LGTM\n/merge",
  "  /approve",
  "\t/assign @alice",
  `${NBSP}/close`,
  "LGTM\r\n/close",
  "LGTM\r/close",
  `LGTM${LS}/close`,
  `LGTM${NEL}/close`,
  `${ZWSP}/close`,
  `${WJ}/close`,
  `${RLO}/close`,
  `/${ZWSP}close`,
  `${FW_SLASH}close`,
  `/${FW_C}lose`,
  "&#47;close",
  "&#x2F;close",
  "&#047;close",
  "LGTM&#10;/close",
  "LGTM&amp;#10;/close",
  "```\n/close\n```",
  "> quoted\n/label ~bug",
];

const ALLOWED: readonly string[] = [
  "LGTM",
  "use and/or here",
  "see https://gitlab.com/g/r/-/issues/1",
  "path a/b/c",
  "1/2 done",
  "/ close",
  "/1",
  "a line\n  / not a command",
  "ends with a slash /",
  `two${NBSP}words`,
];

describe("gitlabQuickActionIn", () => {
  for (const t of REFUSED) {
    test(`refused: ${JSON.stringify(t)}`, () => {
      expect(gitlabQuickActionIn(t)).toBe(true);
    });
  }
  for (const t of ALLOWED) {
    test(`allowed: ${JSON.stringify(t)}`, () => {
      expect(gitlabQuickActionIn(t)).toBe(false);
    });
  }

  test("a body that does not settle within the round cap is refused (fail closed)", () => {
    expect(gitlabQuickActionIn(`&${"amp;".repeat(4)}x`)).toBe(true);
    expect(gitlabQuickActionIn(`&${"amp;".repeat(3)}x`)).toBe(false);
  });
});

describe("the quick-action refusal on the rows", () => {
  const NO_CHATOPS = { chatops: { channels: new Map(), ownership: new Map() } } as const;
  const issue = (body: unknown) => ({ projectPath: "g/r", issueIid: 7, body });
  const mr = (body: unknown) => ({ projectPath: "g/r", mergeRequestIid: 9, body });

  test("both GitLab note rows refuse a quick action with the fixed text, echoing nothing", () => {
    expect(
      messagingDestinationRefusal("gitlab_issue_note_create", issue("done\n/close"), NO_CHATOPS),
    ).toBe(GITLAB_QUICK_ACTION_REFUSAL);
    expect(messagingDestinationRefusal("gitlab_mr_note_create", mr(" /merge"), NO_CHATOPS)).toBe(
      GITLAB_QUICK_ACTION_REFUSAL,
    );
    expect(GITLAB_QUICK_ACTION_REFUSAL).toBe(
      "GitLab quick actions (lines starting with /) are not allowed in model-written GitLab text; rephrase without them",
    );
  });

  test("positive controls are allowed, and a broadcast mention reports the broadcast reason first", () => {
    expect(
      messagingDestinationRefusal("gitlab_mr_note_create", mr("use and/or"), NO_CHATOPS),
    ).toBeUndefined();
    expect(
      messagingDestinationRefusal("gitlab_mr_note_create", mr("@all\n/close"), NO_CHATOPS),
    ).toBe(BROADCAST_MENTION_REFUSAL);
  });

  test("the model door gets it through modelWriteRefusal; it never comes from the KB path", () => {
    expect(
      modelWriteRefusal("gitlab_issue_note_create", issue("/close"), {
        chatops: undefined,
        kb: { notion: { databaseId: "abcd" } },
      }),
    ).toBe(GITLAB_QUICK_ACTION_REFUSAL);
    expect(
      modelWriteRefusal(
        "notion_comment_create",
        { pageId: "ffff", text: "/close" },
        {
          chatops: undefined,
          kb: { notion: { databaseId: "abcd" } },
        },
      ),
    ).toBeUndefined();
  });

  test("other rows are not scanned for quick actions (GitHub, Jira, Linear, Slack)", () => {
    for (const [toolId, input] of [
      ["github_issue_comment_create", { owner: "o", repo: "r", issueNumber: 1, body: "/close" }],
      ["jira_comment_add", { issueKey: "NIM-1", body: "/close" }],
      ["linear_comment_create", { issueId: "u", body: "/close" }],
      ["slack_message_post", { channel: "C1", text: "/remind me" }],
    ] as const) {
      expect(messagingDestinationRefusal(toolId, input, NO_CHATOPS), toolId).toBeUndefined();
    }
  });
});

describe("B2: quick actions in a GitLab issue create's description (ruling R-QA)", () => {
  const NO_CHATOPS = { chatops: undefined } as const;
  const create = (over: Record<string, unknown>) =>
    messagingDestinationRefusal(
      "gitlab_issue_create",
      { projectPath: "g/r", title: "Bug", ...over },
      NO_CHATOPS,
    );
  const LS = cp(0x2028);

  test("a quick-action line in the description is refused, however it is hidden", () => {
    for (const description of [
      "fix\n/close",
      `fix${LS}/close`,
      `/clo${ZWSP}se`,
      "&#47;close",
      `${FW_SLASH}assign @me`,
      `steps${LS}/assign @me`,
    ]) {
      expect(create({ description }), JSON.stringify(description)).toBe(
        GITLAB_QUICK_ACTION_REFUSAL,
      );
    }
  });

  test("the title is not scanned for quick actions: /api is down is allowed", () => {
    expect(create({ title: "/api is down" })).toBeUndefined();
    expect(create({ title: "/close" })).toBeUndefined();
  });

  test("and/or mid-line is allowed; an absent or null description is allowed; a number is refused", () => {
    expect(create({ description: "use and/or" })).toBeUndefined();
    expect(create({})).toBeUndefined();
    expect(create({ description: null })).toBeUndefined();
    expect(create({ description: 42 })).toBe(BROADCAST_MENTION_REFUSAL);
  });
});
