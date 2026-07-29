import { describe, expect, test } from "bun:test";
import {
  buildContextSnippet,
  EXTENDED_SECRET_PATTERNS,
  effectivePatterns,
  redactSecret,
  SECRET_PATTERNS,
  type SecretPattern,
} from "./secret-patterns.ts";

describe("SECRET_PATTERNS — set integrity", () => {
  test("v1 set has 21 patterns", () => {
    expect(SECRET_PATTERNS).toHaveLength(21);
  });

  test("names are unique", () => {
    const names = SECRET_PATTERNS.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("each pattern has a non-empty regex source", () => {
    for (const p of SECRET_PATTERNS) {
      expect(p.regex.source.length).toBeGreaterThan(0);
    }
  });

  test("each category is one of the three accepted values", () => {
    for (const p of SECRET_PATTERNS) {
      expect(["api_key", "private_key", "token"]).toContain(p.category);
    }
  });

  test("every regex is global-flagged so .matchAll iteration works", () => {
    for (const p of SECRET_PATTERNS) {
      expect(p.regex.global).toBe(true);
    }
  });
});

describe("redactSecret", () => {
  test("first-4 + last-4 + asterisks for length >= 8", () => {
    expect(redactSecret("AKIAIOSFODNN7EXAMPLE")).toBe("AKIA****MPLE");
  });

  test("8-char exactly returns first-4 + **** + last-4", () => {
    expect(redactSecret("ABCD1234")).toBe("ABCD****1234");
  });

  test("length < 8 returns 4 stars regardless of input content", () => {
    expect(redactSecret("short")).toBe("****");
    expect(redactSecret("")).toBe("****");
    expect(redactSecret("abc")).toBe("****");
  });
});

describe("buildContextSnippet", () => {
  // Whatever the ±40-char window has to clamp against — plenty of room, a body shorter than the
  // 80-char window, or a secret flush against the end — the secret never survives into the
  // snippet.
  test.each([
    [
      "±40 chars of room on both sides",
      "// before block of harmless content here\nconst KEY = 'AKIAIOSFODNN7EXAMPLE';\n// trailing content also fine",
    ],
    ["a body shorter than 80 chars", "k='AKIAIOSFODNN7EXAMPLE';"],
    ["the secret at end-of-body (no overrun)", "trailing AKIAIOSFODNN7EXAMPLE"],
  ])("redacts the secret with %s", (_label, body) => {
    const secret = "AKIAIOSFODNN7EXAMPLE";
    const snippet = buildContextSnippet(body, body.indexOf(secret), secret.length);
    expect(snippet).toContain("[REDACTED]");
    expect(snippet).not.toContain(secret);
  });
});

function findPattern(name: string): SecretPattern {
  const p = SECRET_PATTERNS.find((x) => x.name === name);
  if (p === undefined) throw new Error(`pattern ${name} missing`);
  return p;
}

function hasMatch(name: string, body: string): boolean {
  const p = findPattern(name);
  p.regex.lastIndex = 0;
  return p.regex.test(body);
}

describe("individual pattern matches", () => {
  test("aws_access_key matches AWS-documented public example", () => {
    expect(hasMatch("aws_access_key", "k='AKIAIOSFODNN7EXAMPLE'")).toBe(true);
  });
  test("aws_access_key does not match arbitrary 16-char uppercase strings without AKIA/ASIA prefix", () => {
    expect(hasMatch("aws_access_key", "k='ABCD1234567890123456'")).toBe(false);
  });

  test("github_pat_classic matches ghp_ followed by 36+ chars", () => {
    expect(hasMatch("github_pat_classic", `t='ghp_${"A".repeat(36)}'`)).toBe(true);
  });
  test("github_pat_classic does not match bare ghp prefix", () => {
    expect(hasMatch("github_pat_classic", "t='ghp_short'")).toBe(false);
  });

  test("github_pat_fine_grained matches github_pat_ prefix with 82+ chars", () => {
    expect(hasMatch("github_pat_fine_grained", `t='github_pat_${"A_".repeat(45)}'`)).toBe(true);
  });

  test("github_oauth matches gho_ prefix", () => {
    expect(hasMatch("github_oauth", `t='gho_${"A".repeat(36)}'`)).toBe(true);
  });

  test("gitlab_pat matches glpat- prefix", () => {
    expect(hasMatch("gitlab_pat", `t='glpat-${"A".repeat(20)}'`)).toBe(true);
  });

  test("slack_bot_token matches xoxb- shape", () => {
    expect(hasMatch("slack_bot_token", `t='xoxb-1234567890-1234567890-${"A".repeat(24)}'`)).toBe(
      true,
    );
  });

  test("slack_user_token matches xoxp- shape", () => {
    expect(
      hasMatch("slack_user_token", `t='xoxp-1234567890-1234567890-1234567890-${"A".repeat(32)}'`),
    ).toBe(true);
  });

  test("openai_api_key matches sk- prefix with 20+ chars", () => {
    expect(hasMatch("openai_api_key", `t='sk-${"A".repeat(20)}'`)).toBe(true);
  });

  test("anthropic_api_key matches sk-ant- prefix", () => {
    expect(hasMatch("anthropic_api_key", `t='sk-ant-${"a-".repeat(20)}'`)).toBe(true);
  });

  test("stripe_live_secret matches sk_live_ prefix", () => {
    expect(hasMatch("stripe_live_secret", `t='sk_live_${"A".repeat(20)}'`)).toBe(true);
  });

  test("stripe_test_secret matches sk_test_ prefix", () => {
    expect(hasMatch("stripe_test_secret", `t='sk_test_${"A".repeat(20)}'`)).toBe(true);
  });

  test("twilio_sid matches AC + 32 hex", () => {
    expect(hasMatch("twilio_sid", `s='AC${"a".repeat(32)}'`)).toBe(true);
  });

  test("google_api_key matches AIza + 35 chars", () => {
    expect(hasMatch("google_api_key", `k='AIza${"A".repeat(35)}'`)).toBe(true);
  });

  test("gcp_service_account_json matches the JSON marker", () => {
    expect(hasMatch("gcp_service_account_json", `{ "type": "service_account" }`)).toBe(true);
  });

  test("npm_token matches npm_ + 36 chars", () => {
    expect(hasMatch("npm_token", `t='npm_${"A".repeat(36)}'`)).toBe(true);
  });

  test("docker_token matches dckr_pat_ prefix", () => {
    expect(hasMatch("docker_token", `t='dckr_pat_${"A".repeat(27)}'`)).toBe(true);
  });

  test("pem_private_key matches PRIVATE KEY block header", () => {
    expect(hasMatch("pem_private_key", "-----BEGIN PRIVATE KEY-----")).toBe(true);
    expect(hasMatch("pem_private_key", "-----BEGIN RSA PRIVATE KEY-----")).toBe(true);
    expect(hasMatch("pem_private_key", "-----BEGIN OPENSSH PRIVATE KEY-----")).toBe(true);
  });

  test("pgp_private_key matches PGP block header", () => {
    expect(hasMatch("pgp_private_key", "-----BEGIN PGP PRIVATE KEY BLOCK-----")).toBe(true);
  });

  test("jwt matches three-segment base64-url shape", () => {
    expect(
      hasMatch(
        "jwt",
        "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
      ),
    ).toBe(true);
  });

  test("sendgrid_api_key matches SG.{22}.{43} shape", () => {
    expect(hasMatch("sendgrid_api_key", `t='SG.${"A".repeat(22)}.${"B".repeat(43)}'`)).toBe(true);
  });

  test("mailgun_api_key matches key- + 32 hex", () => {
    expect(hasMatch("mailgun_api_key", `t='key-${"a".repeat(32)}'`)).toBe(true);
  });
});

describe("pattern tiers", () => {
  test("base patterns carry confidence 'high'", () => {
    expect(SECRET_PATTERNS.every((p) => p.confidence === "high")).toBe(true);
  });

  test("extended patterns carry confidence 'extended'", () => {
    expect(EXTENDED_SECRET_PATTERNS.length).toBeGreaterThan(0);
    expect(EXTENDED_SECRET_PATTERNS.every((p) => p.confidence === "extended")).toBe(true);
  });

  test("extended regexes are global-flagged for matchAll", () => {
    for (const p of EXTENDED_SECRET_PATTERNS) {
      expect(p.regex.global).toBe(true);
    }
  });

  test("effectivePatterns(false) is the base set only", () => {
    expect(effectivePatterns(false)).toEqual(SECRET_PATTERNS);
  });

  test("effectivePatterns(true) is base + extended", () => {
    expect(effectivePatterns(true)).toHaveLength(
      SECRET_PATTERNS.length + EXTENDED_SECRET_PATTERNS.length,
    );
  });

  test("an extended generic-assignment pattern matches a high-entropy secret assignment", () => {
    const body = `const apiSecret = "a8Fk2Lm9Qr4Tz7Wx1Yb3Nc6Vd0Ee5Gg8Hh"`;
    const hit = effectivePatterns(true).some((p) => {
      p.regex.lastIndex = 0;
      return p.regex.test(body);
    });
    expect(hit).toBe(true);
  });
});

describe("regex-DoS resilience", () => {
  test("scanning 100 KB of random text finishes within 200 ms per pattern", () => {
    const filler = Array.from({ length: 100_000 }, (_, i) =>
      String.fromCodePoint(48 + (i % 75)),
    ).join("");
    for (const p of SECRET_PATTERNS) {
      p.regex.lastIndex = 0;
      const start = performance.now();
      Array.from(filler.matchAll(p.regex));
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(200);
    }
  });
});
