// Phase 9.7 C2: the refusals on the four pull request and merge request create and update rows,
// on BOTH doors (the model door's `modelWriteRefusal` and the act door's `actDoorRefusal`, which
// both run `messagingDestinationRefusal` first). Invisible characters are built with
// String.fromCodePoint: none is written literally.
import { describe, expect, test } from "bun:test";

import type { ChatopsPolicy } from "../../policy/types.ts";
import {
  actDoorRefusal,
  BROADCAST_MENTION_REFUSAL,
  GITLAB_QUICK_ACTION_REFUSAL,
  messagingDestinationRefusal,
  modelWriteRefusal,
  quickActionTextKeys,
  REMOTE_CONTENT_REFUSAL,
  remoteContentScannedKeys,
  scannedTextKeys,
} from "./model-write-refusals.ts";

const cp = (...points: number[]) => String.fromCodePoint(...points);
const ZWSP = cp(0x200b);
const FW_AT = cp(0xff20);
const FENCE = "\x60\x60\x60";

const NO_CHATOPS: ChatopsPolicy = { channels: new Map(), ownership: new Map() };
const ACT = { chatops: NO_CHATOPS, kb: undefined, kbUnreadable: false } as const;

/** The verdict through the shared check, the model door and the act door; they must agree. */
function verdict(toolId: string, input: Readonly<Record<string, unknown>>): string | undefined {
  const shared = messagingDestinationRefusal(toolId, input, { chatops: NO_CHATOPS });
  expect(modelWriteRefusal(toolId, input, { chatops: NO_CHATOPS, kb: undefined }), toolId).toBe(
    shared,
  );
  expect(actDoorRefusal(toolId, input, ACT), toolId).toBe(shared);
  return shared;
}

const GH_CREATE = { owner: "o", repo: "r", head: "feat", base: "main", title: "T" };
const GH_UPDATE = { owner: "o", repo: "r", pullNumber: 3 };
const GL_CREATE = { projectPath: "g/r", sourceBranch: "feat", targetBranch: "main", title: "T" };
const GL_UPDATE = { projectPath: "g/r", mergeRequestIid: 4 };

const GITHUB_ROWS: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ["github_pr_create", GH_CREATE],
  ["github_pr_update", GH_UPDATE],
];
const GITLAB_ROWS: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ["gitlab_mr_create", GL_CREATE],
  ["gitlab_mr_update", GL_UPDATE],
];
const ALL_ROWS = [...GITHUB_ROWS, ...GITLAB_ROWS];
const textKeyOf = (id: string): string => (id.startsWith("github") ? "body" : "description");

describe("C2: the broadcast mention on a PR / MR title and body or description, both doors", () => {
  test("GitHub: @org/team in the title or the body is refused (fullwidth and zero-width included)", () => {
    for (const [id, base] of GITHUB_ROWS) {
      for (const over of [
        { title: "ping @org/team" },
        { title: `ping ${FW_AT}org/team` },
        { body: "cc @org/team" },
        { body: `cc @org/${ZWSP}team` },
      ]) {
        expect(verdict(id, { ...base, ...over }), `${id} ${JSON.stringify(over)}`).toBe(
          BROADCAST_MENTION_REFUSAL,
        );
      }
    }
  });

  test("GitLab: @all or a group path in the title or the description is refused", () => {
    for (const [id, base] of GITLAB_ROWS) {
      for (const over of [
        { title: "@all look" },
        { title: "cc @grp/sub" },
        { description: "@all." },
        { description: "cc @grp/sub" },
      ]) {
        expect(verdict(id, { ...base, ...over }), `${id} ${JSON.stringify(over)}`).toBe(
          BROADCAST_MENTION_REFUSAL,
        );
      }
    }
  });

  test("a user mention, @allison and an empty body are allowed", () => {
    for (const [id, base] of ALL_ROWS) {
      expect(verdict(id, { ...base, title: "thanks @alice" }), id).toBeUndefined();
      expect(verdict(id, { ...base, [textKeyOf(id)]: "@allison" }), id).toBeUndefined();
      expect(verdict(id, { ...base, [textKeyOf(id)]: "" }), id).toBeUndefined();
    }
  });

  test("a present non-string title or text is refused; an absent update title is allowed", () => {
    for (const [id, base] of ALL_ROWS) {
      expect(verdict(id, { ...base, title: 7 }), id).toBe(BROADCAST_MENTION_REFUSAL);
      expect(verdict(id, { ...base, [textKeyOf(id)]: ["@all"] }), id).toBe(
        BROADCAST_MENTION_REFUSAL,
      );
    }
    expect(verdict("github_pr_update", GH_UPDATE)).toBeUndefined();
    expect(verdict("gitlab_mr_update", GL_UPDATE)).toBeUndefined();
    // A create requires its title.
    const { title: _t, ...noTitle } = GH_CREATE;
    expect(verdict("github_pr_create", noTitle)).toBe(BROADCAST_MENTION_REFUSAL);
  });
});

describe("C2: GitLab quick actions in an MR description, both doors", () => {
  const LS = cp(0x2028);
  test("a quick-action line in the description is refused, however it is hidden", () => {
    for (const [id, base] of GITLAB_ROWS) {
      for (const description of [
        "/merge",
        "  /assign @x",
        `/clo${ZWSP}se`,
        "fix\n/approve",
        `fix${LS}/close`,
        `${FENCE}\n/merge\n${FENCE}`,
      ]) {
        expect(verdict(id, { ...base, description }), `${id} ${JSON.stringify(description)}`).toBe(
          GITLAB_QUICK_ACTION_REFUSAL,
        );
      }
    }
  });

  test("and/or mid-line and a slash title are allowed (the title is not parsed)", () => {
    for (const [id, base] of GITLAB_ROWS) {
      expect(verdict(id, { ...base, description: "use and/or" }), id).toBeUndefined();
      expect(verdict(id, { ...base, title: "/api is down" }), id).toBeUndefined();
    }
  });

  test("the GitHub rows have no quick-action rule", () => {
    for (const [id, base] of GITHUB_ROWS) {
      expect(verdict(id, { ...base, body: "/merge" }), id).toBeUndefined();
    }
  });
});

describe("C2: forge Markdown remote content in a PR body / MR description, both doors", () => {
  test("an image of each kind is refused; a plain link and an absent key pass", () => {
    for (const [id, base] of ALL_ROWS) {
      const key = textKeyOf(id);
      for (const text of ["![x](https://evil/p.png)", "<img src=//h>", "![x][r]\n[r]: https://h"]) {
        expect(verdict(id, { ...base, [key]: text }), `${id} ${text}`).toBe(REMOTE_CONTENT_REFUSAL);
      }
      expect(verdict(id, { ...base, [key]: "see [doc](https://h)" }), id).toBeUndefined();
      expect(verdict(id, base), id).toBeUndefined();
    }
  });

  test("order is unchanged: a mention beside an image reports the mention", () => {
    expect(
      verdict("github_pr_update", { ...GH_UPDATE, body: "@org/team ![x](https://h/p.png)" }),
    ).toBe(BROADCAST_MENTION_REFUSAL);
  });
});

describe("C2: the tripwires name the new rows", () => {
  test("scanned keys", () => {
    expect(scannedTextKeys("github_pr_create")).toEqual(["title", "body"]);
    expect(scannedTextKeys("github_pr_update")).toEqual(["title", "body"]);
    expect(scannedTextKeys("gitlab_mr_create")).toEqual(["title", "description"]);
    expect(scannedTextKeys("gitlab_mr_update")).toEqual(["title", "description"]);
    expect(quickActionTextKeys("gitlab_mr_create")).toEqual(["description"]);
    expect(quickActionTextKeys("gitlab_mr_update")).toEqual(["description"]);
    expect(quickActionTextKeys("github_pr_create")).toEqual([]);
    expect(remoteContentScannedKeys("github_pr_create")).toEqual(["body"]);
    expect(remoteContentScannedKeys("github_pr_update")).toEqual(["body"]);
    expect(remoteContentScannedKeys("gitlab_mr_create")).toEqual(["description"]);
    expect(remoteContentScannedKeys("gitlab_mr_update")).toEqual(["description"]);
  });

  test("a branch create has no free-text field and is not scanned", () => {
    for (const id of ["github_branch_create", "gitlab_branch_create"]) {
      expect(scannedTextKeys(id), id).toEqual([]);
      expect(remoteContentScannedKeys(id), id).toEqual([]);
    }
  });

  test("the act door adds nothing for these rows: it equals the shared check on a hostile input", () => {
    for (const [id, base] of ALL_ROWS) {
      const hostile = {
        ...base,
        title: "@all",
        body: "/merge ![x](https://h/p)",
        description: "/merge",
      };
      expect(actDoorRefusal(id, hostile, ACT), id).toBe(
        messagingDestinationRefusal(id, hostile, { chatops: NO_CHATOPS }),
      );
    }
  });
});
