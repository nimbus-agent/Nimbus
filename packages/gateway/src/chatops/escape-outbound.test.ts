import { describe, expect, test } from "bun:test";
import { escapeSlackText } from "./escape-outbound.ts";

describe("escapeSlackText", () => {
  test("escapes Slack's three control characters", () => {
    expect(escapeSlackText("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
  });

  test("escapes & FIRST, so an already-escaped entity is not decoded back into a control char", () => {
    expect(escapeSlackText("&lt;!channel&gt;")).toBe("&amp;lt;!channel&amp;gt;");
  });

  test("mentions and disguised links are inert: no < or > survives", () => {
    for (const hostile of [
      "<!channel>",
      "<!here>",
      "<@U123>",
      "<https://evil.example|Rollback docs>",
    ]) {
      const out = escapeSlackText(hostile);
      expect(out).not.toContain("<");
      expect(out).not.toContain(">");
    }
    expect(escapeSlackText("DB down <!channel> <https://evil|Rollback docs> & more")).toBe(
      "DB down &lt;!channel&gt; &lt;https://evil|Rollback docs&gt; &amp; more",
    );
  });

  test("plain text is unchanged", () => {
    expect(escapeSlackText("payment-service: 5xx rate above 5% on /v1/charges")).toBe(
      "payment-service: 5xx rate above 5% on /v1/charges",
    );
  });
});
