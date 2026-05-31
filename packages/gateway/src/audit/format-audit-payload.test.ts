import { describe, expect, test } from "bun:test";

import { formatAuditPayload, redactAuditPayload } from "./format-audit-payload.ts";

describe("formatAuditPayload", () => {
  test("returns JSON unchanged when under cap", () => {
    expect(formatAuditPayload({ a: 1 })).toBe('{"a":1}');
  });

  test("truncates long serialized payloads", () => {
    const big = "x".repeat(5000);
    const s = formatAuditPayload({ big }, 100);
    expect(s.endsWith("…[truncated]")).toBe(true);
    expect(s.length).toBeLessThanOrEqual(112);
  });
});

describe("redactAuditPayload (S2-F2)", () => {
  test("redacts token-shaped keys at any depth", () => {
    const out = redactAuditPayload({
      action: {
        type: "slack.message.post",
        payload: {
          channel: "#general",
          input: { headers: { Authorization: "Bearer abc" } },
        },
      },
    });
    const parsed = JSON.parse(out) as Record<string, unknown>;
    const action = parsed["action"] as Record<string, unknown>;
    const payload = action["payload"] as Record<string, unknown>;
    const input = payload["input"] as Record<string, unknown>;
    const headers = input["headers"] as Record<string, unknown>;
    expect(headers["Authorization"]).toBe("[REDACTED]");
    expect(payload["channel"]).toBe("#general");
  });

  test("redacts apiToken / clientSecret / pat values", () => {
    const out = redactAuditPayload({
      action: {
        type: "test",
        payload: {
          input: { apiToken: "ghp_xyz", clientSecret: "csec", pat: "ghp_q" },
        },
      },
    });
    expect(out.includes("ghp_xyz")).toBe(false);
    expect(out.includes("csec")).toBe(false);
    expect(out.includes("ghp_q")).toBe(false);
  });

  test("preserves non-sensitive scalar fields", () => {
    const out = redactAuditPayload({
      action: { type: "file.move", payload: { from: "a", to: "b" } },
    });
    const parsed = JSON.parse(out) as Record<string, unknown>;
    const action = parsed["action"] as Record<string, unknown>;
    const payload = action["payload"] as Record<string, unknown>;
    expect(payload["from"]).toBe("a");
    expect(payload["to"]).toBe("b");
  });

  test("respects max bytes truncation", () => {
    const big = "x".repeat(10_000);
    const out = redactAuditPayload({ note: big }, 64);
    expect(out.endsWith("…[truncated]")).toBe(true);
  });

  test("scrubs GitHub PAT values stored under a generic key", () => {
    const out = redactAuditPayload({
      message: "Authenticating with ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA now",
    });
    expect(out.includes("ghp_AAAAAAAA")).toBe(false);
    expect(out.includes("[REDACTED]")).toBe(true);
  });

  test("scrubs OpenAI / Anthropic / Slack / JWT / AWS values inside strings", () => {
    const jwtSample = [
      "eyJhbGciOiJIUzI1NiJ9",
      "eyJzdWIiOiIxMjM0NTY3ODkwIn0",
      "abcdefghijklmnopqrstuvwxyz_test",
    ].join(".");
    const samples = [
      "sk-1234567890abcdefghijklmnopqrstuv",
      "sk-ant-api03-abcdefghijklmnopqrstuv1234567890",
      "xoxb-1234567890-abcdefghijkl",
      jwtSample,
      "AKIAIOSFODNN7EXAMPLE",
    ];
    for (const s of samples) {
      const out = redactAuditPayload({ note: s });
      expect(out.includes(s)).toBe(false);
      expect(out.includes("[REDACTED]")).toBe(true);
    }
  });

  test("does not redact non-secret strings that merely contain the prefix `sk`", () => {
    const out = redactAuditPayload({ description: "sketch a plan" });
    expect(out.includes("sketch a plan")).toBe(true);
  });
});
