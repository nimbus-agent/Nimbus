import { describe, expect, test } from "bun:test";

import { selectNotionPageIdentity } from "./knowledge.ts";
import { selectGitlabMrIdentity, VCS_CI_ROWS } from "./vcs-ci.ts";

describe("selectGitlabMrIdentity", () => {
  test("shows the title, the state and the branches, never the body", () => {
    const fields = selectGitlabMrIdentity({
      title: "Fix the thing",
      state: "opened",
      source_branch: "fix",
      target_branch: "main",
      description: "SECRET BODY",
    });
    expect(fields).toEqual([
      { label: "Title", value: "Fix the thing" },
      { label: "State", value: "opened" },
      { label: "Branches", value: "fix -> main" },
    ]);
  });

  test("names the branches only when both are known", () => {
    const fields = selectGitlabMrIdentity({ title: "T", source_branch: "fix" });
    expect(fields).toEqual([{ label: "Title", value: "T" }]);
  });

  test("a reply without a title throws so the prompt reads unavailable", () => {
    expect(() => selectGitlabMrIdentity({ state: "opened" })).toThrow();
  });

  test("the MR comment row reads the MR with exactly its project and iid", () => {
    const row = VCS_CI_ROWS.find((r) => r.before?.select === selectGitlabMrIdentity);
    expect(
      row?.before?.args({ projectPath: "g/p", mergeRequestIid: 7, body: "not sent to the read" }),
    ).toEqual({ projectPath: "g/p", mergeRequestIid: 7 });
  });
});

describe("selectNotionPageIdentity", () => {
  const page = (properties: unknown): unknown => ({ page: { properties } });

  test("joins the plain text of the first title property", () => {
    const fields = selectNotionPageIdentity(
      page({
        Status: { type: "select" },
        Name: { type: "title", title: [{ plain_text: "Roadmap " }, { plain_text: "2026" }] },
      }),
    );
    expect(fields).toEqual([{ label: "Title", value: "Roadmap 2026" }]);
  });

  test.each([
    ["no properties", {}],
    ["no title property", page({ Status: { type: "select" } })],
    ["a title that is not a list", page({ Name: { type: "title", title: "x" } })],
    ["an empty title", page({ Name: { type: "title", title: [{ plain_text: "" }] } })],
    ["a title property without a title key", page({ Name: { type: "title" } })],
    ["an array of properties", page([{ type: "title" }])],
  ])("%s is refused rather than shown as an empty title", (_n, reply) => {
    expect(() => selectNotionPageIdentity(reply)).toThrow("no Notion page title");
  });
});
