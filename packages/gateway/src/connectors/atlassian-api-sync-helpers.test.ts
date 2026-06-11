import { describe, expect, test } from "bun:test";

import { basicAuthHeader, normalizeAtlassianSiteBaseUrl } from "./atlassian-api-sync-helpers.ts";

describe("normalizeAtlassianSiteBaseUrl", () => {
  test("returns empty string for empty input (line 7-8 empty arm)", () => {
    expect(normalizeAtlassianSiteBaseUrl("")).toBe("");
  });

  test("strips trailing slash from https URL", () => {
    expect(normalizeAtlassianSiteBaseUrl("https://x.atlassian.net/")).toBe(
      "https://x.atlassian.net",
    );
  });

  test("strips multiple trailing slashes", () => {
    expect(normalizeAtlassianSiteBaseUrl("https://x.atlassian.net///")).toBe(
      "https://x.atlassian.net",
    );
  });

  test("leaves http URL unchanged (startsWith http true arm, line 10)", () => {
    expect(normalizeAtlassianSiteBaseUrl("http://x")).toBe("http://x");
  });

  test("prepends https:// when scheme is absent (startsWith http false arm, line 10)", () => {
    expect(normalizeAtlassianSiteBaseUrl("x.atlassian.net")).toBe("https://x.atlassian.net");
  });

  test("prepends https:// for bare host with trailing slash stripped", () => {
    expect(normalizeAtlassianSiteBaseUrl("x.atlassian.net/")).toBe("https://x.atlassian.net");
  });
});

describe("basicAuthHeader", () => {
  test("produces correct Basic auth header", () => {
    const email = "a@b.com";
    const token = "tok";
    const expected = `Basic ${Buffer.from(`${email}:${token}`, "utf8").toString("base64")}`;
    expect(basicAuthHeader(email, token)).toBe(expected);
  });

  test("encodes special characters correctly", () => {
    const email = "user+tag@example.com";
    const token = "tok/en=val";
    const expected = `Basic ${Buffer.from(`${email}:${token}`, "utf8").toString("base64")}`;
    expect(basicAuthHeader(email, token)).toBe(expected);
  });
});
