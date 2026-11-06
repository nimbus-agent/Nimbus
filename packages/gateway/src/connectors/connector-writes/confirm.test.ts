// packages/gateway/src/connectors/connector-writes/confirm.test.ts
import { describe, expect, test } from "bun:test";
import { CONFIRM_NO_TARGET_REASON, confirmPromptLine, renderConfirmText } from "./confirm.ts";
import { type ConnectorWriteRow, row, textField, withConfirm, withPreview } from "./types.ts";

function confirmRow(template: string, actionType = "github.pr.merge"): ConnectorWriteRow {
  return withConfirm(row("github_pr_merge", actionType, "mesh", 4), { template });
}

function text(r: ConnectorWriteRow, input: unknown): string {
  const out = renderConfirmText(r, input);
  if (!out.ok) throw new Error(out.reason);
  return out.text;
}

function reason(r: ConnectorWriteRow, input: unknown): string {
  const out = renderConfirmText(r, input);
  if (out.ok) throw new Error(`expected a refusal, got ${out.text}`);
  return out.reason;
}

describe("renderConfirmText", () => {
  test("renders <service>/<template> from strings and numbers", () => {
    const r = confirmRow("{owner}/{repo}#{pullNumber}");
    expect(text(r, { owner: "acme", repo: "api", pullNumber: 42 })).toBe("github/acme/api#42");
  });

  test("uses the service of the action type", () => {
    const r = confirmRow("{name}@{id}", "argocd.app.rollback");
    expect(text(r, { name: "web", id: 12 })).toBe("argocd/web@12");
  });

  test("an array joins with single spaces in input order (a comma is outside the confirm character set); two arrays work", () => {
    const r = confirmRow("{instanceIds}", "aws.ec2.instance.stop");
    expect(text(r, { instanceIds: ["i-0a1", "i-0b2"] })).toBe("aws/i-0a1 i-0b2");
    const two = confirmRow("{a}/{b}");
    expect(text(two, { a: ["x", "y"], b: ["z", 3] })).toBe("github/x y/z 3");
  });

  test("trims and collapses whitespace runs in every value", () => {
    const r = confirmRow("{a}/{b}");
    expect(text(r, { a: "  my \t\n  app ", b: ["  p   q  ", "r"] })).toBe("github/my app/p q r");
  });

  test("trailing whitespace-only tails and leading runs leave no stray space", () => {
    const r = confirmRow("{a}");
    expect(text(r, { a: "  x " })).toBe("github/x");
  });

  test("tail8 keeps the last 8 characters, or the whole id when shorter", () => {
    const r = confirmRow("{eventId:tail8}", "outlook.calendar.delete");
    expect(text(r, { eventId: "AAMkAGI2THVSAAA1B2c3D4" })).toBe("outlook/A1B2c3D4");
    expect(text(r, { eventId: "short" })).toBe("outlook/short");
    expect(text(r, { eventId: "12345678" })).toBe("outlook/12345678");
  });

  test.each([
    ["unset", {}],
    ["undefined", { a: undefined }],
    ["null", { a: null }],
    ["empty string", { a: "" }],
    ["whitespace only", { a: " \t " }],
    ["boolean", { a: true }],
    ["object", { a: { x: 1 } }],
    ["NaN", { a: Number.NaN }],
    ["Infinity", { a: Number.POSITIVE_INFINITY }],
    ["empty array", { a: [] }],
    ["array holding an object", { a: ["x", { y: 1 }] }],
    ["array holding an empty string", { a: ["x", ""] }],
    ["array holding null", { a: [null] }],
  ])("refuses %s", (_name, input) => {
    expect(reason(confirmRow("{a}"), input)).toBe("confirm: field a is not a usable value");
  });

  test("refuses an inherited key", () => {
    expect(reason(confirmRow("{constructor}"), {})).toBe(
      "confirm: field constructor is not a usable value",
    );
  });

  test("refuses the preview's (not set) placeholder text", () => {
    expect(reason(confirmRow("{a}"), { a: "(not set)" })).toBe(
      "confirm: the target has characters that cannot be typed",
    );
  });

  test("refuses control characters, bidi marks, zero-width marks and non-ASCII", () => {
    const r = confirmRow("{a}");
    for (const bad of [
      "a\u0007b",
      "a\u001bb",
      "a‮b",
      "a⁦b",
      "a​b",
      "a﻿b",
      "café",
      "a…b",
      "a\b",
      "a(b)",
      "a~b",
    ]) {
      expect(reason(r, { a: bad })).toBe("confirm: the target has characters that cannot be typed");
    }
  });

  test("the cap is 200 characters: 200 passes, 201 is refused, never truncated", () => {
    const r = confirmRow("{a}");
    const room = 200 - "github/".length;
    expect(text(r, { a: "x".repeat(room) })).toHaveLength(200);
    expect(reason(r, { a: "x".repeat(room + 1) })).toBe("confirm: the target is too long to type");
  });

  test("a row with no confirm, a malformed stored template and a non-object input are refused", () => {
    expect(reason(row("x_y", "x.y", "mesh", 4), {})).toBe(CONFIRM_NO_TARGET_REASON);
    const bad: ConnectorWriteRow = {
      ...row("x_y", "x.y", "mesh", 4),
      confirm: { template: "none" },
    };
    expect(reason(bad, {})).toBe("confirm: template names no placeholder");
    const ok = confirmRow("{a}");
    for (const input of [undefined, null, "s", 5, ["a"], new Date()]) {
      expect(reason(ok, input)).toBe("confirm: the tool input is not an object");
    }
  });

  test("a null-prototype input is a plain object", () => {
    const input = Object.assign(Object.create(null) as Record<string, unknown>, { a: "ok" });
    expect(text(confirmRow("{a}"), input)).toBe("github/ok");
  });

  test("no refusal reason carries an input value", () => {
    const r = confirmRow("{a}");
    expect(reason(r, { a: "secret\u0007value" })).not.toContain("secret");
  });
});

describe("confirmPromptLine", () => {
  test("is the fixed line", () => {
    expect(confirmPromptLine("github/acme/api#42")).toBe(
      "To approve, type exactly: github/acme/api#42",
    );
  });
});

describe("withConfirm declaration checks", () => {
  const base = row("t_x", "t.x", "write", 4);
  const withSecret = withPreview(base, {
    target: "{name}",
    summary: "s",
    fields: [
      textField("name"),
      { key: "apiToken", label: "t", kind: "secret" },
      { key: "blob", label: "b", kind: "secret" },
    ],
  });

  test("a valid template is stored on a frozen copy", () => {
    const r = withConfirm(base, { template: "{a}/{b:tail8}" });
    expect(r.confirm).toEqual({ template: "{a}/{b:tail8}" });
    expect(Object.isFrozen(r)).toBe(true);
    expect(base.confirm).toBeUndefined();
  });

  test("refuses a template with no placeholder, an unknown shape or modifier", () => {
    expect(() => withConfirm(base, { template: "fixed" })).toThrow(/names no placeholder/);
    expect(() => withConfirm(base, { template: "{a" })).toThrow(/unclosed/);
    expect(() => withConfirm(base, { template: "{a:head8}" })).toThrow(/unknown modifier/);
  });

  test("refuses a placeholder the preview marks secret, though the name looks innocent", () => {
    expect(() => withConfirm(withSecret, { template: "{blob}" })).toThrow(/secret-looking field/);
  });

  test("refuses a sensitive-looking name with a preview template", () => {
    expect(() => withConfirm(withSecret, { template: "{apiToken}" })).toThrow(
      /secret-looking field/,
    );
  });

  test("refuses a sensitive-looking name on a row with no preview template", () => {
    for (const n of ["password", "clientSecret", "access_token", "apiKey", "bearer", "auth"]) {
      expect(() => withConfirm(base, { template: `{${n}}` })).toThrow(/secret-looking field/);
    }
  });

  test("a name that merely contains a sensitive word is allowed", () => {
    expect(() => withConfirm(base, { template: "{author}/{keywords}" })).not.toThrow();
  });
});
