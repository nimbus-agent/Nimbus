import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  fetchAtlassianBasicAuthJsonText,
  normalizeRequiredSiteBaseUrl,
  requireTrimmedEnv,
} from "./atlassian-json-fetch.ts";

describe("normalizeRequiredSiteBaseUrl", () => {
  test("adds https:// to a bare host", () => {
    expect(normalizeRequiredSiteBaseUrl("acme.atlassian.net", "missing")).toBe(
      "https://acme.atlassian.net",
    );
  });

  test("leaves an explicit scheme alone, including http", () => {
    expect(normalizeRequiredSiteBaseUrl("https://acme.atlassian.net", "missing")).toBe(
      "https://acme.atlassian.net",
    );
    // `startsWith("http")` matches http:// too — a self-hosted instance on plain
    // http must NOT be silently rewritten to https, which would fail to connect
    // and look like a credential problem.
    expect(normalizeRequiredSiteBaseUrl("http://jira.internal", "missing")).toBe(
      "http://jira.internal",
    );
  });

  test("strips trailing slashes before deciding", () => {
    expect(normalizeRequiredSiteBaseUrl("acme.atlassian.net///", "missing")).toBe(
      "https://acme.atlassian.net",
    );
  });

  test("throws the CALLER's message when the value is empty or only slashes", () => {
    // The message is passed in so each connector can name its own env var; a
    // generic error here would leave an operator guessing which one is unset.
    expect(() => normalizeRequiredSiteBaseUrl("", "JIRA_URL is not set")).toThrow(
      "JIRA_URL is not set",
    );
    expect(() => normalizeRequiredSiteBaseUrl("///", "JIRA_URL is not set")).toThrow(
      "JIRA_URL is not set",
    );
  });
});

describe("requireTrimmedEnv", () => {
  const KEY = "NIMBUS_TEST_ATLASSIAN_ENV";
  afterEach(() => {
    delete process.env[KEY];
  });

  test("returns the trimmed value", () => {
    process.env[KEY] = "  token-value  ";
    expect(requireTrimmedEnv(KEY, "unset")).toBe("token-value");
  });

  test("throws when unset", () => {
    expect(() => requireTrimmedEnv(KEY, "TOKEN is not set")).toThrow("TOKEN is not set");
  });

  test("whitespace-only is treated as unset, not as a value", () => {
    // A variable exported as "" or " " is the common shape of a misconfigured
    // CI secret. Returning it would send a blank credential and surface as a
    // confusing 401 rather than a named configuration error.
    process.env[KEY] = "   ";
    expect(() => requireTrimmedEnv(KEY, "TOKEN is not set")).toThrow("TOKEN is not set");
  });
});

describe("fetchAtlassianBasicAuthJsonText", () => {
  const realFetch = globalThis.fetch;
  let seen: { url: string; init: RequestInit | undefined } | undefined;

  beforeEach(() => {
    seen = undefined;
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      seen = { url, init };
      return Promise.resolve(new Response('{"ok":1}', { status: 200 }));
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function headersOf(): Record<string, string> {
    return (seen?.init?.headers ?? {}) as Record<string, string>;
  }

  test("sends Accept and a Basic auth header, and returns the raw text", async () => {
    const out = await fetchAtlassianBasicAuthJsonText("https://x/api", "a@b.co", "tok");
    expect(out).toEqual({ ok: true, status: 200, text: '{"ok":1}' });
    expect(headersOf()["Accept"]).toBe("application/json");
    expect(headersOf()["Authorization"]).toBe(`Basic ${btoa("a@b.co:tok")}`);
  });

  test("adds Content-Type only when there is a body", async () => {
    await fetchAtlassianBasicAuthJsonText("https://x/api", "a@b.co", "tok");
    expect(headersOf()["Content-Type"]).toBeUndefined();

    await fetchAtlassianBasicAuthJsonText("https://x/api", "a@b.co", "tok", {
      method: "POST",
      body: "{}",
    });
    expect(headersOf()["Content-Type"]).toBe("application/json");
  });

  test("caller headers win over the defaults", async () => {
    // The spread order is the contract: a connector overriding Accept (say, for
    // an endpoint that returns CSV) must not have it silently restored.
    await fetchAtlassianBasicAuthJsonText("https://x/api", "a@b.co", "tok", {
      headers: { Accept: "text/csv" },
    });
    expect(headersOf()["Accept"]).toBe("text/csv");
    // ...but the auth header it did not override still survives.
    expect(headersOf()["Authorization"]).toBe(`Basic ${btoa("a@b.co:tok")}`);
  });

  test("reports a non-2xx without throwing, so the caller can read the body", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(new Response("nope", { status: 403 }))) as unknown as typeof fetch;
    const out = await fetchAtlassianBasicAuthJsonText("https://x/api", "a@b.co", "tok");
    // `ok:false` rather than a throw: Atlassian puts the useful diagnostic in
    // the error body, and throwing here would discard it.
    expect(out).toEqual({ ok: false, status: 403, text: "nope" });
  });
});
