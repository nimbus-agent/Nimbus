import { describe, expect, test } from "bun:test";

import {
  beforeReaderArgsProblem,
  beforeReaderProblems,
  pickBeforeReaderArgs,
} from "./before-reader.ts";
import { CONNECTOR_WRITE_ROWS } from "./index.ts";
import {
  BEFORE_STATE_MAX_FIELDS,
  type BeforeStateReader,
  type ConnectorWriteRow,
  row,
  withBefore,
  withPreview,
} from "./types.ts";

// Synthetic rows only: no production row has a `before` reader in B0b (B1-B4 add them).
const PREVIEWED = withPreview(row("jira_issue_update", "jira.issue.update", "mesh", 2), {
  target: "{issueKey}",
  summary: "Update {issueKey}",
  fields: [{ key: "summary", label: "Summary", kind: "text" }],
});

const READER: BeforeStateReader = {
  tool: "jira_issue_get",
  argKeys: ["issueKey"],
  args: (input) => ({ issueKey: input["issueKey"] }),
  select: () => [{ label: "Summary", value: "old" }],
};

function synthetic(reader: BeforeStateReader, base: ConnectorWriteRow = PREVIEWED) {
  return { ...base, before: reader } as ConnectorWriteRow;
}

describe("BeforeStateReader (spec § 5.4)", () => {
  test("the field cap is 20", () => {
    expect(BEFORE_STATE_MAX_FIELDS).toBe(20);
  });

  test("withBefore freezes a valid reader onto a previewed row", () => {
    const r = withBefore(PREVIEWED, READER);
    expect(r.before).toBe(READER);
    expect(Object.isFrozen(r)).toBe(true);
    expect(beforeReaderProblems(r)).toEqual([]);
  });

  test("withBefore refuses a row without a typed preview", () => {
    expect(() =>
      withBefore(row("jira_issue_update", "jira.issue.update", "mesh", 2), READER),
    ).toThrow(/needs a typed preview/);
  });

  test("withBefore refuses an argKey the template does not name", () => {
    expect(() => withBefore(PREVIEWED, { ...READER, argKeys: ["issueKey", "projectKey"] })).toThrow(
      /projectKey/,
    );
  });

  test("withBefore refuses no argKeys and a duplicate argKey", () => {
    expect(() => withBefore(PREVIEWED, { ...READER, argKeys: [] })).toThrow(/at least one/);
    expect(() => withBefore(PREVIEWED, { ...READER, argKeys: ["issueKey", "issueKey"] })).toThrow(
      /duplicate/,
    );
  });

  test("a row without a reader has no problems", () => {
    expect(beforeReaderProblems(PREVIEWED)).toEqual([]);
  });

  test("argKeys must be a subset of the template's target and field keys", () => {
    const p = beforeReaderProblems(synthetic({ ...READER, argKeys: ["projectKey"] }));
    expect(p.join("\n")).toContain("projectKey");
  });

  test("the reader tool must be a read: a write verb, an unknown verb and a write id all fail", () => {
    for (const tool of ["jira_issue_update", "jira_issue_frobnicate", "jira_comment_add"]) {
      const p = beforeReaderProblems(synthetic({ ...READER, tool }));
      expect(p.some((x) => x.includes("not a read"))).toBe(true);
    }
  });

  test("a write id that ends in a read verb is refused (it is a write, whatever its name)", () => {
    const p = beforeReaderProblems(synthetic({ ...READER, tool: "jira_issue_get" }), {
      writeIds: new Set(["jira_issue_get"]),
    });
    expect(p.some((x) => x.includes("not a read"))).toBe(true);
  });

  test("args may read only argKeys: a Proxy throws on any other key", () => {
    const sneaky: BeforeStateReader = {
      ...READER,
      args: (input) => ({ issueKey: input["issueKey"], also: input["summary"] }),
    };
    expect(beforeReaderArgsProblem(sneaky)).toContain("summary");
    expect(beforeReaderProblems(synthetic(sneaky)).join("\n")).toContain("summary");
    // Enumerating the input counts: Object.keys sees argKeys only, so a spread is safe.
    const spread: BeforeStateReader = { ...READER, args: (input) => ({ ...input }) };
    expect(beforeReaderArgsProblem(spread)).toBeUndefined();
    expect(beforeReaderArgsProblem(READER)).toBeUndefined();
  });

  test("an `in` test counts like a read: an argKey passes, any other key is a problem", () => {
    const tests: BeforeStateReader = {
      ...READER,
      args: (input) => ("issueKey" in input ? { issueKey: input["issueKey"] } : undefined),
    };
    expect(beforeReaderArgsProblem(tests)).toBeUndefined();
    const stray: BeforeStateReader = {
      ...READER,
      args: (input) => ("summary" in input ? {} : { issueKey: input["issueKey"] }),
    };
    expect(beforeReaderArgsProblem(stray)).toContain("summary");
  });

  test("beforeReaderProblems also reports a missing preview, no argKeys and a duplicate", () => {
    const noPreview = {
      ...row("jira_issue_update", "jira.issue.update", "mesh", 2),
      before: READER,
    };
    const problems = (r: ConnectorWriteRow): string => beforeReaderProblems(r).join(" | ");
    expect(problems(noPreview)).toContain("needs a typed preview");
    expect(problems(synthetic({ ...READER, argKeys: [] }))).toContain("at least one argKey");
    expect(problems(synthetic({ ...READER, argKeys: ["issueKey", "issueKey"] }))).toContain(
      "duplicate argKey",
    );
  });

  test("a non-Error throw from args is reported by its string form", () => {
    const throwsString: BeforeStateReader = {
      ...READER,
      args: () => {
        throw "plain string";
      },
    };
    expect(beforeReaderArgsProblem(throwsString)).toContain("plain string");
  });

  test("args that throws on the probe is a problem, not a crash", () => {
    const throwing: BeforeStateReader = {
      ...READER,
      args: () => {
        throw new Error("boom");
      },
    };
    expect(beforeReaderArgsProblem(throwing)).toContain("boom");
  });

  test("pickBeforeReaderArgs hands args only the argKeys the input has", () => {
    const picked = pickBeforeReaderArgs(["issueKey", "absent"], {
      issueKey: "NIM-1",
      summary: "new",
    });
    expect(picked).toEqual({ issueKey: "NIM-1" });
    expect(Object.isFrozen(picked)).toBe(true);
    expect(Object.getPrototypeOf(picked)).toBeNull();
  });

  test("every production row's reader passes (vacuous in B0b: no row has one)", () => {
    const withReader = CONNECTOR_WRITE_ROWS.filter((r) => r.before !== undefined);
    expect(withReader).toEqual([]);
    for (const r of CONNECTOR_WRITE_ROWS) expect(beforeReaderProblems(r)).toEqual([]);
  });
});
