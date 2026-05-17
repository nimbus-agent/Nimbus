import { describe, expect, it } from "bun:test";
import { validateAndNormalizePermissions } from "./permissions-validator";

describe("validateAndNormalizePermissions", () => {
  it("accepts an empty object form", () => {
    const result = validateAndNormalizePermissions({});
    expect(result).toEqual({ network: [], filesystem: { read: [], write: [] } });
  });

  it("preserves declared network hosts", () => {
    const result = validateAndNormalizePermissions({ network: ["api.github.com"] });
    expect(result.network).toEqual(["api.github.com"]);
  });

  it("preserves filesystem.read + filesystem.write", () => {
    const result = validateAndNormalizePermissions({
      filesystem: { read: ["/home/u/notes"], write: ["/home/u/notes/.tmp"] },
    });
    expect(result.filesystem).toEqual({ read: ["/home/u/notes"], write: ["/home/u/notes/.tmp"] });
  });

  it("normalizes legacy array form to default-deny", () => {
    const result = validateAndNormalizePermissions(["read-files", "trash"]);
    expect(result).toEqual({ network: [], filesystem: { read: [], write: [] } });
  });

  it("rejects unknown top-level keys", () => {
    expect(() => validateAndNormalizePermissions({ unknownKey: 1 } as never)).toThrow(
      /unknown permission/i,
    );
  });

  it("rejects malformed hostnames", () => {
    expect(() => validateAndNormalizePermissions({ network: ["evil host with spaces"] })).toThrow(
      /RFC 1123/i,
    );
  });

  it("rejects trailing-hyphen hostnames per RFC 1123", () => {
    expect(() => validateAndNormalizePermissions({ network: ["api-.github.com"] })).toThrow(
      /RFC 1123/i,
    );
    expect(() => validateAndNormalizePermissions({ network: ["github.com-"] })).toThrow(
      /RFC 1123/i,
    );
  });

  it("rejects empty-string hostnames", () => {
    expect(() => validateAndNormalizePermissions({ network: [""] })).toThrow(/RFC 1123/i);
  });

  it("rejects relative paths with ..", () => {
    expect(() => validateAndNormalizePermissions({ filesystem: { read: ["../etc"] } })).toThrow(
      /\.\./,
    );
  });

  it("rejects non-string entries in network", () => {
    expect(() => validateAndNormalizePermissions({ network: [42 as unknown as string] })).toThrow();
  });
});
