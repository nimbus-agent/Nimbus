import { describe, expect, test } from "bun:test";

import { isNetworkNarrowed, networkEntryKey, normaliseHost } from "./network-entry-key.ts";

describe("isNetworkNarrowed", () => {
  test("an approved list missing a declared entry is narrowed", () => {
    expect(
      isNetworkNarrowed(["api.example.com", "imap.example.com:993"], ["api.example.com"]),
    ).toBe(true);
    expect(isNetworkNarrowed(["api.example.com"], [])).toBe(true);
  });

  test("the same list in another spelling or order is not narrowed", () => {
    expect(
      isNetworkNarrowed(
        ["api.example.com", "imap.example.com:993"],
        ["imap.example.com:993", "API.example.com.:443"],
      ),
    ).toBe(false);
  });

  test("nothing declared is never narrowed", () => {
    expect(isNetworkNarrowed([], [])).toBe(false);
  });
});

describe("normaliseHost", () => {
  test("lowercases and drops one trailing dot", () => {
    expect(normaliseHost("API.Example.com.")).toBe("api.example.com");
    expect(normaliseHost("api.example.com")).toBe("api.example.com");
  });

  test("drops only one trailing dot", () => {
    expect(normaliseHost("a.example.com..")).toBe("a.example.com.");
  });
});

describe("networkEntryKey", () => {
  test("host lowercased, trailing dot dropped, 443 by default", () => {
    expect(networkEntryKey("API.example.com.")).toBe("api.example.com:443");
    expect(networkEntryKey("api.example.com:443")).toBe("api.example.com:443");
  });

  test("an explicit port is kept", () => {
    expect(networkEntryKey("imap.example.com:993")).toBe("imap.example.com:993");
  });
});
