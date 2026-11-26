import { describe, expect, test } from "bun:test";

import type { CostReportModel } from "./cost-report-model.ts";
import {
  COST_REPORT_BODY_MAX,
  COST_TEMPLATE_PLACEHOLDERS,
  CostTemplateError,
  parseCostTemplate,
  renderCostSubject,
  renderCostTemplate,
} from "./cost-template.ts";

const EVIL = "<!here> *x* _y_ ~z~ `c` & @channel <img src=x>";

function model(over: Partial<CostReportModel> = {}): CostReportModel {
  return {
    name: "checkout-weekly",
    scope: { product: "checkout" },
    range: { fromDay: "2026-11-16", toDay: "2026-11-22", label: "week of Monday 2026-11-16" },
    previous: { fromDay: "2026-11-09", toDay: "2026-11-15", label: "the week before" },
    weekStart: "2026-11-16",
    byCurrency: {
      USD: {
        total: 120,
        previous: 60,
        change: 60,
        changePct: 100,
        topMovers: [
          { service: "payment-service", part: "Amazon EC2", provider: "aws", change: 40 },
        ],
        breakdown: [
          { part: "payment-service", provider: "aws", env: "prod", amount: 100 },
          { part: EVIL, provider: "aws", env: null, amount: 20 },
        ],
        unassigned: 7,
        unassignedPct: 3.954,
      },
    },
    provisionalFrom: null,
    freshness: [{ source: "focus", lastDay: "2026-11-24", provisionalFrom: "2026-11-23" }],
    empty: false,
    configError: null,
    command: "nimbus cost report checkout-weekly",
    ...over,
  };
}

const render = (
  text: string,
  kind: "slack" | "teams" | "gmail" | "outlook",
  format: "text" | "markdown" | "html",
  m = model(),
  breakdown: "list" | "csv" = "list",
  maxChars = COST_REPORT_BODY_MAX[kind],
) => renderCostTemplate(parseCostTemplate(text), m, { kind, format, breakdown, maxChars }).text;

function parseError(text: string): string {
  try {
    parseCostTemplate(text);
  } catch (e) {
    if (e instanceof CostTemplateError) return e.message;
    throw e;
  }
  throw new Error("expected a refusal");
}

describe("parseCostTemplate", () => {
  test("the closed placeholder set", () => {
    expect(COST_TEMPLATE_PLACEHOLDERS).toEqual([
      "report_name",
      "period_start",
      "period_end",
      "week_start",
      "total",
      "currency",
      "change",
      "change_pct",
      "top_movers",
      "breakdown",
      "unassigned",
      "unassigned_pct",
      "freshness",
      "command",
    ]);
  });

  test("an unknown placeholder and unbalanced braces are refused, naming them", () => {
    expect(parseError("Cost: {totl}")).toBe(
      "unknown placeholder {totl} (known: {report_name}, {period_start}, {period_end}, {week_start}, {total}, {currency}, {change}, {change_pct}, {top_movers}, {breakdown}, {unassigned}, {unassigned_pct}, {freshness}, {command})",
    );
    expect(parseError("Cost: {total")).toBe("an unclosed { at character 7");
    expect(parseError("Cost: total}")).toBe("a } with no { at character 12");
    expect(parseError("{}")).toContain("unknown placeholder {}");
  });

  test("{{ and }} are literal braces", () => {
    expect(render("{{total}} is {total}", "gmail", "text")).toBe("{total} is 120.00 USD");
  });
});

describe("renderCostTemplate: values", () => {
  test("every placeholder renders", () => {
    const text = render(
      "{report_name}|{period_start}|{period_end}|{week_start}|{total}|{currency}|{change}|{change_pct}|{unassigned}|{unassigned_pct}|{command}",
      "gmail",
      "text",
    );
    expect(text).toBe(
      "checkout-weekly|2026-11-16|2026-11-22|2026-11-16|120.00 USD|USD|+60.00 USD|+100.0%|7.00 USD|4.0%|nimbus cost report checkout-weekly",
    );
    expect(render("{freshness}", "gmail", "text")).toBe(
      "focus: data up to 2026-11-24 (provisional from 2026-11-23)",
    );
    expect(render("{top_movers}", "gmail", "text")).toBe(
      "- payment-service Amazon EC2 (aws): +40.00 USD",
    );
  });

  test("two currencies are listed one by one, never summed", () => {
    const usd = model().byCurrency["USD"];
    if (usd === undefined) throw new Error("fixture");
    const m = model({
      byCurrency: { EUR: { ...usd, total: 9, previous: 0, change: 9, changePct: null }, USD: usd },
    });
    expect(render("{total} / {currency} / {change} / {change_pct}", "gmail", "text", m)).toBe(
      "9.00 EUR; 120.00 USD / EUR; USD / +9.00 EUR; +60.00 USD / new; +100.0%",
    );
  });

  test("the provisional marker, an empty week start and no data", () => {
    expect(render("{total}", "gmail", "text", model({ provisionalFrom: "2026-11-21" }))).toBe(
      "120.00 USD (provisional from 2026-11-21)",
    );
    expect(render("[{week_start}]", "gmail", "text", model({ weekStart: null }))).toBe("[]");
    expect(
      render("{total}|{freshness}", "gmail", "text", model({ byCurrency: {}, freshness: [] })),
    ).toBe("0.00|no cost data");
  });
});

describe("renderCostTemplate: escaping per channel", () => {
  test("Slack and Teams neutralise mentions and formatting in substituted values only", () => {
    const slack = render("*Breakdown* {breakdown}", "slack", "markdown");
    expect(slack.startsWith("*Breakdown* ")).toBe(true); // the owner's literal text is kept
    expect(slack).not.toContain("<!here>");
    expect(slack).not.toContain("@channel");
    expect(slack).not.toMatch(/[*_~`](?:x|y|z|c)/);
    expect(slack).toContain("&lt;!here&gt;");
    expect(slack).toContain("&amp;");
    const teams = render("{breakdown}", "teams", "markdown");
    expect(teams).not.toContain("<");
    expect(teams).not.toContain("@channel");
  });

  test("HTML escapes and plain mail text only strips", () => {
    const html = render("<p>{breakdown}</p>", "outlook", "html");
    expect(html.startsWith("<p><ul><li>")).toBe(true);
    expect(html).toContain("&lt;img src=x&gt;");
    expect(html).not.toContain("<img");
    expect(html).toContain("&amp;");
    const plain = render(
      "{breakdown}",
      "gmail",
      "text",
      model({
        byCurrency: {
          USD: {
            ...(model().byCurrency["USD"] as NonNullable<CostReportModel["byCurrency"]["USD"]>),
            breakdown: [{ part: "a\u0007b​c", provider: "aws", env: null, amount: 1 }],
          },
        },
      }),
    );
    expect(plain).toBe("- abc (aws): 1.00 USD");
  });

  test("a substituted value is capped at 128 characters", () => {
    const usd = model().byCurrency["USD"] as NonNullable<CostReportModel["byCurrency"]["USD"]>;
    const m = model({
      byCurrency: {
        USD: {
          ...usd,
          breakdown: [{ part: "p".repeat(200), provider: "aws", env: null, amount: 1 }],
        },
      },
    });
    const text = render("{breakdown}", "gmail", "text", m);
    expect(text).toContain("p".repeat(128));
    expect(text).not.toContain("p".repeat(129));
  });

  test("csv breakdown guards formulas; chat fences it, html wraps it in an escaped pre", () => {
    const usd = model().byCurrency["USD"] as NonNullable<CostReportModel["byCurrency"]["USD"]>;
    const m = model({
      byCurrency: {
        USD: { ...usd, breakdown: [{ part: "=SUM(A1)", provider: "aws", env: "prod", amount: 5 }] },
      },
    });
    expect(render("{breakdown}", "gmail", "text", m, "csv")).toBe(
      "part,provider,env,currency,amount\n'=SUM(A1),aws,prod,USD,5.00",
    );
    expect(render("{breakdown}", "slack", "markdown", m, "csv")).toBe(
      "```\npart,provider,env,currency,amount\n'=SUM(A1),aws,prod,USD,5.00\n```",
    );
    expect(render("{breakdown}", "outlook", "html", m, "csv")).toContain(
      "<pre>part,provider,env,currency,amount",
    );
  });
});

describe("renderCostTemplate: caps", () => {
  test("lists shrink with a stated count; a body that still does not fit is refused", () => {
    const usd = model().byCurrency["USD"] as NonNullable<CostReportModel["byCurrency"]["USD"]>;
    const rows = Array.from({ length: 50 }, (_, i) => ({
      part: `service-${String(i).padStart(2, "0")}`,
      provider: "aws",
      env: "prod",
      amount: 50 - i,
    }));
    const m = model({ byCurrency: { USD: { ...usd, breakdown: rows } } });
    const out = renderCostTemplate(parseCostTemplate("{total}\n{breakdown}"), m, {
      kind: "slack",
      format: "text",
      breakdown: "list",
      maxChars: 400,
    });
    expect(out.text.length).toBeLessThanOrEqual(400);
    expect(out.truncated.breakdown).toBeGreaterThan(0);
    expect(out.text).toContain(`… and ${String(out.truncated.breakdown)} more`);
    expect(out.text).toContain("service-00");
    expect(() =>
      renderCostTemplate(parseCostTemplate(`${"x".repeat(500)} {breakdown}`), m, {
        kind: "slack",
        format: "text",
        breakdown: "list",
        maxChars: 400,
      }),
    ).toThrow(CostTemplateError);
  });

  test("the body caps per kind", () => {
    expect(COST_REPORT_BODY_MAX).toEqual({
      slack: 12_000,
      teams: 12_000,
      gmail: 100_000,
      outlook: 100_000,
    });
  });
});

describe("renderCostSubject", () => {
  test("one plain line: values stripped, list placeholders refused, capped at 255", () => {
    expect(
      renderCostSubject(
        parseCostTemplate("Cost {report_name}, week of {week_start}: {total}"),
        model(),
      ),
    ).toBe("Cost checkout-weekly, week of 2026-11-16: 120.00 USD");
    expect(() => renderCostSubject(parseCostTemplate("Top {top_movers}"), model())).toThrow(
      "{top_movers} cannot be used in a subject",
    );
    expect(() =>
      renderCostSubject(parseCostTemplate(`${"s".repeat(250)} {total}`), model()),
    ).toThrow("over 255 characters");
  });
});
