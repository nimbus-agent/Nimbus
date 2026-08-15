import { describe, expect, test } from "bun:test";
import { joinApiPath } from "./join-api-path.ts";

const BASE = "https://api.example.com/v2";

describe("joinApiPath", () => {
  test("joins a leading-slash path onto the base", () => {
    expect(joinApiPath(BASE, "/issues")).toBe("https://api.example.com/v2/issues");
  });

  test("adds the separator when the path has none", () => {
    expect(joinApiPath(BASE, "issues")).toBe("https://api.example.com/v2/issues");
  });

  test("passes an absolute URL straight through — pagination cursors arrive absolute", () => {
    const next = "https://api.example.com/v2/issues?page=2";
    expect(joinApiPath(BASE, next)).toBe(next);
    expect(joinApiPath(BASE, "http://legacy.example.com/x")).toBe("http://legacy.example.com/x");
  });

  /**
   * The prefix test is `http://` / `https://`, NOT a bare `http`. With a bare
   * `http` a RELATIVE path that merely starts with those four letters —
   * `httpbin/status`, or a real-world `http-headers` endpoint — was returned
   * unjoined, silently dropping the base URL and producing a request to a
   * relative path. It is a narrow case, which is exactly why it would have been
   * found in production rather than review.
   */
  test("joins a relative path that merely begins with 'http'", () => {
    expect(joinApiPath(BASE, "httpbin/status")).toBe("https://api.example.com/v2/httpbin/status");
    expect(joinApiPath(BASE, "/http-headers")).toBe("https://api.example.com/v2/http-headers");
  });

  test("preserves query strings and encoded characters verbatim", () => {
    expect(joinApiPath(BASE, "/search?q=a%20b&limit=10")).toBe(
      "https://api.example.com/v2/search?q=a%20b&limit=10",
    );
  });

  test("does not normalise a trailing slash on the base — callers own that", () => {
    expect(joinApiPath("https://api.example.com/", "/x")).toBe("https://api.example.com//x");
  });

  test("an empty path yields the base plus a separator", () => {
    expect(joinApiPath(BASE, "")).toBe("https://api.example.com/v2/");
  });
});
