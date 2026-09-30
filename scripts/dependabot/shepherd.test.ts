import { describe, expect, test } from "bun:test";
import { summaryBody } from "./dependabot-body.ts";
import {
  ghCallsForPlan,
  parsePr,
  parsePrList,
  planForPr,
  planWrites,
  type ShepherdPr,
} from "./shepherd.ts";

const MINOR_BODY =
  "Updates `tauri` from 2.11.5 to 2.12.0\nUpdates `thiserror` from 2.0.20 to 2.0.21";
const MINOR_TITLE = "chore(deps): bump the cargo-all-minor-patch group with 2 updates";

const HEAD = "eb2ba8e16d61a33b5eca8117a15d52cb321d1f64";
// The shape `gh pr view --json autoMergeRequest` really returns, copied from #1582.
const BY_PERSON = { enabledAt: "2026-09-30T02:10:45Z", enabledBy: { is_bot: false, login: "a" } };
const BY_BOT = { enabledAt: "2026-09-30T02:10:45Z", enabledBy: { is_bot: true, login: "b" } };
const GROUP_OF_3 = "chore(deps): bump the cargo-all-minor-patch group with 3 updates";

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
    headRefOid: HEAD,
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
    const plan = planForPr(
      pr({ title: GROUP_OF_3, body: `${MINOR_BODY}\nUpdates \`log\` from 0.4.33 to 0.5.0` }),
    );
    expect(plan.enableAutoMerge).toBe(false);
    expect(plan.breaking.map((b) => b.name)).toEqual(["log"]);
  });

  test("a security-fix note on a breaking bump does not hide it from the group", () => {
    const body = `${MINOR_BODY}\nUpdates \`log\` from 0.4.33 to 0.5.0 **This update includes a security fix.**`;
    const plan = planForPr(pr({ title: GROUP_OF_3, body }));
    expect(plan.enableAutoMerge).toBe(false);
    expect(plan.breaking.map((b) => b.name)).toEqual(["log"]);
  });

  test.each([
    ["an Updates line with no from-version", "Updates `log` to 0.5.0", GROUP_OF_3],
    ["a removal", "Removes `log`", GROUP_OF_3],
    ["fewer bumps than the title announces", "", GROUP_OF_3],
    ["one name with two version changes", "Updates `tauri` from 0.4.33 to 0.5.0", MINOR_TITLE],
  ])(
    "a possibly partial list (%s): nothing is written and nothing is enqueued",
    (_l, extra, title) => {
      const plan = planForPr(pr({ title, body: `${MINOR_BODY}\n${extra}` }));
      expect(plan.newBody).toBeUndefined();
      expect(plan.enableAutoMerge).toBe(false);
      expect(plan.holdReason).toContain("may be partial");
      expect(planWrites(plan)).toBe(false);
    },
  );

  test("a PR that stops qualifying loses the auto-merge a BOT enabled, and keeps a person's", () => {
    const major = {
      title: "chore(deps): bump @mastra/mcp from 1.18.0 to 2.1.0",
      body: "Bumps [@mastra/mcp](u) from 1.18.0 to 2.1.0.",
    };
    expect(planForPr(pr({ ...major, autoMergeRequest: BY_BOT })).disableAutoMerge).toBe(true);
    expect(planForPr(pr({ ...major, autoMergeRequest: BY_PERSON })).disableAutoMerge).toBe(false);
    expect(planForPr(pr({ ...major, autoMergeRequest: null })).disableAutoMerge).toBe(false);
    const partial = { title: GROUP_OF_3, body: MINOR_BODY, autoMergeRequest: BY_BOT };
    expect(planForPr(pr(partial)).disableAutoMerge).toBe(true);
    // Still qualifying: a bot's request is exactly what the shepherd wants left alone.
    expect(planForPr(pr({ autoMergeRequest: BY_BOT })).disableAutoMerge).toBe(false);
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

describe("ghCallsForPlan", () => {
  const argsOf = (p: ShepherdPr) => ghCallsForPlan(planForPr(p), p, "o/r").map((c) => c.args);

  test("the description is written before auto-merge, and the merge is bound to the classified head", () => {
    const calls = ghCallsForPlan(planForPr(pr()), pr(), "o/r");
    expect(calls.map((c) => c.did)).toEqual(["summarised description", "enabled auto-merge"]);
    expect(calls[0]?.stdin).toBe(summaryBody(MINOR_TITLE, MINOR_BODY));
    const merge = calls[1]?.args ?? [];
    expect(merge).toContain("--auto");
    expect(merge[merge.indexOf("--match-head-commit") + 1]).toBe(HEAD);
  });

  test("a withdrawal comes first and is never paired with an enable", () => {
    const args = argsOf(
      pr({
        title: "chore(deps): bump @mastra/mcp from 1.18.0 to 2.1.0",
        body: "Bumps [@mastra/mcp](u) from 1.18.0 to 2.1.0.",
        autoMergeRequest: BY_BOT,
      }),
    );
    expect(args[0]).toContain("--disable-auto");
    expect(args.some((a) => a.includes("--auto"))).toBe(false);
  });

  test("nothing to do: no calls", () => {
    const settled = pr({
      body: summaryBody(MINOR_TITLE, MINOR_BODY) ?? "",
      autoMergeRequest: BY_BOT,
    });
    expect(argsOf(settled)).toEqual([]);
    expect(planWrites(planForPr(settled))).toBe(false);
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
  test("refuses a PR with no usable head commit — there would be nothing to bind the merge to", () => {
    for (const headRefOid of [undefined, "", "main", HEAD.slice(1)]) {
      expect(() => parsePrList(JSON.stringify([{ ...pr(), headRefOid }]))).toThrow(
        /unexpected shape/,
      );
      expect(() => parsePr(JSON.stringify({ ...pr(), headRefOid }))).toThrow(/unexpected shape/);
    }
    expect(parsePr(JSON.stringify(pr())).headRefOid).toBe(HEAD);
  });
});
