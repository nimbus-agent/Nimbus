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

  test("refuses two adjacent placeholders (the text would not be injective), with or without a modifier", () => {
    for (const t of ["x {a}{b}", "{a}{b}", "{a:tail8}{b}", "{a}{b:tail8} y"]) {
      expect(parseConfirmTemplate(t), t).toEqual({
        ok: false,
        reason: "has two adjacent placeholders",
      });
    }
    expect(parseConfirmTemplate("{a}/{b}").ok).toBe(true);
  });

  test("refuses an = in literal text (it is allowed in values only)", () => {
    expect(parseConfirmTemplate("a={b}").ok).toBe(false);
    expect(parseConfirmTemplate("{a}={b}").ok).toBe(false);
    expect(parseConfirmTemplate("x {a}").ok).toBe(true);
  });

  test("refuses literal text outside the confirm character set", () => {
    const r = parseConfirmTemplate("{a}é");
    expect(r.ok).toBe(false);
    expect(parseConfirmTemplate("{a}(b)").ok).toBe(false);
  });

  test("confirmTemplateKeys lists the field names in order, repeats once", () => {
    const r = parseConfirmTemplate("{b}/{a}/{b}");
    if (!r.ok) throw new Error("parse");
    expect(confirmTemplateKeys(r.segments)).toEqual(["b", "a"]);
  });
});

describe("isConfirmChar", () => {
  test("allows exactly letters, digits, space and _ - . / backslash : # @ ! =", () => {
    for (const c of "azAZ09 _-./:#@!=" + String.fromCharCode(92))
      expect(isConfirmChar(c.codePointAt(0) ?? 0)).toBe(true);
    for (const c of ["(", ")", "~", "\t", "\n", "é", "…", "%", "+"]) {
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

describe("confirm-template: remaining branches", () => {
  test("names the exact refusal for each placeholder defect", () => {
    expect(parseConfirmTemplate("a/{}")).toEqual({
      ok: false,
      reason: "has a placeholder {} with a bad name",
    });
    expect(parseConfirmTemplate("a/{1abc}")).toEqual({
      ok: false,
      reason: "has a placeholder {1abc} with a bad name",
    });
    expect(parseConfirmTemplate("a/{ab-c}")).toEqual({
      ok: false,
      reason: "has a placeholder {ab-c} with a bad name",
    });
    expect(parseConfirmTemplate("a/{x:head8}")).toEqual({
      ok: false,
      reason: "has a placeholder {x:head8} with an unknown modifier",
    });
    expect(parseConfirmTemplate("a/{x:}")).toEqual({
      ok: false,
      reason: "has a placeholder {x:} with an unknown modifier",
    });
    expect(parseConfirmTemplate("a/{x{y}}")).toEqual({ ok: false, reason: "has a nested {" });
    expect(parseConfirmTemplate("a/{x")).toEqual({ ok: false, reason: "has an unclosed {" });
    expect(parseConfirmTemplate("a}/{x}")).toEqual({ ok: false, reason: "has a stray }" });
  });

  test("an empty template names no placeholder; a leading placeholder has no text segment", () => {
    expect(parseConfirmTemplate("")).toEqual({ ok: false, reason: "names no placeholder" });
    expect(parseConfirmTemplate("{x}")).toEqual({
      ok: true,
      segments: [{ kind: "field", name: "x", tail8: false }],
    });
  });

  test("a field name may hold digits and underscores after its first character", () => {
    expect(parseConfirmTemplate("_a1_b2/{_a1_b2}").ok).toBe(true);
  });

  test("sensitive names: acronym runs, digits and separators split into words", () => {
    expect(isSensitiveFieldName("APIKey")).toBe(true);
    expect(isSensitiveFieldName("v2Token")).toBe(true);
    expect(isSensitiveFieldName("api__key")).toBe(true);
    expect(isSensitiveFieldName("_secret")).toBe(true);
    expect(isSensitiveFieldName("URL")).toBe(false);
    expect(isSensitiveFieldName("")).toBe(false);
    expect(isSensitiveFieldName("author")).toBe(false);
    expect(isSensitiveFieldName("AUTH")).toBe(true);
  });
});
