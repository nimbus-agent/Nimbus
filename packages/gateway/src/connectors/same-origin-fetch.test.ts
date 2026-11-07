import { describe, expect, test } from "bun:test";

import {
  fetchSameOriginOnly,
  MAX_SAME_ORIGIN_HOPS,
  RedirectRefusedError,
} from "./same-origin-fetch.ts";

function redirect(status: number, location: string | null): Response {
  return new Response(null, {
    status,
    headers: location === null ? {} : { location },
  });
}

function scripted(responses: Response[]): {
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
  calls: Array<{ url: string; init: RequestInit | undefined }>;
} {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  let i = 0;
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      const r = responses[i++];
      if (r === undefined) throw new Error("unexpected extra request");
      return r;
    },
  };
}

const START = "https://ghe.example.com/api/v3/user";

describe("fetchSameOriginOnly", () => {
  test("always requests with redirect: manual", async () => {
    const s = scripted([new Response("ok")]);
    await fetchSameOriginOnly(START, { headers: { Authorization: "Bearer t" } }, s.fetchImpl);
    expect(s.calls[0]?.init?.redirect).toBe("manual");
  });

  test("a non-redirect response (incl. 304) is returned as is", async () => {
    const s = scripted([new Response(null, { status: 304 })]);
    const res = await fetchSameOriginOnly(START, {}, s.fetchImpl);
    expect(res.status).toBe(304);
  });

  test("a cross-origin 302 is refused and the second request is never made", async () => {
    const s = scripted([redirect(302, "https://evil.example.net/steal")]);
    await expect(fetchSameOriginOnly(START, {}, s.fetchImpl)).rejects.toBeInstanceOf(
      RedirectRefusedError,
    );
    expect(s.calls).toHaveLength(1);
  });

  test("a 307 to http: on the same host is refused", async () => {
    const s = scripted([redirect(307, "http://ghe.example.com/api/v3/user")]);
    await expect(fetchSameOriginOnly(START, {}, s.fetchImpl)).rejects.toBeInstanceOf(
      RedirectRefusedError,
    );
    expect(s.calls).toHaveLength(1);
  });

  test("a redirect to another port of the same host is refused", async () => {
    const s = scripted([redirect(302, "https://ghe.example.com:8443/x")]);
    await expect(fetchSameOriginOnly(START, {}, s.fetchImpl)).rejects.toBeInstanceOf(
      RedirectRefusedError,
    );
  });

  test("a same-origin hop (absolute and relative Location) is followed with the headers", async () => {
    const s = scripted([
      redirect(301, "https://ghe.example.com/api/v3/user2"),
      redirect(302, "/api/v3/user3"),
      new Response("done", { status: 200 }),
    ]);
    const res = await fetchSameOriginOnly(
      START,
      { headers: { Authorization: "Bearer t" } },
      s.fetchImpl,
    );
    expect(await res.text()).toBe("done");
    expect(s.calls.map((c) => c.url)).toEqual([
      START,
      "https://ghe.example.com/api/v3/user2",
      "https://ghe.example.com/api/v3/user3",
    ]);
    const hdrs = s.calls[2]?.init?.headers as Record<string, string> | undefined;
    expect(hdrs?.["Authorization"]).toBe("Bearer t");
  });

  test("a hop that turns cross-origin on the second redirect is refused", async () => {
    const s = scripted([redirect(302, "/a"), redirect(302, "https://evil.example.net/")]);
    await expect(fetchSameOriginOnly(START, {}, s.fetchImpl)).rejects.toBeInstanceOf(
      RedirectRefusedError,
    );
    expect(s.calls).toHaveLength(2);
  });

  test("more than the hop limit is refused", async () => {
    const s = scripted(
      Array.from({ length: MAX_SAME_ORIGIN_HOPS + 1 }, () => redirect(302, "/loop")),
    );
    await expect(fetchSameOriginOnly(START, {}, s.fetchImpl)).rejects.toBeInstanceOf(
      RedirectRefusedError,
    );
    expect(s.calls).toHaveLength(MAX_SAME_ORIGIN_HOPS + 1);
  });

  test("a redirect with no Location, and the error text, carry no URL", async () => {
    const s = scripted([redirect(302, null)]);
    const err = await fetchSameOriginOnly(START, {}, s.fetchImpl).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RedirectRefusedError);
    expect(String((err as Error).message)).not.toContain("ghe.example.com");
  });

  test("the body of a followed 3xx is cancelled before the next hop", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new Uint8Array([1]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const first = new Response(body, { status: 302, headers: { location: "/next" } });
    const s = scripted([first, new Response("ok")]);
    await fetchSameOriginOnly(START, {}, s.fetchImpl);
    expect(cancelled).toBe(true);
  });

  test("a body cancel that throws never masks the flow", async () => {
    const first = redirect(302, "/next");
    Object.defineProperty(first, "body", {
      get: () => ({
        cancel: () => Promise.reject(new Error("boom")),
      }),
    });
    const s = scripted([first, new Response("ok")]);
    const res = await fetchSameOriginOnly(START, {}, s.fetchImpl);
    expect(await res.text()).toBe("ok");
  });
});
