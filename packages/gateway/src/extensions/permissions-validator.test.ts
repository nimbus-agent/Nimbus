import { describe, expect, it } from "bun:test";
import { parseNetworkEntry, validateAndNormalizePermissions } from "./permissions-validator";

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
    expect(() => validateAndNormalizePermissions({ unknownKey: 1 })).toThrow(/unknown permission/i);
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

  // --- per-host port syntax (Tier 4: IMAP/SMTP need non-443 TCP) ---

  it("preserves a host:port network entry verbatim", () => {
    const result = validateAndNormalizePermissions({ network: ["imap.fastmail.com:993"] });
    expect(result.network).toEqual(["imap.fastmail.com:993"]);
  });

  it("accepts a mix of bare-host and host:port entries", () => {
    const result = validateAndNormalizePermissions({
      network: ["api.fastmail.com", "imap.fastmail.com:993", "smtp.fastmail.com:465"],
    });
    expect(result.network).toEqual([
      "api.fastmail.com",
      "imap.fastmail.com:993",
      "smtp.fastmail.com:465",
    ]);
  });

  it("rejects a port below 1", () => {
    expect(() => validateAndNormalizePermissions({ network: ["imap.x.com:0"] })).toThrow(/port/i);
  });

  it("rejects a port above 65535", () => {
    expect(() => validateAndNormalizePermissions({ network: ["imap.x.com:65536"] })).toThrow(
      /port/i,
    );
  });

  it("rejects a non-numeric port", () => {
    expect(() => validateAndNormalizePermissions({ network: ["imap.x.com:imap"] })).toThrow(
      /port/i,
    );
  });

  it("rejects an empty port after the colon", () => {
    expect(() => validateAndNormalizePermissions({ network: ["imap.x.com:"] })).toThrow(/port/i);
  });

  it("still validates the host part of a host:port entry per RFC 1123", () => {
    expect(() => validateAndNormalizePermissions({ network: ["bad host:993"] })).toThrow(
      /RFC 1123/i,
    );
  });
});

describe("parseNetworkEntry", () => {
  it("defaults a bare host to port 443", () => {
    expect(parseNetworkEntry("api.github.com")).toEqual({ host: "api.github.com", port: 443 });
  });

  it("parses an explicit host:port", () => {
    expect(parseNetworkEntry("imap.fastmail.com:993")).toEqual({
      host: "imap.fastmail.com",
      port: 993,
    });
  });
});
