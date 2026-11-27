import { describe, expect, test } from "bun:test";

import type { CostReportChannelDef, CostReportDef } from "../config/cost-report-toml.ts";
import { costReportToolFor } from "../connectors/connector-writes/cost-report-rows.ts";
import { buildCostReportWorkflowSteps, costReportWorkflowName } from "./cost-report-workflow.ts";
import { parseWorkflowSteps } from "./workflow-steps.ts";

const DEF: CostReportDef = {
  name: "checkout-weekly",
  scope: { product: "checkout" },
  period: "week",
  schedule: null,
  tz: null,
  channels: [],
};
const ch = (over: Partial<CostReportChannelDef>): CostReportChannelDef => ({
  kind: "slack",
  to: "C0123ABC",
  format: "markdown",
  breakdown: "list",
  template: { inline: "x" },
  subject: null,
  ...over,
});

describe("buildCostReportWorkflowSteps", () => {
  test("slack: the channel is a constant, the text is the report body; the steps parse", () => {
    const steps = buildCostReportWorkflowSteps(DEF, ch({}), "Cost {total}", "Europe/Berlin");
    expect(steps[1]).toEqual({
      kind: "write",
      label: "post",
      tool: costReportToolFor("slack"),
      input: { channel: { const: "C0123ABC" }, text: { report: "render", part: "body" } },
    });
    expect((steps[0] as { report: { tz: string; template: string } }).report).toMatchObject({
      tz: "Europe/Berlin",
      template: "Cost {total}",
    });
    expect(parseWorkflowSteps(JSON.stringify(steps))).toHaveLength(2);
  });

  test("teams and outlook carry an explicit contentType constant: html only for an html body", () => {
    const teams = buildCostReportWorkflowSteps(
      DEF,
      ch({ kind: "teams", to: { team: "T", channel: "C" }, format: "html" }),
      "<p>{total}</p>",
      "UTC",
    );
    expect((teams[1] as { input: unknown }).input).toEqual({
      teamId: { const: "T" },
      channelId: { const: "C" },
      body: { report: "render", part: "body" },
      contentType: { const: "html" },
    });
    const outlook = buildCostReportWorkflowSteps(
      DEF,
      ch({
        kind: "outlook",
        to: ["a@example.com", "b@example.com"],
        format: "text",
        subject: "Cost",
      }),
      "{total}",
      "UTC",
    );
    expect((outlook[1] as { input: unknown }).input).toEqual({
      to: { const: "a@example.com, b@example.com" },
      subject: { report: "render", part: "subject" },
      body: { report: "render", part: "body" },
      contentType: { const: "text" },
    });
    for (const s of [teams, outlook]) expect(parseWorkflowSteps(JSON.stringify(s))).toHaveLength(2);
  });

  test("gmail: a draft with its subject from the report, no contentType", () => {
    const gmail = buildCostReportWorkflowSteps(
      DEF,
      ch({ kind: "gmail", to: "cfo@example.com", format: "text", subject: "Cost {week_start}" }),
      "{total}",
      "UTC",
    );
    expect((gmail[1] as { input: unknown }).input).toEqual({
      to: { const: "cfo@example.com" },
      subject: { report: "render", part: "subject" },
      body: { report: "render", part: "body" },
    });
  });

  test("the name is cost-<report>-<kind>", () => {
    expect(costReportWorkflowName("checkout-weekly", "slack")).toBe("cost-checkout-weekly-slack");
  });
});
