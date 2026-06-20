import { describe, expect, test } from "bun:test";

import { resolveUrlWithBase } from "./fetch-bearer-json.ts";

const GRAPH = "https://graph.microsoft.com/v1.0";

describe("resolveUrlWithBase", () => {
  test("prefixes a relative path with the base", () => {
    expect(resolveUrlWithBase(GRAPH, "/me/messages")).toBe(`${GRAPH}/me/messages`);
  });

  test("allows an absolute URL on the SAME origin as the base (legit @odata.nextLink)", () => {
    const next = "https://graph.microsoft.com/v1.0/me/messages?$skip=10";
    expect(resolveUrlWithBase(GRAPH, next)).toBe(next);
    // A different path on the same origin (Graph sometimes paginates onto the beta host's sibling path)
    expect(resolveUrlWithBase(GRAPH, "https://graph.microsoft.com/v1.0/me/mailFolders")).toBe(
      "https://graph.microsoft.com/v1.0/me/mailFolders",
    );
  });

  test("REJECTS a cross-origin absolute URL (token-exfil / SSRF guard)", () => {
    expect(() => resolveUrlWithBase(GRAPH, "https://attacker.example.com/steal")).toThrow(
      /cross-origin/i,
    );
    // Look-alike host must also be rejected (substring tricks).
    expect(() =>
      resolveUrlWithBase(GRAPH, "https://graph.microsoft.com.attacker.example/steal"),
    ).toThrow(/cross-origin/i);
    // Scheme downgrade to a different origin.
    expect(() => resolveUrlWithBase(GRAPH, "http://graph.microsoft.com/v1.0/me")).toThrow(
      /cross-origin/i,
    );
  });

  test("rejects a malformed absolute URL", () => {
    expect(() => resolveUrlWithBase(GRAPH, "http://")).toThrow();
  });
});
