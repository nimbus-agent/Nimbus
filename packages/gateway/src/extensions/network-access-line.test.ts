import { describe, expect, test } from "bun:test";

import { networkAccessLine } from "./network-access-line.ts";

describe("networkAccessLine", () => {
  test("Windows says the host list is not enforced", () => {
    expect(networkAccessLine("win32", ["readwise.io", "api.example.com"])).toBe(
      "network access (Windows cannot limit this to readwise.io, api.example.com)",
    );
  });

  test("Linux names the hosts the sandbox limits it to", () => {
    expect(networkAccessLine("linux", ["readwise.io"])).toBe("network access to readwise.io");
  });

  test("macOS names the ports it enforces and says the host list is not a limit", () => {
    expect(networkAccessLine("darwin", ["readwise.io"])).toBe(
      "network access to any host on port 443 (macOS cannot limit this to readwise.io)",
    );
    expect(networkAccessLine("darwin", ["a.com", "b.com", "c.com:993"])).toBe(
      "network access to any host on ports 443, 993 (macOS cannot limit this to a.com, b.com, c.com:993)",
    );
  });

  test("no hosts means no network on every OS, with no caveat", () => {
    for (const platform of ["win32", "darwin", "linux"] as const) {
      expect(networkAccessLine(platform, [])).toBe("no network access");
    }
  });
});
