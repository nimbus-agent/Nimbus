// Owner ruling OR-B2-2 (plan R5): a GitLab scoped label (`key::value`) REPLACES the issue's label
// with the same key, so the model may not add one, on either door (the rule runs inside
// `messagingDestinationRefusal`). Invisible and fullwidth characters are built with
// String.fromCodePoint: none is written literally.
import { describe, expect, test } from "bun:test";

import {
  GITLAB_SCOPED_LABEL_REFUSAL,
  gitlabScopedLabelIn,
  messagingDestinationRefusal,
  modelWriteRefusal,
} from "./model-write-refusals.ts";

const cp = (...points: number[]) => String.fromCodePoint(...points);
const ZWSP = cp(0x200b);
const WJ = cp(0x2060);
const FW_COLON = cp(0xff1a);
const SMALL_COLON = cp(0xfe55);

const SCOPED: readonly string[] = [
  "prio::high",
  `prio${FW_COLON}${FW_COLON}high`,
  `prio:${FW_COLON}high`,
  `prio:${ZWSP}:high`,
  `prio:${WJ}:high`,
  `prio${SMALL_COLON}${SMALL_COLON}high`,
  "prio::",
  "::x",
  "&#58;&#58;",
];
const PLAIN: readonly string[] = ["prio:high", "a:b", "bug", "a: :b", "x:y:z"];

describe("gitlabScopedLabelIn", () => {
  test("a scoped label is caught however its colons are written", () => {
    for (const l of SCOPED) expect(gitlabScopedLabelIn(l), JSON.stringify(l)).toBe(true);
  });
  test("a plain label is not", () => {
    for (const l of PLAIN) expect(gitlabScopedLabelIn(l), l).toBe(false);
  });
});

describe("the scoped-label refusal on the rows (both doors)", () => {
  const NO_CHATOPS = { chatops: undefined } as const;
  const add = (labels: unknown) =>
    messagingDestinationRefusal(
      "gitlab_issue_labels_add",
      { projectPath: "g/r", issueIid: 7, labels },
      NO_CHATOPS,
    );
  const create = (over: Record<string, unknown>) =>
    messagingDestinationRefusal(
      "gitlab_issue_create",
      { projectPath: "g/r", title: "Bug", ...over },
      NO_CHATOPS,
    );

  test("labels add: one scoped label in the list refuses the whole write", () => {
    for (const l of SCOPED) {
      expect(add(["bug", l]), JSON.stringify(l)).toBe(GITLAB_SCOPED_LABEL_REFUSAL);
    }
  });

  test("issue create: a scoped label in labels refuses it", () => {
    expect(create({ labels: ["prio::high"] })).toBe(GITLAB_SCOPED_LABEL_REFUSAL);
    expect(create({ labels: [`priority${FW_COLON}${FW_COLON}low`] })).toBe(
      GITLAB_SCOPED_LABEL_REFUSAL,
    );
  });

  test("plain labels are allowed on both rows", () => {
    expect(add([...PLAIN])).toBeUndefined();
    expect(create({ labels: [...PLAIN] })).toBeUndefined();
  });

  test("a labels value that is not an array of strings is refused; an unset optional one is allowed", () => {
    for (const bad of ["prio::high", "bug", 7, { 0: "bug" }, ["bug", 7], [null], undefined, null]) {
      expect(add(bad), JSON.stringify(bad)).toBe(GITLAB_SCOPED_LABEL_REFUSAL);
    }
    expect(
      messagingDestinationRefusal(
        "gitlab_issue_labels_add",
        { projectPath: "g/r", issueIid: 7 },
        NO_CHATOPS,
      ),
    ).toBe(GITLAB_SCOPED_LABEL_REFUSAL);
    expect(create({})).toBeUndefined();
    expect(create({ labels: null })).toBeUndefined();
    expect(create({ labels: "bug" })).toBe(GITLAB_SCOPED_LABEL_REFUSAL);
    expect(create({ labels: [1] })).toBe(GITLAB_SCOPED_LABEL_REFUSAL);
  });

  test("the model door gets it through modelWriteRefusal; GitHub labels are not GitLab ones", () => {
    expect(
      modelWriteRefusal(
        "gitlab_issue_labels_add",
        { projectPath: "g/r", issueIid: 7, labels: ["prio::high"] },
        { chatops: undefined, kb: undefined },
      ),
    ).toBe(GITLAB_SCOPED_LABEL_REFUSAL);
    expect(
      messagingDestinationRefusal(
        "github_issue_labels_add",
        { owner: "o", repo: "r", issueNumber: 1, labels: ["prio::high"] },
        NO_CHATOPS,
      ),
    ).toBeUndefined();
  });

  test("the refusal is fixed text that echoes nothing", () => {
    expect(GITLAB_SCOPED_LABEL_REFUSAL).toBe(
      "the model cannot add a GitLab scoped label (key::value): it replaces the label with the same key; ask the owner to add it",
    );
  });
});
