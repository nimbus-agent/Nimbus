// packages/gateway/src/connectors/connector-writes/confirm-template.test.ts
import { describe, expect, test } from "bun:test";
import {
  CONFIRM_MAX_LENGTH,
  confirmTemplateKeys,
  isConfirmChar,
  isSensitiveFieldName,
  parseConfirmTemplate,
} from "./confirm-template.ts";

describe("parseConfirmTemplate", () => {
  test("splits literal text and fields, with the tail8 modifier", () => {
    const r = parseConfirmTemplate("{owner}/{repo}#{pullNumber}");
    expect(r).toEqual({
      ok: true,
      segments: [
        { kind: "field", name: "owner", tail8: false },
        { kind: "text", text: "/" },
        { kind: "field", name: "repo", tail8: false },
        { kind: "text", text: "#" },
        { kind: "field", name: "pullNumber", tail8: false },
      ],
    });
    expect(parseConfirmTemplate("{eventId:tail8}")).toEqual({
      ok: true,
      segments: [{ kind: "field", name: "eventId", tail8: true }],
    });
  });

  test("refuses a template with no placeholder", () => {
    expect(parseConfirmTemplate("fixed")).toEqual({
      ok: false,
      reason: "names no placeholder",
    });
    expect(parseConfirmTemplate("")).toEqual({ ok: false, reason: "names no placeholder" });
  });

  test("refuses every malformed brace shape", () => {
    for (const t of [
      "{a",
      "a}",
      "{}",
      "{a b}",
      "{1a}",
      "{a:head8}",
      "{a:}",
      "{{a}}",
      "{a}{",
      "{a-b}",
    ]) {
      const r = parseConfirmTemplate(t);
      expect(r.ok).toBe(false);
    }
  });

  test("refuses literal text outside the confirm character set", () => {
    const r = parseConfirmTemplate("{a}é");
    expect(r.ok).toBe(false);
    expect(parseConfirmTemplate(String.raw`{a}\{b}`).ok).toBe(false);
  });

  test("confirmTemplateKeys lists the field names in order, repeats once", () => {
    const r = parseConfirmTemplate("{b}/{a}/{b}");
    if (!r.ok) throw new Error("parse");
    expect(confirmTemplateKeys(r.segments)).toEqual(["b", "a"]);
  });
});

describe("isConfirmChar", () => {
  test("allows exactly letters, digits, space and _ - . / : # @ !", () => {
    for (const c of "azAZ09 _-./:#@!") expect(isConfirmChar(c.codePointAt(0) ?? 0)).toBe(true);
    for (const c of ["\\", "(", ")", "~", "\t", "\n", "é", "…", "%", "+", "="]) {
      expect(isConfirmChar(c.codePointAt(0) ?? 0)).toBe(false);
    }
  });
  test("the cap is 200", () => {
    expect(CONFIRM_MAX_LENGTH).toBe(200);
  });
});

describe("isSensitiveFieldName", () => {
  test("matches a sensitive word as a whole word or a camelCase/snake_case/kebab part", () => {
    for (const n of [
      "key",
      "apiKey",
      "api_key",
      "api-key",
      "API_KEY",
      "token",
      "accessToken",
      "secret",
      "clientSecret",
      "password",
      "passwordHash",
      "credential",
      "credentials",
      "bearer",
      "auth",
      "authToken",
      "authorization",
      "privateKey",
    ]) {
      expect(isSensitiveFieldName(n)).toBe(true);
    }
  });
  test("does not match a word that merely contains one", () => {
    for (const n of [
      "author",
      "keywords",
      "monkey",
      "tokenizer",
      "owner",
      "repo",
      "pullNumber",
      "authority",
    ]) {
      expect(isSensitiveFieldName(n)).toBe(false);
    }
  });
  test("a key part inside a longer camelCase name is still a part", () => {
    expect(isSensitiveFieldName("environmentKey")).toBe(true);
    expect(isSensitiveFieldName("flagKey")).toBe(true);
    expect(isSensitiveFieldName("projectKey")).toBe(true);
  });
});
