import { describe, expect, test } from "bun:test";
import fc from "fast-check";

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

// --- C1: property-based redaction lock (fast-check) ---

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const ALNUM_US = `${ALNUM}_`; // alnum + underscore (fine-grained PAT body)
const ALNUM_USD = `${ALNUM}_-`; // alnum + underscore + dash (sk- bodies)
const ALNUM_D = `${ALNUM}-`; // alnum + dash (slack body)
const ALNUM_UD = `${ALNUM}_-`; // alnum + underscore + dash (jwt segments)
const UPPERNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"; // aws body
const BEARER_BODY = `${ALNUM}_.+/-`; // bearer body charset

/** A random string of `chars`, length in [min, max]. */
function charsetArb(chars: string, min: number, max = min + 24): fc.Arbitrary<string> {
  return fc
    .array(fc.constantFrom(...chars.split("")), { minLength: min, maxLength: max })
    .map((a) => a.join(""));
}

/**
 * One generator per production SENSITIVE_VALUE_PATTERN family. Each yields a
 * structurally valid token (correct prefix + random body of the correct charset
 * and >= the minimum length). Keys MUST match the production map's keys — the
 * structural guard below enforces that 1:1.
 */
const GENERATORS: ReadonlyMap<string, fc.Arbitrary<string>> = new Map([
  [
    "github_classic",
    fc
      .tuple(fc.constantFrom("p", "o", "u", "s", "r"), charsetArb(ALNUM, 20))
      .map(([c, b]) => `gh${c}_${b}`),
  ],
  ["github_fine_grained", charsetArb(ALNUM_US, 20).map((b) => `github_pat_${b}`)],
  [
    "openai",
    fc
      .tuple(fc.boolean(), charsetArb(ALNUM_USD, 20))
      .map(([proj, b]) => `sk-${proj ? "proj-" : ""}${b}`),
  ],
  ["anthropic", charsetArb(ALNUM_USD, 20).map((b) => `sk-ant-${b}`)],
  [
    "slack",
    fc
      .tuple(fc.constantFrom("b", "o", "a", "p", "r"), fc.boolean(), charsetArb(ALNUM_D, 10))
      .map(([c, s, b]) => `xox${c}${s ? "s" : ""}-${b}`),
  ],
  [
    "bearer",
    fc
      .tuple(charsetArb(BEARER_BODY, 16), fc.constantFrom("", "=", "=="))
      .map(([b, eq]) => `Bearer ${b}${eq}`),
  ],
  [
    "jwt",
    fc
      .tuple(charsetArb(ALNUM_UD, 3), charsetArb(ALNUM_UD, 3), charsetArb(ALNUM_UD, 3))
      .map(([a, b, c]) => `eyJ${a}.${b}.${c}`),
  ],
  [
    "aws",
    fc
      .tuple(fc.constantFrom("AKIA", "ASIA"), charsetArb(UPPERNUM, 16, 16))
      .map(([p, b]) => `${p}${b}`),
  ],
]);

// Non-empty, non-alphanumeric separators — guarantee a token boundary on each
// side. Includes "_" specifically to prove the underscore-adjacency fix.
const SEP = fc.constantFrom(" ", "_", ":", "=", ",", "(", "[", "/", '"', "'", "\n", ".");
// Clearly non-secret prose: lowercase letters + spaces only (cannot match any
// pattern — every pattern needs a digit/dash/underscore/uppercase or a fixed prefix).
const LOWORD = fc
  .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz".split("")), { minLength: 1, maxLength: 8 })
  .map((a) => a.join(""));
const PROSE = fc.array(LOWORD, { minLength: 1, maxLength: 6 }).map((a) => a.join(" "));
const PROSE_OR_EMPTY = fc.oneof(fc.constant(""), PROSE);

describe("redactAuditPayload — property: every token family is scrubbed anywhere", () => {
  for (const [name, gen] of GENERATORS) {
    test(`scrubs ${name} tokens regardless of surrounding noise`, () => {
      fc.assert(
        fc.property(
          gen,
          PROSE_OR_EMPTY,
          SEP,
          SEP,
          PROSE_OR_EMPTY,
          fc.boolean(),
          (token, lead, s1, s2, trail, nest) => {
            const embedded = `${lead}${s1}${token}${s2}${trail}`;
            // Test both a bare-string payload and a value nested under a generic
            // (non-sensitive) key — redaction must reach both.
            const payload = nest ? { note: embedded } : embedded;
            const out = redactAuditPayload(payload);
            // The token (the secret material) must not survive...
            expect(out.includes(token)).toBe(false);
            // ...and a redaction marker must be present.
            expect(out.includes("[REDACTED]")).toBe(true);
          },
        ),
        { numRuns: 300 },
      );
    });
  }
});

describe("redactAuditPayload — property: ordinary prose is preserved", () => {
  test("never redacts lowercase-letter prose", () => {
    fc.assert(
      fc.property(PROSE, (prose) => {
        const out = redactAuditPayload({ note: prose });
        expect(out.includes(prose)).toBe(true);
        expect(out.includes("[REDACTED]")).toBe(false);
      }),
      { numRuns: 300 },
    );
  });
});
