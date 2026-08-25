import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  __resetJenkinsCrumbCacheForTests,
  getJenkinsCrumb,
  isSafeHeaderName,
  jenkinsAuthHeader,
  jenkinsBaseUrl,
  jenkinsFetchJson,
  jenkinsPost,
  jobApiRoot,
  jobPathFromFullName,
} from "./jenkins-api.ts";

const ORIG_FETCH = globalThis.fetch;
const SAVED_ENV: Record<string, string | undefined> = {};
function setEnv(k: string, v: string | undefined): void {
  if (!(k in SAVED_ENV)) SAVED_ENV[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}
function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

beforeEach(() => {
  __resetJenkinsCrumbCacheForTests();
});
afterEach(() => {
  globalThis.fetch = ORIG_FETCH;
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("jenkins-api pure helpers", () => {
  test("jobPathFromFullName encodes each path segment", () => {
    expect(jobPathFromFullName("my-job")).toBe("my-job");
    expect(jobPathFromFullName("folder/sub")).toBe("folder/job/sub");
  });
  test("jobPathFromFullName throws on empty / whitespace", () => {
    expect(() => jobPathFromFullName("")).toThrow(/empty/);
    expect(() => jobPathFromFullName("  /  ")).toThrow(/empty/);
  });
  test("jobApiRoot builds classic path", () => {
    expect(jobApiRoot("https://ci.example", "a/b")).toBe("https://ci.example/job/a/job/b");
  });
});

describe("env-derived config", () => {
  test("jenkinsBaseUrl trims and strips trailing slashes", () => {
    setEnv("JENKINS_BASE_URL", "  https://ci.example/  ");
    expect(jenkinsBaseUrl()).toBe("https://ci.example");
  });
  test("jenkinsBaseUrl throws when unset", () => {
    setEnv("JENKINS_BASE_URL", "");
    expect(() => jenkinsBaseUrl()).toThrow(/not set/);
  });
  test("jenkinsAuthHeader throws when user or token missing", () => {
    setEnv("JENKINS_USERNAME", "");
    setEnv("JENKINS_API_TOKEN", "tok");
    expect(() => jenkinsAuthHeader()).toThrow(/must be set/);
    setEnv("JENKINS_USERNAME", "user");
    setEnv("JENKINS_API_TOKEN", "");
    expect(() => jenkinsAuthHeader()).toThrow(/must be set/);
  });
  test("jenkinsAuthHeader encodes basic auth when both present", () => {
    setEnv("JENKINS_USERNAME", "user");
    setEnv("JENKINS_API_TOKEN", "tok");
    expect(jenkinsAuthHeader()).toMatch(/^Basic /);
  });
});

describe("getJenkinsCrumb", () => {
  test("returns crumb on ok + valid JSON, then serves from cache", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return jsonResponse({ crumb: "abc", crumbRequestField: "Jenkins-Crumb" });
    }) as unknown as typeof fetch;
    const first = await getJenkinsCrumb("https://ci", "Basic x");
    expect(first).toEqual({ field: "Jenkins-Crumb", value: "abc" });
    const second = await getJenkinsCrumb("https://ci", "Basic x");
    expect(second).toEqual(first);
    expect(calls).toBe(1);
  });
  test("caches null on non-ok response", async () => {
    globalThis.fetch = (async () => jsonResponse({}, false, 403)) as unknown as typeof fetch;
    expect(await getJenkinsCrumb("https://ci", "Basic x")).toBeNull();
  });
  test("caches null when JSON is not an object", async () => {
    globalThis.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => [1, 2, 3],
        text: async () => "[1,2,3]",
      }) as unknown as Response) as unknown as typeof fetch;
    expect(await getJenkinsCrumb("https://ci", "Basic x")).toBeNull();
  });
  test("caches null when crumb fields are missing", async () => {
    globalThis.fetch = (async () => jsonResponse({ crumb: "" })) as unknown as typeof fetch;
    expect(await getJenkinsCrumb("https://ci", "Basic x")).toBeNull();
  });
  test("caches null when json() throws", async () => {
    globalThis.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error("bad json");
        },
        text: async () => "x",
      }) as unknown as Response) as unknown as typeof fetch;
    expect(await getJenkinsCrumb("https://ci", "Basic x")).toBeNull();
  });
});

describe("jenkinsFetchJson", () => {
  test("returns parsed JSON on 200", async () => {
    globalThis.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        text: async () => '{"k":1}',
      }) as unknown as Response) as unknown as typeof fetch;
    const r = await jenkinsFetchJson("https://ci/api", { authHeader: "Basic x" });
    expect(r).toEqual({ ok: true, status: 200, text: '{"k":1}', json: { k: 1 } });
  });
  test("returns json:null on an unparseable body", async () => {
    globalThis.fetch = (async () =>
      ({
        ok: false,
        status: 500,
        text: async () => "<html>",
      }) as unknown as Response) as unknown as typeof fetch;
    const r = await jenkinsFetchJson("https://ci/api", { authHeader: "Basic x" });
    expect(r.ok).toBe(false);
    expect(r.json).toBeNull();
  });
});

describe("jenkinsPost", () => {
  test("adds the crumb header when a crumb is provided", async () => {
    let seen: Record<string, string> = {};
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      seen = init.headers as Record<string, string>;
      return { ok: true, status: 200, text: async () => "" } as Response;
    }) as unknown as typeof fetch;
    await jenkinsPost("https://ci/do", "Basic x", { field: "Jenkins-Crumb", value: "abc" });
    expect(seen["Jenkins-Crumb"]).toBe("abc");
  });
  test("omits the crumb header when crumb is null", async () => {
    let seen: Record<string, string> = {};
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      seen = init.headers as Record<string, string>;
      return { ok: true, status: 200, text: async () => "" } as Response;
    }) as unknown as typeof fetch;
    await jenkinsPost("https://ci/do", "Basic x", null);
    expect(Object.keys(seen)).toEqual(["Authorization"]);
  });
});

describe("a hostile crumb field name never reaches the header object", () => {
  test("isSafeHeaderName rejects prototype keys and non-token names", () => {
    expect(isSafeHeaderName("Jenkins-Crumb")).toBe(true);
    expect(isSafeHeaderName("X-CSRF")).toBe(true);
    expect(isSafeHeaderName("__proto__")).toBe(false);
    expect(isSafeHeaderName("constructor")).toBe(false);
    expect(isSafeHeaderName("prototype")).toBe(false);
    expect(isSafeHeaderName("")).toBe(false);
    // A `:` or a CR/LF in a field name is header injection on an authenticated POST.
    expect(isSafeHeaderName("X-Evil: v\r\nX-Other")).toBe(false);
    expect(isSafeHeaderName("has space")).toBe(false);
  });

  test.each([
    ["constructor", "constructor"],
    ["__proto__", "__proto__"],
    ["header injection", "X-Evil: v\r\nX-Other"],
  ])("jenkinsPost drops a %s crumb field", async (_label, field) => {
    let seen: Record<string, string> = {};
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      seen = init.headers as Record<string, string>;
      return { ok: true, status: 200, text: async () => "" } as Response;
    }) as unknown as typeof fetch;
    await jenkinsPost("https://ci/do", "Basic x", { field, value: "pwned" });
    expect(Object.keys(seen)).toEqual(["Authorization"]);
    // Nothing reached Object.prototype either.
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    expect(({} as Record<string, unknown>)["pwned"]).toBeUndefined();
  });

  test("getJenkinsCrumb refuses a crumb whose field name is a prototype key", async () => {
    globalThis.fetch = (async () =>
      jsonResponse({ crumb: "abc", crumbRequestField: "__proto__" })) as unknown as typeof fetch;
    expect(await getJenkinsCrumb("https://ci", "Basic x")).toBeNull();
  });

  test("getJenkinsCrumb refuses a crumb field name that is not an RFC 7230 token", async () => {
    globalThis.fetch = (async () =>
      jsonResponse({
        crumb: "abc",
        crumbRequestField: "X-Evil: v\r\nX-Other",
      })) as unknown as typeof fetch;
    expect(await getJenkinsCrumb("https://ci", "Basic x")).toBeNull();
  });
});
