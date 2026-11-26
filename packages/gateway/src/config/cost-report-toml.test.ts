import { describe, expect, test } from "bun:test";

import {
  COST_MAX_REPORT_CHANNELS,
  COST_MAX_REPORTS,
  CostReportConfigError,
  compileCostReports,
} from "./cost-report-toml.ts";

const REPORT = { name: "checkout-weekly", scope: { product: "checkout" }, period: "week" };
const SLACK = {
  report: "checkout-weekly",
  kind: "slack",
  to: "C0123ABC",
  format: "markdown",
  template: "Checkout: {total}",
};

function refused(reports: unknown[], channels: unknown[]): string {
  try {
    compileCostReports(reports as Record<string, unknown>[], channels as Record<string, unknown>[]);
  } catch (e) {
    if (e instanceof CostReportConfigError) return e.message;
    throw e;
  }
  throw new Error("expected a refusal");
}

describe("compileCostReports", () => {
  test("a report with a Slack and an Outlook channel compiles with defaults", () => {
    const [r] = compileCostReports(
      [{ ...REPORT, schedule: "0 8 * * 1", tz: "Europe/Berlin" }],
      [
        SLACK,
        {
          report: "checkout-weekly",
          kind: "outlook",
          to: "cfo@example.com",
          format: "html",
          template_file: "checkout-weekly.html",
          subject: "Checkout cost, week of {week_start}",
        },
      ],
    );
    expect(r).toEqual({
      name: "checkout-weekly",
      scope: { product: "checkout" },
      period: "week",
      schedule: "0 8 * * 1",
      tz: "Europe/Berlin",
      channels: [
        {
          kind: "slack",
          to: "C0123ABC",
          format: "markdown",
          breakdown: "list",
          template: { inline: "Checkout: {total}" },
          subject: null,
        },
        {
          kind: "outlook",
          to: ["cfo@example.com"],
          format: "html",
          breakdown: "list",
          template: { file: "checkout-weekly.html" },
          subject: "Checkout cost, week of {week_start}",
        },
      ],
    });
  });

  test("a report may have no channel; schedule and tz are optional", () => {
    expect(compileCostReports([REPORT], [])).toEqual([
      { ...REPORT, schedule: null, tz: null, channels: [] },
    ]);
  });

  test("report fields are validated", () => {
    expect(refused([{ ...REPORT, nope: 1 }], [])).toBe('[[cost.report]] 1: unknown key "nope"');
    expect(refused([{ ...REPORT, name: "Bad Name" }], [])).toContain("name must be");
    expect(refused([REPORT, REPORT], [])).toBe(
      '[[cost.report]] 2: the name "checkout-weekly" is already used',
    );
    expect(refused([{ ...REPORT, scope: {} }], [])).toContain("scope must name at least one of");
    expect(refused([{ ...REPORT, scope: { team: "x" } }], [])).toContain(
      'unknown scope key "team"',
    );
    expect(refused([{ ...REPORT, scope: { product: "<!here>" } }], [])).toContain("scope.product");
    for (const period of ["year", "0d", "401d", "7", ""]) {
      expect(refused([{ ...REPORT, period }], [])).toContain("period must be week, month or <N>d");
    }
    expect(refused([{ ...REPORT, tz: "Mars/Olympus" }], [])).toContain("tz must be an IANA");
    expect(refused([{ ...REPORT, schedule: "not cron" }], [])).toContain("schedule");
  });

  test("channel fields are validated per kind", () => {
    const one = (over: Record<string, unknown>) => refused([REPORT], [{ ...SLACK, ...over }]);
    expect(one({ extra: true })).toBe('[[cost.report.channel]] 1: unknown key "extra"');
    expect(one({ report: "missing" })).toBe(
      '[[cost.report.channel]] 1: no [[cost.report]] is named "missing"',
    );
    expect(refused([REPORT], [SLACK, SLACK])).toBe(
      '[[cost.report.channel]] 2: report "checkout-weekly" already has a slack channel',
    );
    expect(one({ kind: "sms" })).toContain("kind must be one of slack, teams, gmail, outlook");
    expect(one({ format: "html" })).toContain("format html is not available for slack");
    expect(one({ to: "general" })).toContain("a Slack channel id");
    expect(one({ template_file: "x.md" })).toContain("exactly one of template or template_file");
    expect(one({ template: undefined })).toContain("exactly one of template or template_file");
    expect(one({ subject: "Hi" })).toContain("subject is only for gmail and outlook");
    expect(one({ breakdown: "table" })).toContain("breakdown must be list or csv");
    expect(one({ template: "a\u0000b" })).toContain("template holds a control character");
    const teams = { report: "checkout-weekly", kind: "teams", format: "text", template: "x" };
    expect(refused([REPORT], [{ ...teams, to: "C0123ABC" }])).toContain("{ team, channel }");
    expect(
      compileCostReports([REPORT], [{ ...teams, to: { team: "t1", channel: "c1" } }])[0]
        ?.channels[0]?.to,
    ).toEqual({
      team: "t1",
      channel: "c1",
    });
    const mail = {
      report: "checkout-weekly",
      kind: "gmail",
      format: "text",
      template: "x",
      to: "a@b.co",
    };
    expect(refused([REPORT], [{ ...mail, subject: undefined }])).toContain("subject is required");
    expect(refused([REPORT], [{ ...mail, subject: "Cost\r\nBcc: x@y.z" }])).toContain(
      "subject must be one line",
    );
    expect(refused([REPORT], [{ ...mail, subject: "s".repeat(256) }])).toContain("1 to 255");
    expect(refused([REPORT], [{ ...mail, subject: "S", to: ["not an address"] }])).toContain(
      "email address",
    );
    expect(refused([REPORT], [{ ...mail, subject: "S", to: [] }])).toContain("1 to 50");
    expect(refused([REPORT], [{ ...mail, subject: "S", format: "html" }])).toContain(
      "format html is not available for gmail",
    );
  });

  test("template_file is a plain file name inside cost-templates/", () => {
    const file = (name: string) =>
      refused([REPORT], [{ ...SLACK, template: undefined, template_file: name }]);
    for (const name of ["../x.md", "a/b.md", "a\\b.md", ".hidden", "/etc/passwd", "C:x.md", ""]) {
      expect(file(name)).toContain("template_file must be a plain file name");
    }
  });

  test("the report and channel caps", () => {
    const reports = Array.from({ length: COST_MAX_REPORTS + 1 }, (_, i) => ({
      ...REPORT,
      name: `r${String(i)}`,
    }));
    expect(refused(reports, [])).toBe(`at most ${String(COST_MAX_REPORTS)} [[cost.report]] blocks`);
    const channels = Array.from({ length: COST_MAX_REPORT_CHANNELS + 1 }, () => SLACK);
    expect(refused([REPORT], channels)).toBe(
      `at most ${String(COST_MAX_REPORT_CHANNELS)} [[cost.report.channel]] blocks`,
    );
  });
});
