import { describe, expect, test } from "bun:test";
import { Writable } from "node:stream";
import {
  createGatewayPinoLoggerForStream,
  scrubRedactedValuePatterns,
} from "./gateway-log-file.ts";

function captureLogs(): { writer: Writable; lines: () => string[] } {
  const collected: string[] = [];
  const writer = new Writable({
    write(chunk, _enc, cb): void {
      collected.push(chunk.toString("utf8"));
      cb();
    },
  });
  return { writer, lines: () => collected };
}

describe("scrubRedactedValuePatterns (S2-F9)", () => {
  test("strips Bearer tokens", () => {
    expect(scrubRedactedValuePatterns("Authorization: Bearer abc.def-123/xyz=+")).toBe(
      "Authorization: [REDACTED]",
    );
  });

  test("strips OpenAI sk- prefixes", () => {
    expect(scrubRedactedValuePatterns("Invalid API key starting with sk-abc1234567890_xyz")).toBe(
      "Invalid API key starting with [REDACTED]",
    );
  });

  test("strips Anthropic sk-ant- prefixes", () => {
    expect(scrubRedactedValuePatterns("token=sk-ant-abc1234567890zzzz")).toBe("token=[REDACTED]");
  });

  test("strips GitHub ghp_ tokens", () => {
    expect(scrubRedactedValuePatterns("auth ghp_AbCdEf1234567890abcd")).toBe("auth [REDACTED]");
  });

  test("strips Slack xoxb tokens", () => {
    expect(scrubRedactedValuePatterns("token=xoxb-1234-5678-AbCdEf")).toBe("token=[REDACTED]");
  });

  test("strips AWS access key ids", () => {
    expect(scrubRedactedValuePatterns("AKIAIOSFODNN7EXAMPLE in stack")).toBe("[REDACTED] in stack");
  });

  test("strips JWT tokens", () => {
    const jwt = "eyJhbGciOiJIUzI1NiIs.eyJzdWIiOiIxMjM0NX0.SflKxwRJSMeKKF2QT4fwpMeJ";
    expect(scrubRedactedValuePatterns(`bearer ${jwt}`)).toBe("bearer [REDACTED]");
  });

  test("leaves a plain message unchanged", () => {
    expect(scrubRedactedValuePatterns("normal log line")).toBe("normal log line");
  });
});

describe("createGatewayPinoLoggerForStream — redaction (S2-F9)", () => {
  test("strips a Bearer token from a logged err.headers.Authorization", () => {
    const { writer, lines } = captureLogs();
    const logger = createGatewayPinoLoggerForStream(writer, "warn");
    const err = new Error("upstream failed") as Error & {
      headers?: Record<string, string>;
    };
    err.headers = { Authorization: "Bearer top-secret-token-1234567890" };
    logger.warn({ err }, "OpenAI embedder init failed");
    const blob = lines().join("");
    expect(blob.includes("top-secret-token-1234567890")).toBe(false);
    expect(blob.includes("OpenAI embedder init failed")).toBe(true);
  });

  test("strips an sk- key embedded in err.message via the value scrubber", () => {
    const { writer, lines } = captureLogs();
    const logger = createGatewayPinoLoggerForStream(writer, "warn");
    const err = new Error("Invalid API key starting with sk-leakedkeythatislongenough");
    logger.warn({ err }, "init failed");
    const blob = lines().join("");
    expect(blob.includes("sk-leakedkeythatislongenough")).toBe(false);
  });

  test("strips token-shaped values in `msg`", () => {
    const { writer, lines } = captureLogs();
    const logger = createGatewayPinoLoggerForStream(writer, "warn");
    logger.warn(`token rejected: Bearer abcdefghijklmnopqrst`);
    const blob = lines().join("");
    expect(blob.includes("Bearer abcdefghijklmnopqrst")).toBe(false);
    expect(blob.includes("token rejected")).toBe(true);
  });

  test("strips top-level apiKey via the redact paths config", () => {
    const { writer, lines } = captureLogs();
    const logger = createGatewayPinoLoggerForStream(writer, "warn");
    logger.warn({ apiKey: "sk-thisshouldbescrubbed12345" }, "auth failed");
    const blob = lines().join("");
    expect(blob.includes("sk-thisshouldbescrubbed12345")).toBe(false);
  });
});
