import { describe, expect, test } from "bun:test";
import os from "node:os";
import type { Logger } from "pino";
import { unboundSyncCapabilities } from "../../sync/sync-capabilities.ts";
import type { SyncContext } from "../../sync/types.ts";
import { connectorFetch } from "./fetch-outcome.ts";

/** Wave 7b SyncContext members — unused by connectorFetch, personal-credential defaults. */
const PERSONAL_SYNC_EXTRAS: Pick<
  SyncContext,
  "sandboxCwd" | "credentialFor" | "runTeamList" | "depth"
> = {
  sandboxCwd: os.tmpdir(),
  credentialFor: () => ({ credential: "personal" }),
  runTeamList: async () => [],
  depth: "full",
};

interface RateLimiterRecord {
  readonly acquired: string[];
}

function makeCtx(opts: {
  fetch: typeof fetch;
  acquired: RateLimiterRecord;
  warnings: { msg: string; bindings: Record<string, unknown> }[];
}): SyncContext {
  const logger = {
    warn(bindings: Record<string, unknown>, msg: string): void {
      opts.warnings.push({ msg, bindings });
    },
  } as unknown as Logger;
  const rateLimiter = {
    async acquire(serviceId: string): Promise<void> {
      opts.acquired.acquired.push(serviceId);
    },
  };
  return {
    ...unboundSyncCapabilities(),
    logger,
    rateLimiter: rateLimiter as SyncContext["rateLimiter"],
    ...PERSONAL_SYNC_EXTRAS,
  };
}

describe("connectorFetch", () => {
  test("returns ok with parsed body + byte count on 2xx JSON", async () => {
    const acquired: RateLimiterRecord = { acquired: [] };
    const warnings: { msg: string; bindings: Record<string, unknown> }[] = [];
    const body = JSON.stringify({ items: [1, 2, 3] });
    const fetchFn = (async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const ctx = makeCtx({ fetch: fetchFn, acquired, warnings });

    const outcome = await connectorFetch(ctx, "argocd", "https://api/x", {}, fetchFn);

    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") {
      expect(outcome.parsed).toEqual({ items: [1, 2, 3] });
      expect(outcome.bytes).toBe(body.length);
    }
    expect(acquired.acquired).toEqual(["argocd"]);
    expect(warnings).toEqual([]);
  });

  test("returns http_error with byte count + logs warning on non-2xx", async () => {
    const acquired: RateLimiterRecord = { acquired: [] };
    const warnings: { msg: string; bindings: Record<string, unknown> }[] = [];
    const body = '{"error":"forbidden"}';
    const fetchFn = (async () =>
      new Response(body, {
        status: 403,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const ctx = makeCtx({ fetch: fetchFn, acquired, warnings });

    const outcome = await connectorFetch(ctx, "argocd", "https://api/x", {}, fetchFn);

    expect(outcome.kind).toBe("http_error");
    if (outcome.kind === "http_error") {
      expect(outcome.bytes).toBe(body.length);
    }
    expect(acquired.acquired).toEqual(["argocd"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.bindings).toMatchObject({ serviceId: "argocd", status: 403 });
  });

  test("returns parse_error with byte count when JSON is malformed", async () => {
    const acquired: RateLimiterRecord = { acquired: [] };
    const warnings: { msg: string; bindings: Record<string, unknown> }[] = [];
    const body = "not-json{{{";
    const fetchFn = (async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const ctx = makeCtx({ fetch: fetchFn, acquired, warnings });

    const outcome = await connectorFetch(ctx, "argocd", "https://api/x", {}, fetchFn);

    expect(outcome.kind).toBe("parse_error");
    if (outcome.kind === "parse_error") {
      expect(outcome.bytes).toBe(body.length);
    }
    expect(warnings).toEqual([]);
  });

  test("acquires rate limit BEFORE the fetch call", async () => {
    const acquired: RateLimiterRecord = { acquired: [] };
    const order: string[] = [];
    const rateLimiter = {
      async acquire(svc: string): Promise<void> {
        order.push(`acquire:${svc}`);
        acquired.acquired.push(svc);
      },
    };
    const fetchFn = (async () => {
      order.push("fetch");
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const ctx = {
      logger: { warn() {} } as unknown as Logger,
      rateLimiter: rateLimiter as SyncContext["rateLimiter"],
      ...PERSONAL_SYNC_EXTRAS,
      ...unboundSyncCapabilities(),
    };

    await connectorFetch(ctx, "argocd", "https://api/x", {}, fetchFn);

    expect(order).toEqual(["acquire:argocd", "fetch"]);
  });

  test("forwards method + headers + body via RequestInit", async () => {
    const acquired: RateLimiterRecord = { acquired: [] };
    const warnings: { msg: string; bindings: Record<string, unknown> }[] = [];
    let observedInit: RequestInit | undefined;
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      observedInit = init;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const ctx = makeCtx({ fetch: fetchFn, acquired, warnings });

    await connectorFetch(
      ctx,
      "argocd",
      "https://api/x",
      {
        method: "POST",
        headers: { Authorization: "Bearer tok", Accept: "application/json" },
        body: JSON.stringify({ q: 1 }),
      },
      fetchFn,
    );

    expect(observedInit?.method).toBe("POST");
    const headers = new Headers(observedInit?.headers);
    expect(headers.get("Authorization")).toBe("Bearer tok");
    expect(headers.get("Accept")).toBe("application/json");
    expect(observedInit?.body).toBe(JSON.stringify({ q: 1 }));
  });

  test("uses globalThis.fetch when fetchFn is omitted (default param branch)", async () => {
    const acquired: RateLimiterRecord = { acquired: [] };
    const warnings: { msg: string; bindings: Record<string, unknown> }[] = [];
    const body = JSON.stringify({ hello: "world" });
    const savedFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () =>
        new Response(body, {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch;
      const ctx = makeCtx({ fetch: globalThis.fetch, acquired, warnings });

      // Call without passing fetchFn — exercises the default-param branch
      const outcome = await connectorFetch(ctx, "argocd", "https://api/default");

      expect(outcome.kind).toBe("ok");
      if (outcome.kind === "ok") {
        expect(outcome.parsed).toEqual({ hello: "world" });
        expect(outcome.bytes).toBe(body.length);
      }
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  test("uses empty object when init is omitted (default param branch)", async () => {
    const acquired: RateLimiterRecord = { acquired: [] };
    const warnings: { msg: string; bindings: Record<string, unknown> }[] = [];
    let observedInit: RequestInit | undefined;
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      observedInit = init;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const ctx = makeCtx({ fetch: fetchFn, acquired, warnings });

    // Pass fetchFn but omit init — exercises the `init = {}` default-param branch
    const outcome = await connectorFetch(ctx, "argocd", "https://api/x", undefined, fetchFn);

    expect(outcome.kind).toBe("ok");
    // init should have been the default empty object
    expect(observedInit).toEqual({});
  });

  test("http_error outcome includes correct status code from response", async () => {
    const acquired: RateLimiterRecord = { acquired: [] };
    const warnings: { msg: string; bindings: Record<string, unknown> }[] = [];
    const fetchFn = (async () =>
      new Response("Service Unavailable", {
        status: 503,
      })) as unknown as typeof fetch;
    const ctx = makeCtx({ fetch: fetchFn, acquired, warnings });

    const outcome = await connectorFetch(ctx, "argocd", "https://api/x", {}, fetchFn);

    expect(outcome.kind).toBe("http_error");
    if (outcome.kind === "http_error") {
      expect(outcome.status).toBe(503);
      expect(outcome.bytes).toBe("Service Unavailable".length);
    }
    expect(warnings[0]?.bindings).toMatchObject({ url: "https://api/x" });
  });

  test("http_error warning includes url binding", async () => {
    const acquired: RateLimiterRecord = { acquired: [] };
    const warnings: { msg: string; bindings: Record<string, unknown> }[] = [];
    const fetchFn = (async () => new Response("", { status: 401 })) as unknown as typeof fetch;
    const ctx = makeCtx({ fetch: fetchFn, acquired, warnings });

    await connectorFetch(ctx, "linear", "https://api.linear.app/graphql", {}, fetchFn);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.bindings).toMatchObject({
      serviceId: "linear",
      status: 401,
      url: "https://api.linear.app/graphql",
    });
    expect(warnings[0]?.msg).toBe("connector fetch failed");
  });

  test("parse_error byte count matches raw text length for non-empty invalid JSON", async () => {
    const acquired: RateLimiterRecord = { acquired: [] };
    const warnings: { msg: string; bindings: Record<string, unknown> }[] = [];
    const body = "<html>Not JSON at all</html>";
    const fetchFn = (async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/html" },
      })) as unknown as typeof fetch;
    const ctx = makeCtx({ fetch: fetchFn, acquired, warnings });

    const outcome = await connectorFetch(ctx, "argocd", "https://api/x", {}, fetchFn);

    expect(outcome.kind).toBe("parse_error");
    if (outcome.kind === "parse_error") {
      expect(outcome.bytes).toBe(body.length);
    }
    // parse_error must not emit warnings
    expect(warnings).toHaveLength(0);
  });

  test("ok outcome byte count for empty JSON object", async () => {
    const acquired: RateLimiterRecord = { acquired: [] };
    const warnings: { msg: string; bindings: Record<string, unknown> }[] = [];
    const body = "{}";
    const fetchFn = (async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const ctx = makeCtx({ fetch: fetchFn, acquired, warnings });

    const outcome = await connectorFetch(ctx, "github", "https://api.github.com/x", {}, fetchFn);

    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") {
      expect(outcome.parsed).toEqual({});
      expect(outcome.bytes).toBe(body.length);
    }
    expect(acquired.acquired).toEqual(["github"]);
  });
});
