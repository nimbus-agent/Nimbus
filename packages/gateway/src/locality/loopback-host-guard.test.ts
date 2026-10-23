import { describe, expect, test } from "bun:test";
import { isAllowedLoopbackHostHeader, rejectNonLoopbackHost } from "./loopback-host-guard.ts";

describe("isAllowedLoopbackHostHeader", () => {
  test.each([
    "127.0.0.1",
    "127.0.0.1:8787",
    "localhost",
    "localhost:8787",
    "LOCALHOST:8787",
    "[::1]:8787",
    "127.5.6.7:1",
  ])("allows loopback host %p", (host) => {
    expect(isAllowedLoopbackHostHeader(host)).toBe(true);
  });

  test("allows a request with no Host header (a raw local client, never a browser)", () => {
    expect(isAllowedLoopbackHostHeader(null)).toBe(true);
  });

  test.each([
    "evil.example:8787",
    "evil.example",
    "127.0.0.1.evil.example",
    "localhost.evil.example:8787",
    "192.168.1.10:8787",
    "evil.example@127.0.0.1",
    "127.0.0.1/../",
    "",
    "   ",
    "[::2]:8787",
  ])("refuses non-loopback or malformed host %p", (host) => {
    expect(isAllowedLoopbackHostHeader(host)).toBe(false);
  });
});

describe("rejectNonLoopbackHost", () => {
  test("returns null for a loopback Host", () => {
    const req = new Request("http://127.0.0.1:8787/v1/items", {
      headers: { host: "127.0.0.1:8787" },
    });
    expect(rejectNonLoopbackHost(req)).toBeNull();
  });

  test("returns a 403 for a rebound Host", async () => {
    const req = new Request("http://127.0.0.1:8787/v1/items", {
      headers: { host: "evil.example:8787" },
    });
    const res = rejectNonLoopbackHost(req);
    expect(res?.status).toBe(403);
    expect(await res?.text()).toContain("loopback");
  });
});
