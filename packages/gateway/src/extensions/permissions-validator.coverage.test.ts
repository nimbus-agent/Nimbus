/**
 * Refusals of the sandbox-permissions validator that `permissions-validator.test.ts` does not
 * reach. These shapes decide what an extension's sandbox may touch, so every malformed one must be
 * REFUSED rather than coerced into a grant — each is pinned to its own error.
 */
import { describe, expect, test } from "bun:test";
import { validateAndNormalizePermissions } from "./permissions-validator.ts";

function refusal(input: unknown): Error {
  try {
    validateAndNormalizePermissions(input);
  } catch (e) {
    if (e instanceof Error) return e;
    throw e;
  }
  throw new Error("expected the permissions to be refused");
}

describe("validateAndNormalizePermissions refusals", () => {
  test.each([
    ["null", null],
    ["a string", "network"],
    ["a number", 7],
    ["undefined", undefined],
  ])("permissions that are %s are refused, not defaulted to an empty grant", (_label, input) => {
    const e = refusal(input);
    expect(e).toBeInstanceOf(TypeError);
    expect(e.message).toBe("permissions must be an object or legacy string[]");
  });

  test("a network field that is not an array is refused", () => {
    const e = refusal({ network: "api.example.com" });
    expect(e).toBeInstanceOf(TypeError);
    expect(e.message).toBe("permissions.network must be an array");
  });

  test.each([
    ["null", null],
    ["a string", "/home"],
  ])("a filesystem field that is %s is refused", (_label, filesystem) => {
    const e = refusal({ filesystem });
    expect(e).toBeInstanceOf(TypeError);
    expect(e.message).toBe("permissions.filesystem must be an object");
  });

  test("an unknown filesystem key (e.g. 'execute') is refused rather than ignored", () => {
    const e = refusal({ filesystem: { read: [], execute: ["/bin"] } });
    expect(e.message).toBe("unknown permissions.filesystem key: execute");
  });

  test("a filesystem list that is not an array is refused, naming which list", () => {
    const e = refusal({ filesystem: { write: "/tmp" } });
    expect(e).toBeInstanceOf(TypeError);
    expect(e.message).toBe("permissions.filesystem.write must be an array");
    expect(e.message).not.toContain(".read");
  });

  test("a non-string path entry is refused, naming which list", () => {
    const e = refusal({ filesystem: { read: ["/data", 42] } });
    expect(e).toBeInstanceOf(TypeError);
    expect(e.message).toBe("permissions.filesystem.read entries must be strings");
    expect(e.message).not.toContain(".write");
  });

  test("a Windows-style '..' segment is refused just like a POSIX one", () => {
    const e = refusal({ filesystem: { write: ["C:\\data\\..\\Windows"] } });
    expect(e.message).toBe("permissions.filesystem.write: C:\\data\\..\\Windows contains '..'");
  });

  test("an object with only one of read/write fills the other with an empty grant", () => {
    expect(validateAndNormalizePermissions({ filesystem: { read: ["/data"] } })).toEqual({
      network: [],
      filesystem: { read: ["/data"], write: [] },
    });
  });
});
