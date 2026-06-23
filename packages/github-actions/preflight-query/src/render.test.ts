import { describe, expect, it } from "bun:test";
import { renderAnnotations, renderJobSummary } from "./render.ts";

const envOk = {
  service: "payment-service",
  target_ref: "main",
  computed_at: "2026-05-12T10:15:30.000Z",
  verdict: "ok" as const,
  checks: {
    active_p1_incidents: { count: 0, findings: [], gap: null },
    failing_ci_runs: { count: 0, findings: [], gap: null },
    merge_conflicts: { count: 0, findings: [], gap: null },
  },
};

const envWarn = {
  service: "payment-service",
  target_ref: "main",
  computed_at: "2026-05-12T10:15:30.000Z",
  verdict: "warn" as const,
  checks: {
    active_p1_incidents: {
      count: 1,
      findings: [
        {
          id: "pagerduty:inc_1",
          title: "DB connection pool exhausted",
          status: "triggered" as const,
          severity: "P1",
          opened_at_ms: 1715000000000,
          pagerduty_service_id: "P12ABCD",
          url: "https://example.pagerduty.com/incidents/inc_1",
        },
      ],
      gap: null,
    },
    failing_ci_runs: { count: 0, findings: [], gap: null },
    merge_conflicts: { count: 0, findings: [], gap: null },
  },
};

describe("renderJobSummary", () => {
  it("renders a verdict-ok summary with three zero-count rows", () => {
    const md = renderJobSummary(envOk);
    expect(md).toContain("payment-service");
    expect(md).toContain("ok");
    expect(md).toContain("Active P1 incidents");
    expect(md).toContain("Failing CI runs");
    expect(md).toContain("Merge conflicts");
  });

  it("includes finding titles in collapsed details when a check has findings", () => {
    const md = renderJobSummary(envWarn);
    expect(md).toContain("DB connection pool exhausted");
  });

  it("includes the gap label when a check is gapped", () => {
    const env = {
      ...envOk,
      checks: {
        ...envOk.checks,
        active_p1_incidents: { count: 0, findings: [], gap: "no_pagerduty_mapping" as const },
      },
    };
    const md = renderJobSummary(env);
    expect(md).toContain("no_pagerduty_mapping");
  });
});

describe("renderAnnotations", () => {
  it("returns one ::warning per finding when verdict=warn", () => {
    const annotations = renderAnnotations(envWarn, "warn");
    expect(annotations).toHaveLength(1);
    expect(annotations[0]?.level).toBe("warning");
    expect(annotations[0]?.message).toContain("DB connection pool exhausted");
  });

  it("returns one ::error per finding when mode=block (escalates level)", () => {
    const annotations = renderAnnotations(envWarn, "block");
    expect(annotations).toHaveLength(1);
    expect(annotations[0]?.level).toBe("error");
  });

  it("returns no annotations when verdict=ok and no gaps", () => {
    const annotations = renderAnnotations(envOk, "warn");
    expect(annotations).toHaveLength(0);
  });
});
