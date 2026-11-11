// Phase 10 SA2 (spec § 4 item 2, § 5.4): the workflow step parser and validator.
import { describe, expect, test } from "bun:test";

import {
  isSelectableColumn,
  needsModel,
  nonRunStepLabels,
  parseDeclaredQuery,
  parseWorkflowSteps,
  stepsSaveRefusal,
  type WorkflowStep,
  WorkflowStepsError,
  workflowStepsSha256,
} from "./workflow-steps.ts";

const QUERY = {
  service: "gmail",
  type: "email",
  where: [
    { metadata: "labelIds", notContains: "UNREAD" },
    { metadata: "labelIds", contains: "INBOX" },
    { olderThanDays: 60 },
  ],
  select: "metadata.threadId",
  distinct: true,
  limit: 200,
};

function qStep(label = "old-mail", query: unknown = QUERY): Record<string, unknown> {
  return { kind: "query", label, query };
}
function wStep(input: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { kind: "write", tool: "gmail_thread_archive", input, ...extra };
}
const FROM_OLD = { from: "old-mail", column: "metadata.threadId" };

function parse(steps: unknown[]): WorkflowStep[] {
  return parseWorkflowSteps(JSON.stringify(steps));
}
function refusal(steps: unknown[]): string {
  try {
    parse(steps);
  } catch (e) {
    expect(e).toBeInstanceOf(WorkflowStepsError);
    return (e as Error).message;
  }
  throw new Error("expected a refusal");
}

describe("legacy run steps parse as before", () => {
  test("kind is optional; unknown keys and rows without a run string are ignored", () => {
    expect(
      parse([
        { run: "a", extra: 1 },
        { kind: "run", label: " L ", run: " b ", continue_on_error: true },
        { run: "" },
        { label: "x" },
        null,
        "nope",
        7,
      ]),
    ).toEqual([
      { kind: "run", run: "a" },
      { kind: "run", label: "L", run: "b", continueOnError: true },
    ]);
  });
  test("the old failures keep their old errors (and are not WorkflowStepsError)", () => {
    expect(() => parseWorkflowSteps("{")).toThrow(/not valid JSON/);
    expect(() => parseWorkflowSteps("{}")).toThrow(/JSON array/);
    expect(() => parseWorkflowSteps("[]")).toThrow(/no executable steps/);
    try {
      parseWorkflowSteps("[]");
    } catch (e) {
      expect(e).not.toBeInstanceOf(WorkflowStepsError);
    }
  });
});

describe("a query and a write", () => {
  test("parse into the closed forms", () => {
    const steps = parse([qStep(), wStep({ threadId: FROM_OLD })]);
    expect(steps[0]).toEqual({
      kind: "query",
      label: "old-mail",
      query: QUERY,
    });
    expect(steps[1]).toEqual({
      kind: "write",
      tool: "gmail_thread_archive",
      input: { threadId: FROM_OLD },
    });
    expect(needsModel(steps)).toBe(false);
    expect(needsModel([...steps, { kind: "run", run: "x" }])).toBe(true);
  });

  test("a write may hold only constants, and carries continueOnError", () => {
    const steps = parse([
      wStep({ threadId: { const: "abc" } }, { label: "one", continueOnError: true }),
    ]);
    expect(steps[0]).toMatchObject({ kind: "write", label: "one", continueOnError: true });
    expect(
      (
        parse([wStep({ threadId: { const: "a" } }, { continue_on_error: true })])[0] as {
          continueOnError?: boolean;
        }
      ).continueOnError,
    ).toBe(true);
  });

  test("a mixed run, query and write workflow parses (the write cannot read the run)", () => {
    expect(
      parse([{ run: "summarise" }, qStep(), wStep({ threadId: FROM_OLD })]).map((s) => s.kind),
    ).toEqual(["run", "query", "write"]);
  });

  test("a constant may be any JSON value of bounded depth", () => {
    const steps = parse([wStep({ threadId: { const: { a: [1, "b", null, true, { c: 2 }] } } })]);
    expect(steps[0]?.kind).toBe("write");
  });
});

describe("every refusal", () => {
  test("an unknown kind", () => {
    expect(refusal([{ kind: "wirte", tool: "x" }])).toContain("kind must be run, query or write");
  });
  test("an unknown key on a query row, a query, a write, a value", () => {
    expect(refusal([{ ...qStep(), oops: 1 }])).toContain('unknown key "oops"');
    expect(refusal([qStep("q", { ...QUERY, offset: 3 })])).toContain('unknown key "offset"');
    expect(refusal([wStep({ threadId: { const: "a" } }, { dryrun: true })])).toContain(
      'unknown key "dryrun"',
    );
    expect(refusal([wStep({ threadId: { const: "a", from: "q" } })])).toContain(
      'unknown key "from"',
    );
    expect(refusal([qStep(), wStep({ threadId: { ...FROM_OLD, extra: 1 } })])).toContain(
      'unknown key "extra"',
    );
    expect(refusal([qStep("q", { ...QUERY, where: [{ olderThanDays: 1, other: 2 }] })])).toContain(
      'unknown key "other"',
    );
  });
  test("a write names a tool that is not a connector write, or not wave 2 or 3, or never offered, or bound", () => {
    expect(refusal([wStep({}, { tool: "gmail_thread_read" })])).toContain(
      "not a connector write tool",
    );
    expect(refusal([{ kind: "write", input: {} }])).toContain("tool must be");
    expect(refusal([wStep({}, { tool: "github_pr_merge" })])).toContain("wave 4");
    expect(refusal([wStep({}, { tool: "gmail_message_send" })])).toContain(
      "never run by an automatic",
    );
    expect(refusal([wStep({}, { tool: "github_commit_prepare" })])).toContain(
      "not a connector write tool",
    );
    expect(refusal([wStep({}, { tool: "iac_terraform_apply" })])).toMatch(
      /wave 4|cannot run as a workflow/,
    );
  });
  test("a write step may not name a bound or refused row at any wave", () => {
    // A bound row is wave 4 in production; the rule is still checked by its own clause.
    expect(refusal([wStep({}, { tool: "github_file_commit" })])).toMatch(/wave 4|cannot run/);
    expect(refusal([wStep({}, { tool: "iac_pulumi_up" })])).toMatch(/wave 4|never run|cannot run/);
  });
  test("a from naming a run step, a later query, an unknown label, or itself", () => {
    expect(
      refusal([{ kind: "run", label: "old-mail", run: "x" }, wStep({ threadId: FROM_OLD })]),
    ).toContain("can never read a run step");
    expect(refusal([wStep({ threadId: FROM_OLD }), qStep()])).toContain("earlier query");
    expect(refusal([wStep({ threadId: { from: "nope", column: "id" } })])).toContain(
      "earlier query",
    );
  });
  test("a column that is not what the query selects", () => {
    expect(refusal([qStep(), wStep({ threadId: { from: "old-mail", column: "id" } })])).toContain(
      "is not what query",
    );
  });
  test("two different queries in one write", () => {
    expect(
      refusal([
        qStep("a"),
        qStep("b"),
        wStep({
          x: { from: "a", column: "metadata.threadId" },
          y: { from: "b", column: "metadata.threadId" },
        }),
      ]),
    ).toContain("only one query");
  });
  test("a duplicate query label, or a write label colliding with a query's", () => {
    expect(refusal([qStep("a"), qStep("a")])).toContain("already used");
    expect(refusal([qStep("a"), wStep({ threadId: { const: "x" } }, { label: "a" })])).toContain(
      "is a query step's label",
    );
    expect(refusal([{ kind: "run", label: "a", run: "x" }, qStep("a")])).toContain("already used");
  });
  test("a query without a label, with a blank label, or a label that is not a string", () => {
    expect(refusal([{ kind: "query", query: QUERY }])).toContain("a label is required");
    expect(refusal([qStep("   ")])).toContain("non-empty string");
    expect(refusal([{ ...qStep(), label: 4 }])).toContain("non-empty string");
  });
  test("write input shape: not an object, a bad field name, a bad value, too many fields", () => {
    expect(refusal([{ kind: "write", tool: "gmail_thread_archive", input: [] }])).toContain(
      "input must be",
    );
    expect(refusal([wStep({ "bad key": { const: "a" } })])).toContain(
      "not a plain input field name",
    );
    expect(refusal([wStep({ threadId: "raw" })])).toContain("input.threadId must be");
    expect(refusal([wStep({ threadId: { from: "", column: "id" } })])).toContain("needs a from");
    expect(refusal([wStep({ threadId: { from: "q" } })])).toContain("needs a from");
    const many = Object.fromEntries(
      Array.from({ length: 33 }, (_, i) => [`f${String(i)}`, { const: 1 }]),
    );
    expect(refusal([wStep(many)])).toContain("more than 32 fields");
  });
  test("a constant that is not JSON, is too deep, too large, non-finite, or holds a forbidden key", () => {
    const deep = { const: [[[[[[[[1]]]]]]]] };
    expect(refusal([wStep({ threadId: deep })])).toContain("nested too deeply");
    expect(refusal([wStep({ threadId: { const: "x".repeat(9000) } })])).toContain("larger than");
    // JSON cannot carry NaN or undefined, so build the step as an object and stringify by hand.
    const proto = JSON.parse(
      '[{"kind":"write","tool":"gmail_thread_archive","input":{"threadId":{"const":{"__proto__":1}}}}]',
    );
    expect(() => parseWorkflowSteps(JSON.stringify(proto))).toThrow(/may not hold the key/);
    expect(refusal([wStep({ __proto__x: { const: 1 } })])).toContain("plain input field name");
  });
  test("__proto__ as a field name is refused", () => {
    const text =
      '[{"kind":"write","tool":"gmail_thread_archive","input":{"__proto__":{"const":1}}}]';
    expect(() => parseWorkflowSteps(text)).toThrow(/plain input field name/);
  });
});

describe("the declared query", () => {
  const q = (over: Record<string, unknown>): unknown => ({ ...QUERY, ...over });
  const bad = (over: Record<string, unknown>): string => refusal([qStep("q", q(over))]);

  test("limit is required and at most 500", () => {
    expect(bad({ limit: undefined })).toContain("limit is required");
    expect(bad({ limit: 0 })).toContain("limit is required");
    expect(bad({ limit: 501 })).toContain("limit is required");
    expect(bad({ limit: 2.5 })).toContain("limit is required");
    expect(bad({ limit: "5" })).toContain("limit is required");
    expect(parseDeclaredQuery(q({ limit: 500 }), "q").limit).toBe(500);
  });
  test("service and type are plain", () => {
    expect(bad({ service: "gm ail" })).toContain("service must be");
    expect(bad({ service: 3 })).toContain("service must be");
    expect(bad({ type: "" })).toContain("type must be");
  });
  test("select: an id, an external id or a plain metadata key; never free text or a path", () => {
    for (const select of [
      "title",
      "body_preview",
      "metadata.a.b",
      "metadata.",
      "metadata.1x",
      "metadata.a'b",
      "$.x",
      3,
    ]) {
      expect(bad({ select }), String(select)).toContain("select must be");
    }
    for (const select of ["id", "external_id", "metadata.threadId", "metadata.a_1"]) {
      expect(isSelectableColumn(select)).toBe(true);
    }
    expect(isSelectableColumn("metadata.x; DROP TABLE item")).toBe(false);
  });
  test("a metadata key in a predicate is validated (an injection attempt is refused)", () => {
    for (const metadata of ["labelIds') OR 1=1 --", "a.b", "", "1a", "a b", 5]) {
      expect(bad({ where: [{ metadata, contains: "x" }] }), String(metadata)).toContain(
        "metadata must be a plain key",
      );
    }
  });
  test("predicate shape: one operator, the right value types, bounded days", () => {
    expect(bad({ where: [{ metadata: "k" }] })).toContain("exactly one of");
    expect(bad({ where: [{ metadata: "k", contains: "a", equals: "b" }] })).toContain(
      "exactly one of",
    );
    expect(bad({ where: [{ metadata: "k", contains: "" }] })).toContain(
      "non-empty string constant",
    );
    expect(bad({ where: [{ metadata: "k", notContains: 3 }] })).toContain(
      "non-empty string constant",
    );
    expect(bad({ where: [{ metadata: "k", equals: null }] })).toContain("equals must be");
    expect(bad({ where: [{ metadata: "k", equals: Number.NaN }] })).toContain("equals must be");
    expect(bad({ where: [{ olderThanDays: -1 }] })).toContain("integer from 0");
    expect(bad({ where: [{ newerThanDays: 1.5 }] })).toContain("integer from 0");
    expect(bad({ where: [{ olderThanDays: 99999 }] })).toContain("integer from 0");
    expect(bad({ where: ["x"] })).toContain("must be an object");
    expect(bad({ where: "x" })).toContain("list of at most");
    expect(bad({ where: Array.from({ length: 9 }, () => ({ olderThanDays: 1 })) })).toContain(
      "list of at most 8",
    );
  });
  test("every allowed predicate parses; where may be omitted; distinct defaults to false", () => {
    const parsed = parseDeclaredQuery(
      q({
        distinct: undefined,
        where: [
          { metadata: "k", equals: "s" },
          { metadata: "k", equals: 3 },
          { metadata: "k", equals: true },
          { newerThanDays: 2 },
        ],
      }),
      "q",
    );
    expect(parsed.distinct).toBe(false);
    expect(parsed.where).toHaveLength(4);
    expect(parseDeclaredQuery(q({ where: undefined }), "q").where).toEqual([]);
  });
  test("distinct must be a boolean; the query must be an object", () => {
    expect(bad({ distinct: "yes" })).toContain("distinct must be");
    expect(refusal([qStep("q", "SELECT 1")])).toContain("query must be an object");
  });
});

describe("hash, labels and the save check", () => {
  test("the hash is stable across key order and changes with one byte of the steps", () => {
    const a = parse([qStep(), wStep({ threadId: FROM_OLD })]);
    const reordered = parseWorkflowSteps(
      JSON.stringify([
        {
          query: {
            limit: 200,
            select: "metadata.threadId",
            ...{ service: "gmail", type: "email" },
            where: QUERY.where,
            distinct: true,
          },
          label: "old-mail",
          kind: "query",
        },
        {
          input: { threadId: { column: "metadata.threadId", from: "old-mail" } },
          tool: "gmail_thread_archive",
          kind: "write",
        },
      ]),
    );
    expect(workflowStepsSha256(a)).toBe(workflowStepsSha256(reordered));
    expect(workflowStepsSha256(a)).toMatch(/^[0-9a-f]{64}$/);
    const changed = parse([
      qStep("old-mail", { ...QUERY, limit: 201 }),
      wStep({ threadId: FROM_OLD }),
    ]);
    expect(workflowStepsSha256(changed)).not.toBe(workflowStepsSha256(a));
    const changedTool = parse([qStep(), wStep({ threadId: { ...FROM_OLD } }, { label: "z" })]);
    expect(workflowStepsSha256(changedTool)).not.toBe(workflowStepsSha256(a));
  });
  test("the hash of a run step sees an undefined label as absent", () => {
    expect(workflowStepsSha256(parse([{ run: "x" }]))).toBe(
      workflowStepsSha256(parse([{ run: "x", label: "" }])),
    );
  });
  test("nonRunStepLabels names write and query steps, defaults included", () => {
    const steps = parse([
      { label: "r", run: "x" },
      qStep(),
      wStep({ threadId: FROM_OLD }),
      wStep({ threadId: { const: "a" } }, { label: "named" }),
    ]);
    expect(nonRunStepLabels(steps)).toEqual(["old-mail", "step-3", "named"]);
  });
  test("stepsSaveRefusal: a strict violation is a message; run-only JSON, bad JSON and an empty list save as before", () => {
    expect(stepsSaveRefusal(JSON.stringify([wStep({ threadId: "raw" })]))).toContain(
      "input.threadId",
    );
    expect(stepsSaveRefusal(JSON.stringify([{ run: "a" }]))).toBeUndefined();
    expect(stepsSaveRefusal("{")).toBeUndefined();
    expect(stepsSaveRefusal("[]")).toBeUndefined();
    expect(
      stepsSaveRefusal(JSON.stringify([qStep(), wStep({ threadId: FROM_OLD })])),
    ).toBeUndefined();
  });
});
