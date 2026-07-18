import { describe, expect, test } from "bun:test";
import { createGitHubApi } from "./gh-api.ts";

function fakeFetch(
  capture: { url?: string; headers?: Record<string, string> },
  body: unknown,
  status = 200,
) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    capture.url = String(url);
    capture.headers = (init?.headers ?? {}) as Record<string, string>;
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}

describe("createGitHubApi", () => {
  test("getReleaseByTag builds the tag URL with auth + api-version headers", async () => {
    const cap: { url?: string; headers?: Record<string, string> } = {};
    const api = createGitHubApi({
      token: "t0",
      repo: "o/r",
      fetchFn: fakeFetch(cap, { tag_name: "v1.2.3", assets: [{ name: "a", size: 3 }] }),
    });
    const rel = await api.getReleaseByTag("v1.2.3");
    expect(cap.url).toBe("https://api.github.com/repos/o/r/releases/tags/v1.2.3");
    expect(cap.headers?.authorization).toBe("Bearer t0");
    expect(cap.headers?.["x-github-api-version"]).toBe("2022-11-28");
    expect(rel).toEqual({ tagName: "v1.2.3", assets: [{ name: "a", size: 3 }] });
  });

  test("getReleaseByTag returns null on 404", async () => {
    const api = createGitHubApi({ token: "t", repo: "o/r", fetchFn: fakeFetch({}, {}, 404) });
    expect(await api.getReleaseByTag("v9")).toBeNull();
  });
});
