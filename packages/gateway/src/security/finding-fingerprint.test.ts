import { describe, expect, test } from "bun:test";
import { computeFindingFingerprint } from "./finding-fingerprint.ts";

const base = {
  service: "filesystem",
  externalId: "sym:abc:src/x.ts:foo:function",
  patternName: "pem_private_key",
  matchRedacted: "----****KEY-",
};

describe("computeFindingFingerprint", () => {
  test("is a 64-char lowercase hex string", () => {
    const fp = computeFindingFingerprint({ ...base, contextSnippet: "a[REDACTED]b" });
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  test("is deterministic for identical inputs", () => {
    const a = computeFindingFingerprint({ ...base, contextSnippet: "a[REDACTED]b" });
    const b = computeFindingFingerprint({ ...base, contextSnippet: "a[REDACTED]b" });
    expect(a).toBe(b);
  });

  test("differs when surrounding context differs (fixed-literal disambiguation)", () => {
    const a = computeFindingFingerprint({ ...base, contextSnippet: "alpha[REDACTED]beta" });
    const b = computeFindingFingerprint({ ...base, contextSnippet: "gamma[REDACTED]delta" });
    expect(a).not.toBe(b);
  });

  test("contains no raw secret bytes", () => {
    const fp = computeFindingFingerprint({
      ...base,
      matchRedacted: "AKIA****6789",
      contextSnippet: "x[REDACTED]y",
    });
    expect(fp.includes("AKIA")).toBe(false);
  });
});
