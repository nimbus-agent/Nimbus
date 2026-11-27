import { describe, expect, test } from "bun:test";

import {
  costReportToolFor,
  REPORT_BODY_FIELDS,
} from "../connectors/connector-writes/cost-report-rows.ts";
import { scopeOfStep } from "../standing/standing-rule-derive.ts";
import { parseWorkflowSteps, WorkflowStepsError, workflowStepsSha256 } from "./workflow-steps.ts";
import { buildWriteActions } from "./workflow-write-step.ts";

const REPORT = {
  kind: "report",
  label: "render",
  report: {
    name: "checkout-weekly",
    scope: { product: "checkout" },
    period: "week",
    tz: "Europe/Berlin",
    kind: "slack",
    format: "markdown",
    breakdown: "list",
    template: "Checkout: {total} ({change})",
    subject: null,
  },
};
const POST = {
  kind: "write",
  label: "post",
  tool: costReportToolFor("slack"),
  input: { channel: { const: "C0123ABC" }, text: { report: "render", part: "body" } },
};

function refusal(steps: unknown[]): string {
  try {
    parseWorkflowSteps(JSON.stringify(steps));
  } catch (e) {
    if (e instanceof WorkflowStepsError) return e.message;
    throw e;
  }
  throw new Error("expected a refusal");
}

const withReport = (over: Record<string, unknown>) => ({
  ...REPORT,
  report: { ...REPORT.report, ...over },
});

describe("REPORT_BODY_FIELDS", () => {
  test("names the body (and the subject of a draft) of each kind's row, and nothing else", () => {
    expect(Object.keys(REPORT_BODY_FIELDS).sort()).toEqual(
      (["gmail", "outlook", "slack", "teams"] as const).map(costReportToolFor).sort(),
    );
    expect(REPORT_BODY_FIELDS[costReportToolFor("slack")]).toEqual({ body: "text", subject: null });
    expect(REPORT_BODY_FIELDS[costReportToolFor("teams")]).toEqual({ body: "body", subject: null });
    expect(REPORT_BODY_FIELDS[costReportToolFor("gmail")]).toEqual({
      body: "body",
      subject: "subject",
    });
    expect(REPORT_BODY_FIELDS[costReportToolFor("outlook")]).toEqual({
      body: "body",
      subject: "subject",
    });
  });
});

describe("parseWorkflowSteps: the report step", () => {
  test("a report step and a write fed by it parse, and hash stably", () => {
    const steps = parseWorkflowSteps(JSON.stringify([REPORT, POST]));
    expect(steps.map((s) => s.kind)).toEqual(["report", "write"]);
    expect(steps[1]?.kind === "write" ? steps[1].input["text"] : undefined).toEqual({
      report: "render",
      part: "body",
    });
    expect(workflowStepsSha256(steps)).toBe(
      workflowStepsSha256(parseWorkflowSteps(JSON.stringify([REPORT, POST]))),
    );
    // The embedded template is part of the hash: a changed template is a different workflow.
    const changed = parseWorkflowSteps(
      JSON.stringify([withReport({ template: "Other {total}" }), POST]),
    );
    expect(workflowStepsSha256(changed)).not.toBe(workflowStepsSha256(steps));
  });

  test("the embedded report is validated like the cost config, and its template is parsed at save", () => {
    expect(refusal([withReport({ scope: {} }), POST])).toContain("scope must name at least one of");
    expect(refusal([withReport({ period: "year" }), POST])).toContain(
      "period must be week, month or <N>d",
    );
    expect(refusal([withReport({ tz: "Mars/Olympus" }), POST])).toContain(
      "tz must be an IANA time zone",
    );
    expect(refusal([withReport({ tz: undefined }), POST])).toContain(
      "tz must be an IANA time zone",
    );
    expect(refusal([withReport({ kind: "sms" }), POST])).toContain("kind must be one of");
    expect(refusal([withReport({ format: "html" }), POST])).toContain(
      "format html is not available for slack",
    );
    expect(refusal([withReport({ template: "Cost: {totl}" }), POST])).toContain(
      "unknown placeholder {totl}",
    );
    expect(refusal([withReport({ template: "Cost: {total" }), POST])).toContain("an unclosed {");
    expect(refusal([withReport({ template: "x".repeat(65_537) }), POST])).toContain(
      "template must be a string of 1 to 65536",
    );
    expect(refusal([withReport({ subject: "S" }), POST])).toContain(
      "subject is only for gmail and outlook",
    );
    expect(refusal([{ ...REPORT, extra: 1 }, POST])).toContain('unknown key "extra"');
    expect(refusal([{ ...REPORT, report: { ...REPORT.report, nope: 1 } }, POST])).toContain(
      'unknown key "nope"',
    );
    expect(refusal([{ ...REPORT, label: undefined }, POST])).toContain("a label is required");
  });

  test("a mail report's subject is one line with no list placeholder", () => {
    const mail = withReport({
      kind: "gmail",
      format: "text",
      subject: "Cost, week of {week_start}",
    });
    const draft = {
      kind: "write",
      tool: costReportToolFor("gmail"),
      input: {
        to: { const: "cfo@example.com" },
        subject: { report: "render", part: "subject" },
        body: { report: "render", part: "body" },
      },
    };
    expect(parseWorkflowSteps(JSON.stringify([mail, draft]))).toHaveLength(2);
    expect(
      refusal([withReport({ kind: "gmail", format: "text", subject: "Top {top_movers}" }), draft]),
    ).toContain("{top_movers} cannot be used in a subject");
    expect(
      refusal([withReport({ kind: "gmail", format: "text", subject: "a\nb" }), draft]),
    ).toContain("one line");
    expect(
      refusal([withReport({ kind: "gmail", format: "text", subject: null }), draft]),
    ).toContain("subject is required");
  });
});

describe("parseWorkflowSteps: the { report } value source", () => {
  const post = (input: Record<string, unknown>, tool = costReportToolFor("slack")) => ({
    kind: "write",
    tool,
    input,
  });

  test("must name an EARLIER report step, with a known part", () => {
    expect(refusal([POST, REPORT])).toContain(
      'report "render": it must name an earlier report step',
    );
    expect(
      refusal([REPORT, post({ channel: { const: "C1" }, text: { report: "nope", part: "body" } })]),
    ).toContain('report "nope": it must name an earlier report step');
    const query = {
      kind: "query",
      label: "q",
      query: {
        service: "slack",
        type: "message",
        where: [],
        select: "id",
        distinct: true,
        limit: 5,
      },
    };
    expect(
      refusal([query, post({ channel: { const: "C1" }, text: { report: "q", part: "body" } })]),
    ).toContain("it must name an earlier report step");
    expect(
      refusal([
        REPORT,
        post({ channel: { const: "C1" }, text: { report: "render", part: "footer" } }),
      ]),
    ).toContain("part must be body or subject");
    expect(
      refusal([
        REPORT,
        post({ channel: { const: "C1" }, text: { report: "render", part: "body", x: 1 } }),
      ]),
    ).toContain('unknown key "x"');
  });

  test("may fill only the body (and a draft's subject) of the report kind's own row", () => {
    // A destination or routing field can never take a report value.
    for (const field of ["channel", "thread_ts"]) {
      expect(
        refusal([
          REPORT,
          post({
            [field]: { report: "render", part: "body" },
            text: { report: "render", part: "body" },
          }),
        ]),
      ).toContain(`${field} cannot take a report value`);
    }
    expect(
      refusal([
        REPORT,
        post({ channel: { const: "C1" }, text: { report: "render", part: "subject" } }),
      ]),
    ).toContain("text cannot take the report subject");
    // A Slack report never feeds a Teams post.
    const teams = post(
      {
        teamId: { const: "t" },
        channelId: { const: "c" },
        body: { report: "render", part: "body" },
      },
      costReportToolFor("teams"),
    );
    expect(refusal([REPORT, teams])).toContain("a slack report feeds only the slack row");
    // A write fed by a report holds no query value.
    const query = {
      kind: "query",
      label: "q",
      query: {
        service: "slack",
        type: "message",
        where: [],
        select: "id",
        distinct: true,
        limit: 5,
      },
    };
    expect(
      refusal([
        query,
        REPORT,
        post({ channel: { from: "q", column: "id" }, text: { report: "render", part: "body" } }),
      ]),
    ).toContain("a write fed by a report step holds only constants besides it");
  });

  test("a workflow with a report step holds no run (model) step, and labels never collide", () => {
    expect(refusal([{ run: "summarise" }, REPORT, POST])).toContain(
      "a workflow with a report step can hold no run step",
    );
    expect(refusal([REPORT, { ...REPORT }, POST])).toContain('label "render" is already used');
  });
});

describe("no site reads a { report } value as a constant", () => {
  const steps = () => parseWorkflowSteps(JSON.stringify([REPORT, POST]));
  test("building the write's actions and deriving a rule scope refuse it until the report step fills it", () => {
    const parsed = steps();
    const write = parsed[1];
    if (write?.kind !== "write") throw new Error("fixture");
    const run = {
      workflowId: "w",
      workflowSha256: "h",
      stepIndex: 1,
      runId: "r",
      trigger: "schedule" as const,
      queries: new Map(),
    };
    // With no report output in this run, a report-fed write fails closed instead of posting anything.
    expect(() => buildWriteActions(write, run)).toThrow(
      'the report step "render" produced no body in this run',
    );
    const filled = buildWriteActions(write, {
      ...run,
      reports: new Map([["render", { index: 0, body: "B", subject: null }]]),
    });
    expect(filled[0]?.payload).toEqual({
      mcpToolId: costReportToolFor("slack"),
      input: { channel: "C0123ABC", text: "B" },
    });
    expect(() => scopeOfStep(write, parsed)).toThrow("a report value");
  });
});
