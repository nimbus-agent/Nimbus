import { describe, expect, test } from "bun:test";

import { networkAccessLine } from "./network-access-line.ts";

describe("networkAccessLine", () => {
  test("Windows says the host list is not enforced", () => {
    expect(networkAccessLine("win32", ["readwise.io", "api.example.com"])).toBe(
      "network access (Windows cannot limit this to readwise.io, api.example.com)",
    );
  });

  test("macOS and Linux name the hosts the sandbox limits it to", () => {
    for (const platform of ["darwin", "linux"] as const) {
      expect(networkAccessLine(platform, ["readwise.io"])).toBe("network access to readwise.io");
    }
  });

  test("no hosts means no network on every OS, with no caveat", () => {
    for (const platform of ["win32", "darwin", "linux"] as const) {
      expect(networkAccessLine(platform, [])).toBe("no network access");
    }
  });
});
