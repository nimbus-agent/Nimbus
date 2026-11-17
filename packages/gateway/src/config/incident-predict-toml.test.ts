import { describe, expect, test } from "bun:test";

import {
  DEFAULT_INCIDENT_PREDICT,
  MAX_EXPECTATIONS,
  parseMaxGap,
  parseNimbusTomlIncidentPredict,
} from "./incident-predict-toml.ts";

function parse(src: string): { cfg: ReturnType<typeof parseNimbusTomlIncidentPredict>; warns: string[] } {
  const warns: string[] = [];
  return { cfg: parseNimbusTomlIncidentPredict(src, (m) => warns.push(m)), warns };
}

describe("parseMaxGap", () => {
  test("accepts m, h and d within 15m..30d", () => {
    expect(parseMaxGap("15m")).toBe(900_000);
    expect(parseMaxGap("6h")).toBe(21_600_000);
    expect(parseMaxGap("30d")).toBe(2_592_000_000);
  });
  test("refuses other shapes and out of range", () => {
    for (const s of ["14m", "31d", "6", "6 h", "1w", "-1h", "1.5h", ""]) {
      expect(parseMaxGap(s)).toBeUndefined();
    }
  });
});

describe("[[incident.expect]] and [incident] anomaly_z", () => {
  test("defaults when nothing is configured", () => {
    expect(parse("[incident]\nenabled = true\n").cfg).toEqual(DEFAULT_INCIDENT_PREDICT);
  });

  test("parses every kind and keys them", () => {
    const { cfg, warns } = parse(`
[incident]
anomaly_z = 5

[[incident.expect]]
kind = "deploy"
service = "checkout"
max_gap = "2d"

[[incident.expect]]
kind = "ci_success"
service = "checkout"
max_gap = "12h"

[[incident.expect]]
kind = "sync"
service = "github"
max_gap = "1h"

[[incident.expect]]
kind = "item"
service = "sentry"
type = "error_issue"
max_gap = "7d"

[other]
kind = "deploy"
`);
    expect(warns).toEqual([]);
    expect(cfg.anomalyZ).toBe(5);
    expect(cfg.expectations.map((e) => e.key)).toEqual([
      "deploy:checkout",
      "ci_success:checkout",
      "sync:github",
      "item:sentry:error_issue",
    ]);
    expect(cfg.expectations[3]).toEqual({
      key: "item:sentry:error_issue",
      kind: "item",
      service: "sentry",
      type: "error_issue",
      maxGapMs: 7 * 86_400_000,
    });
  });

  test("a bad entry is skipped with a reason; the rest stand", () => {
    const { cfg, warns } = parse(`
[[incident.expect]]
kind = "guess"
service = "a"
max_gap = "1h"
[[incident.expect]]
kind = "deploy"
max_gap = "1h"
[[incident.expect]]
kind = "item"
service = "sentry"
max_gap = "1h"
[[incident.expect]]
kind = "sync"
service = "github"
type = "x"
max_gap = "1h"
[[incident.expect]]
kind = "sync"
service = "github"
max_gap = "1y"
[[incident.expect]]
kind = "sync"
service = "slack"
max_gap = "1h"
[[incident.expect]]
kind = "sync"
service = "slack"
max_gap = "2h"
`);
    expect(cfg.expectations.map((e) => e.key)).toEqual(["sync:slack"]);
    expect(warns).toHaveLength(6);
    expect(warns[0]).toContain("#1 skipped: kind");
    expect(warns[5]).toContain("duplicate");
  });

  test("anomaly_z out of range falls back to 3 with a warning", () => {
    const { cfg, warns } = parse("[incident]\nanomaly_z = 2\n");
    expect(cfg.anomalyZ).toBe(3);
    expect(warns[0]).toContain("anomaly_z");
    expect(parse("[incident]\nanomaly_z = 21\n").cfg.anomalyZ).toBe(3);
    expect(parse("[other]\nanomaly_z = 9\n").cfg.anomalyZ).toBe(3);
  });

  test("at most MAX_EXPECTATIONS entries", () => {
    const blocks = Array.from(
      { length: MAX_EXPECTATIONS + 2 },
      (_, i) => `[[incident.expect]]\nkind = "sync"\nservice = "s${String(i)}"\nmax_gap = "1h"\n`,
    ).join("");
    const { cfg, warns } = parse(blocks);
    expect(cfg.expectations).toHaveLength(MAX_EXPECTATIONS);
    expect(warns).toHaveLength(2);
  });
});
