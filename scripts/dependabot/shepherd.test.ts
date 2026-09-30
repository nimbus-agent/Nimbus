import { describe, expect, test } from "bun:test";
import { summaryBody } from "./dependabot-body.ts";
import { parsePrList, planForPr, type ShepherdPr } from "./shepherd.ts";

const MINOR_BODY =
  "Updates `tauri` from 2.11.5 to 2.12.0\nUpdates `thiserror` from 2.0.20 to 2.0.21";
const MINOR_TITLE = "chore(deps): bump the cargo-all-minor-patch group with 2 updates";

function pr(overrides: Partial<ShepherdPr> = {}): ShepherdPr {
  return {
    number: 1579,
    title: MINOR_TITLE,
    body: MINOR_BODY,
    // The spelling `gh pr list --json author` really returns — GraphQL, not the REST `dependabot[bot]`.
    author: { login: "app/dependabot" },
    baseRefName: "main",
    isDraft: false,
    autoMergeRequest: null,
    ...overrides,
  };
}

describe("planForPr", () => {
  test("a non-breaking group: summarise the body and enable auto-merge", () => {
    const plan = planForPr(pr());
    expect(plan.newBody).toBe(summaryBody(MINOR_TITLE, MINOR_BODY));
    expect(plan.enableAutoMerge).toBe(true);
    expect(plan.holdReason).toBeUndefined();
  });

  test("already in the desired state: no writes at all", () => {
    const plan = planForPr(
      pr({
        body: summaryBody(MINOR_TITLE, MINOR_BODY) ?? "",
        autoMergeRequest: { enabledAt: "x" },
      }),
    );
    expect(plan.newBody).toBeUndefined();
    expect(plan.enableAutoMerge).toBe(false);
    expect(plan.holdReason).toBeUndefined();
  });

  test("a major bump: still summarised, but auto-merge is withheld and the reason names the bump", () => {
    const plan = planForPr(
      pr({
        title: "chore(deps): bump @mastra/mcp from 1.18.0 to 2.1.0",
        body: "Bumps [@mastra/mcp](u) from 1.18.0 to 2.1.0.",
      }),
    );
    expect(plan.newBody).toBeDefined();
    expect(plan.enableAutoMerge).toBe(false);
    expect(plan.holdReason).toContain("@mastra/mcp 1.18.0 -> 2.1.0");
  });

  test("one breaking bump in a group holds the whole group", () => {
    const plan = planForPr(pr({ body: `${MINOR_BODY}\nUpdates \`log\` from 0.4.33 to 0.5.0` }));
    expect(plan.enableAutoMerge).toBe(false);
    expect(plan.breaking.map((b) => b.name)).toEqual(["log"]);
  });

  test.each([
    ["not Dependabot", { author: { login: "someone" } }, "not authored by Dependabot"],
    ["another base", { baseRefName: "develop" }, "targets develop"],
    ["a draft", { isDraft: true }, "draft"],
    ["unreadable", { title: "chore: x", body: "free text" }, "no dependency bump"],
  ] as const)("leaves %s entirely alone", (_label, overrides, reason) => {
    const plan = planForPr(pr(overrides));
    expect(plan.newBody).toBeUndefined();
    expect(plan.enableAutoMerge).toBe(false);
    expect(plan.holdReason).toContain(reason);
  });
});

describe("parsePrList", () => {
  test("accepts gh's shape", () => {
    expect(parsePrList(JSON.stringify([pr()]))).toHaveLength(1);
  });
  test("refuses anything else rather than acting on it", () => {
    expect(() => parsePrList(JSON.stringify({ number: 1 }))).toThrow(/unexpected shape/);
    expect(() => parsePrList(JSON.stringify([{ number: 1, title: "t" }]))).toThrow(
      /unexpected shape/,
    );
  });
});
