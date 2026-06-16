import { describe, expect, test } from "bun:test";
import { redactForShare } from "./share-redaction.ts";

describe("redactForShare", () => {
  test("strips emails, IPs, hostnames, slack handles, credit cards, and secrets", () => {
    const { redacted, applied } = redactForShare({
      note: "ping alice@corp.com on 10.1.2.3 via db-prod-01.internal",
      handle: "<@U012ABCDEF>",
      card: "4111 1111 1111 1111",
      token: "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    });
    const json = JSON.stringify(redacted);
    expect(json).not.toContain("alice@corp.com");
    expect(json).not.toContain("10.1.2.3");
    expect(json).not.toContain("db-prod-01.internal");
    expect(json).not.toContain("U012ABCDEF");
    expect(json).not.toContain("4111");
    expect(json).not.toContain("ghp_");
    expect(json).toContain("[REDACTED]");
    expect(applied).toEqual(
      expect.arrayContaining([
        "emails",
        "ips",
        "hostnames",
        "slack-handles",
        "credit-cards",
        "secrets",
      ]),
    );
  });

  test("applies caller-supplied patterns and records them", () => {
    const { redacted, applied } = redactForShare({ msg: "project ZURICH is internal" }, [
      /ZURICH/g,
    ]);
    expect(JSON.stringify(redacted)).not.toContain("ZURICH");
    expect(applied).toContain("caller");
  });

  test("leaves benign content intact", () => {
    const { redacted, applied } = redactForShare({ msg: "hello world", count: 3 });
    expect(redacted).toEqual({ msg: "hello world", count: 3 });
    expect(applied).toEqual([]);
  });

  test("redacts secret/PII-shaped object KEYS, not just values", () => {
    const { redacted, applied } = redactForShare({
      params: {
        "alice@corp.com": { role: "admin" },
        ghp_abcdefghijklmnopqrstuvwxyz0123456789: true,
      },
    });
    const json = JSON.stringify(redacted);
    expect(json).not.toContain("alice@corp.com");
    expect(json).not.toContain("ghp_");
    expect(json).toContain("[REDACTED]");
    expect(applied).toEqual(expect.arrayContaining(["emails", "secrets"]));
  });

  test("keys that redact to the same value are kept distinct (no silent overwrite)", () => {
    const { redacted } = redactForShare({
      "alice@corp.com": 1,
      "bob@corp.com": 2,
    });
    const out = redacted as Record<string, unknown>;
    // Both emails redact to "[REDACTED]"; the second must not clobber the first.
    expect(Object.keys(out)).toHaveLength(2);
    expect(Object.values(out).sort()).toEqual([1, 2]);
  });
});
