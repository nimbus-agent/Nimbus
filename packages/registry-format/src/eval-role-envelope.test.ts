import { describe, expect, test } from "bun:test";
import { isObject, parseEvalRoleEnvelope } from "./eval-role-envelope.ts";

describe("parseEvalRoleEnvelope", () => {
  test("reads the ok shape and keeps the whole object", () => {
    const text = JSON.stringify({ ok: true, extensionId: "a", version: "1.0.0", extra: 1 });
    expect(parseEvalRoleEnvelope(text)).toEqual({
      kind: "ok",
      extensionId: "a",
      version: "1.0.0",
      raw: { ok: true, extensionId: "a", version: "1.0.0", extra: 1 },
    });
  });

  test("reads the error shape", () => {
    const text = JSON.stringify({ ok: false, error: { code: "X", message: "m", more: 1 } });
    expect(parseEvalRoleEnvelope(text)).toEqual({
      kind: "error",
      error: { code: "X", message: "m" },
    });
  });

  test.each([
    ["not json", "{"],
    ["an array", "[]"],
    ["a string", '"x"'],
    ["no ok flag", "{}"],
    ["a malformed error", JSON.stringify({ ok: false, error: { code: 1, message: "m" } })],
    ["an error that is not an object", JSON.stringify({ ok: false, error: "x" })],
    ["a missing extension id", JSON.stringify({ ok: true, version: "1" })],
    ["a non-string version", JSON.stringify({ ok: true, extensionId: "a", version: 1 })],
  ])("is null for %s", (_name, text) => {
    expect(parseEvalRoleEnvelope(text)).toBeNull();
  });
});

describe("isObject", () => {
  test("rejects null and arrays", () => {
    expect(isObject({})).toBe(true);
    expect(isObject(null)).toBe(false);
    expect(isObject([])).toBe(false);
  });
});
