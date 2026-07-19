import { describe, expect, test } from "bun:test";
import {
  classifyPatProbe,
  evaluateCertExpiry,
  safeParseDate,
  summarize,
} from "./check-secret-health.ts";

describe("classifyPatProbe", () => {
  test("repo-write: push true → ok, false → insufficient, 401 → dead", () => {
    const s = { kind: "repo-write", targetRepo: "o/r" } as const;
    expect(classifyPatProbe(s, { status: 200, scopes: null, push: true })).toBe("ok");
    expect(classifyPatProbe(s, { status: 200, scopes: null, push: false })).toBe("insufficient");
    expect(classifyPatProbe(s, { status: 401, scopes: null })).toBe("dead");
    expect(classifyPatProbe(s, { status: 500, scopes: null })).toBe("indeterminate");
  });
  test("scopes: required present → ok, absent → insufficient", () => {
    const s = { kind: "scopes", required: "public_repo" } as const;
    expect(classifyPatProbe(s, { status: 200, scopes: "public_repo, gist" })).toBe("ok");
    expect(classifyPatProbe(s, { status: 200, scopes: "gist" })).toBe("insufficient");
    expect(classifyPatProbe(s, { status: 401, scopes: null })).toBe("dead");
  });
  test("alive: 200 → ok, 401 → dead, other → indeterminate", () => {
    const s = { kind: "alive" } as const;
    expect(classifyPatProbe(s, { status: 200, scopes: null })).toBe("ok");
    expect(classifyPatProbe(s, { status: 401, scopes: null })).toBe("dead");
    expect(classifyPatProbe(s, { status: 403, scopes: null })).toBe("indeterminate");
  });
});

describe("evaluateCertExpiry", () => {
  const now = new Date("2026-07-18T00:00:00Z");
  test("past → expired", () => {
    expect(evaluateCertExpiry(new Date("2026-07-17T00:00:00Z"), now, 21)).toBe("expired");
  });
  test("within threshold → expiring", () => {
    expect(evaluateCertExpiry(new Date("2026-08-01T00:00:00Z"), now, 21)).toBe("expiring");
  });
  test("beyond threshold → ok", () => {
    expect(evaluateCertExpiry(new Date("2026-09-01T00:00:00Z"), now, 21)).toBe("ok");
  });
  test("null (undecodable) → indeterminate", () => {
    expect(evaluateCertExpiry(null, now, 21)).toBe("indeterminate");
  });
  test("NaN date → indeterminate (never a false ok)", () => {
    expect(evaluateCertExpiry(new Date("nonsense"), now, 21)).toBe("indeterminate");
  });
});

describe("safeParseDate", () => {
  test("valid openssl notAfter string → Date", () => {
    expect(safeParseDate("Jul 18 12:00:00 2028 GMT")?.getUTCFullYear()).toBe(2028);
  });
  test("garbage → null", () => {
    expect(safeParseDate("not a date")).toBeNull();
  });
});

describe("summarize", () => {
  test("dead PAT or expired cert → hard failure", () => {
    const r = summarize([{ name: "RELEASE_PAT", kind: "pat", status: "dead", detail: "" }]);
    expect(r.hasHardFailure).toBe(true);
    expect(r.table).toContain("RELEASE_PAT");
  });
  test("expiring cert → warning, not hard failure", () => {
    const r = summarize([{ name: "GPG", kind: "cert", status: "expiring", detail: "12d" }]);
    expect(r.hasHardFailure).toBe(false);
    expect(r.hasWarning).toBe(true);
  });
  test("all ok → neither", () => {
    const r = summarize([{ name: "X", kind: "pat", status: "ok", detail: "" }]);
    expect(r.hasHardFailure).toBe(false);
    expect(r.hasWarning).toBe(false);
  });
});
