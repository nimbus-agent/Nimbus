import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { ToolgenBroker } from "./toolgen-broker.ts";
import { ToolgenError } from "./toolgen-types.ts";

function deps(over: Partial<ConstructorParameters<typeof ToolgenBroker>[0]> = {}) {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  return {
    db,
    now: () => 1,
    maxRequestsPerTool: 50,
    requestTimeoutMs: 1000,
    resolveHost: async () => ["93.184.216.34"],
    readCredential: async () => null,
    approvedHostsFor: () => ["api.example.com"],
    credentialHostsFor: () => [],
    doFetch: async () => new Response("ok", { status: 200 }),
    ...over,
  };
}

function rows(db: Database): { destination: string; result_status: string }[] {
  return db
    .query<{ destination: string; result_status: string }, []>(
      "SELECT destination, result_status FROM egress_ledger WHERE source_type = 'tool'",
    )
    .all();
}

describe("ToolgenBroker.handleFetch", () => {
  test("an approved host is fetched and appends ONE authorized row", async () => {
    const d = deps();
    const res = await new ToolgenBroker(d).handleFetch("tg_a", {
      url: "https://api.example.com/v1",
    });
    expect(res.status).toBe(200);
    expect(rows(d.db)).toEqual([{ destination: "api.example.com", result_status: "authorized" }]);
  });

  test("a host OUTSIDE the envelope is refused and appends a blocked row", async () => {
    const d = deps();
    await expect(
      new ToolgenBroker(d).handleFetch("tg_a", { url: "https://evil.example.com/v1" }),
    ).rejects.toThrow(ToolgenError);
    expect(rows(d.db)).toEqual([{ destination: "evil.example.com", result_status: "blocked" }]);
  });

  test("an approved host that RESOLVES to loopback is refused — the check is on the address", async () => {
    const d = deps({ resolveHost: async () => ["127.0.0.1"] });
    await expect(
      new ToolgenBroker(d).handleFetch("tg_a", { url: "https://api.example.com/v1" }),
    ).rejects.toMatchObject({ code: "ERR_TOOLGEN_HOST_NOT_ALLOWED" });
    expect(rows(d.db)[0]?.result_status).toBe("blocked");
  });

  test("a host resolving to a mix of public and forbidden addresses is refused — one bad record among good ones is enough", async () => {
    const d = deps({ resolveHost: async () => ["93.184.216.34", "127.0.0.1"] });
    await expect(
      new ToolgenBroker(d).handleFetch("tg_a", { url: "https://api.example.com/v1" }),
    ).rejects.toMatchObject({ code: "ERR_TOOLGEN_HOST_NOT_ALLOWED" });
    expect(rows(d.db)).toEqual([{ destination: "api.example.com", result_status: "blocked" }]);
  });

  test("a host resolving to no addresses at all is refused", async () => {
    const d = deps({ resolveHost: async () => [] });
    await expect(
      new ToolgenBroker(d).handleFetch("tg_a", { url: "https://api.example.com/v1" }),
    ).rejects.toMatchObject({ code: "ERR_TOOLGEN_HOST_NOT_ALLOWED" });
    expect(rows(d.db)).toEqual([{ destination: "api.example.com", result_status: "blocked" }]);
  });

  test("an egress append FAILURE aborts the request — fail-closed, no fetch", async () => {
    let fetched = false;
    const d = deps({
      doFetch: async () => {
        fetched = true;
        return new Response("ok");
      },
    });
    d.db.close(); // any append now throws
    await expect(
      new ToolgenBroker(d).handleFetch("tg_a", { url: "https://api.example.com/v1" }),
    ).rejects.toThrow();
    expect(fetched).toBe(false);
  });

  test("a tool-supplied Authorization header is STRIPPED", async () => {
    let seen: Headers | undefined;
    const d = deps({
      doFetch: async (_u: string, init: RequestInit) => {
        seen = new Headers(init.headers);
        return new Response("ok");
      },
    });
    await new ToolgenBroker(d).handleFetch("tg_a", {
      url: "https://api.example.com/v1",
      headers: { Authorization: "Bearer stolen" },
    });
    expect(seen?.get("authorization")).toBeNull();
  });

  test("the credential bound to host A is NOT attached to host B", async () => {
    let seen: Headers | undefined;
    const d = deps({
      approvedHostsFor: () => ["a.example.com", "b.example.com"],
      readCredential: async (_t: string, host: string) =>
        host === "a.example.com" ? { type: "bearer" as const, token: "A-ONLY" } : null,
      doFetch: async (_u: string, init: RequestInit) => {
        seen = new Headers(init.headers);
        return new Response("ok");
      },
    });
    await new ToolgenBroker(d).handleFetch("tg_a", { url: "https://b.example.com/v1" });
    expect(seen?.get("authorization")).toBeNull();
  });

  test("the per-tool request budget is enforced and the refusal is ledgered", async () => {
    const d = deps({ maxRequestsPerTool: 1 });
    const b = new ToolgenBroker(d);
    await b.handleFetch("tg_a", { url: "https://api.example.com/1" });
    await expect(b.handleFetch("tg_a", { url: "https://api.example.com/2" })).rejects.toMatchObject(
      { code: "ERR_TOOLGEN_BUDGET_EXHAUSTED" },
    );
    expect(rows(d.db).map((r) => r.result_status)).toEqual(["authorized", "blocked"]);
  });

  test("a response past the cap is refused rather than buffered", async () => {
    const big = "x".repeat(6 * 1024 * 1024);
    const d = deps({ doFetch: async () => new Response(big) });
    await expect(
      new ToolgenBroker(d).handleFetch("tg_a", { url: "https://api.example.com/v1" }),
    ).rejects.toMatchObject({ code: "ERR_TOOLGEN_RESPONSE_TOO_LARGE" });
  });

  test("a DNS failure is REFUSED and still appends a blocked row", async () => {
    const d = deps({
      resolveHost: async () => {
        throw new Error("ENOTFOUND");
      },
    });
    await expect(
      new ToolgenBroker(d).handleFetch("tg_a", { url: "https://api.example.com/v1" }),
    ).rejects.toThrow(ToolgenError);
    expect(rows(d.db)).toEqual([{ destination: "api.example.com", result_status: "blocked" }]);
  });

  test("a malformed params object is refused without a fetch", async () => {
    const d = deps();
    await expect(new ToolgenBroker(d).handleFetch("tg_a", { url: 42 })).rejects.toThrow(
      ToolgenError,
    );
  });

  test("a syntactically invalid URL is refused without appending a row", async () => {
    const d = deps();
    await expect(
      new ToolgenBroker(d).handleFetch("tg_a", { url: "not a url" }),
    ).rejects.toMatchObject({ code: "ERR_TOOLGEN_BAD_REQUEST" });
    expect(rows(d.db)).toEqual([]);
  });

  test('every request to `doFetch` carries redirect: "error" — a future change dropping it fails loudly', async () => {
    let seenInit: RequestInit | undefined;
    const d = deps({
      doFetch: async (_u: string, init: RequestInit) => {
        seenInit = init;
        return new Response("ok");
      },
    });
    await new ToolgenBroker(d).handleFetch("tg_a", { url: "https://api.example.com/v1" });
    expect(seenInit?.redirect).toBe("error");
  });

  test("a redirect is REFUSED rather than followed, and appends a blocked row on top of the authorized one", async () => {
    // The exact shape Bun's `fetch` rejects with under `redirect: "error"` (probed against
    // 1.3.14) — a plain Error carrying `code: "UnexpectedRedirect"`, not a subclass and not a
    // distinguishing message. `isUnexpectedRedirectError` narrows on `.code`, so the fake matches
    // that, not the human-readable text.
    const redirectErr = Object.assign(new Error("UnexpectedRedirect fetching ..."), {
      code: "UnexpectedRedirect",
    });
    const d = deps({
      doFetch: async () => {
        throw redirectErr;
      },
    });
    await expect(
      new ToolgenBroker(d).handleFetch("tg_a", { url: "https://api.example.com/v1" }),
    ).rejects.toMatchObject({ code: "ERR_TOOLGEN_REDIRECT_REFUSED" });
    // TWO rows for the one call: the first records the authorized attempt itself, the second that
    // it was then cut short by the redirect refusal before any response reached the tool.
    expect(rows(d.db)).toEqual([
      { destination: "api.example.com", result_status: "authorized" },
      { destination: "api.example.com", result_status: "blocked" },
    ]);
  });

  test("a genuine network failure that is NOT a redirect still propagates as before, with no second row", async () => {
    const d = deps({
      doFetch: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    await expect(
      new ToolgenBroker(d).handleFetch("tg_a", { url: "https://api.example.com/v1" }),
    ).rejects.toThrow("ECONNREFUSED");
    expect(rows(d.db)).toEqual([{ destination: "api.example.com", result_status: "authorized" }]);
  });
});

describe("parseParams — every refusal happens before a row is appended or a socket is opened", () => {
  // These all refuse ahead of the ledger, and that is deliberate rather than an omission: until
  // the URL parses there is no `destination` to record, so a row would have to name something the
  // caller did not actually ask for. Everything PAST parsing ledgers a `blocked` row instead.
  async function refuses(params: unknown): Promise<{ code: unknown; rowCount: number }> {
    const d = deps({
      doFetch: async () => {
        throw new Error("parseParams refusal must never reach doFetch");
      },
    });
    try {
      await new ToolgenBroker(d).handleFetch("tg_a", params);
    } catch (e) {
      return { code: (e as ToolgenError).code, rowCount: rows(d.db).length };
    }
    throw new Error("expected a refusal");
  }

  test.each([
    ["null params", null],
    ["an array", ["https://api.example.com"]],
    ["a scalar", "https://api.example.com"],
    ["a missing url", { method: "GET" }],
    ["a non-string url", { url: 42 }],
    ["a headers array", { url: "https://api.example.com/v1", headers: ["X-A", "1"] }],
    ["a scalar headers", { url: "https://api.example.com/v1", headers: 7 }],
  ])("%s is refused as a bad request, with no row and no fetch", async (_label, params) => {
    const { code, rowCount } = await refuses(params);
    expect(code).toBe("ERR_TOOLGEN_BAD_REQUEST");
    expect(rowCount).toBe(0);
  });

  test("an unsupported HTTP method is refused rather than being passed through", async () => {
    // The verb list is an allow-list, so anything exotic (TRACE, CONNECT, a made-up verb) is a
    // refusal, not something the broker forwards and lets the upstream decide about.
    const { code } = await refuses({ url: "https://api.example.com/v1", method: "TRACE" });
    expect(code).toBe("ERR_TOOLGEN_BAD_REQUEST");
  });

  test("a lowercase method is accepted and normalised to upper case on the wire", async () => {
    let seen: RequestInit | undefined;
    const d = deps({
      doFetch: async (_u: string, init: RequestInit) => {
        seen = init;
        return new Response("ok");
      },
    });
    await new ToolgenBroker(d).handleFetch("tg_a", {
      url: "https://api.example.com/v1",
      method: "post",
      body: "hello",
    });
    expect(seen?.method).toBe("POST");
    expect(seen?.body).toBe("hello");
  });

  test("a non-string header VALUE is dropped, and the rest of the headers still go out", async () => {
    let seen: RequestInit | undefined;
    const d = deps({
      doFetch: async (_u: string, init: RequestInit) => {
        seen = init;
        return new Response("ok");
      },
    });
    await new ToolgenBroker(d).handleFetch("tg_a", {
      url: "https://api.example.com/v1",
      headers: { "X-Keep": "yes", "X-Drop": { nested: true }, "X-Also-Drop": 5 },
    });
    const headers = seen?.headers as Record<string, string>;
    expect(headers["X-Keep"]).toBe("yes");
    expect(headers).not.toHaveProperty("X-Drop");
    expect(headers).not.toHaveProperty("X-Also-Drop");
  });

  test("a null/undefined headers field is simply absent, not an error", async () => {
    const d = deps();
    await expect(
      new ToolgenBroker(d).handleFetch("tg_a", {
        url: "https://api.example.com/v1",
        headers: null,
      }),
    ).resolves.toMatchObject({ status: 200 });
  });

  test("a non-string body is omitted rather than stringified, and ledgers 0 request bytes", async () => {
    let seen: RequestInit | undefined;
    const d = deps({
      doFetch: async (_u: string, init: RequestInit) => {
        seen = init;
        return new Response("ok");
      },
    });
    await new ToolgenBroker(d).handleFetch("tg_a", {
      url: "https://api.example.com/v1",
      body: { not: "a string" },
    });
    expect(seen?.body).toBeUndefined();
    const [row] = d.db
      .query<{ payload_summary: string }, []>(
        "SELECT payload_summary FROM egress_ledger WHERE source_type = 'tool'",
      )
      .all();
    expect(row?.payload_summary).toContain('"requestBytes":0');
  });
});

describe("applyCredential — each binding shape reaches the wire in its own form", () => {
  async function headersFor(
    binding: Awaited<ReturnType<ConstructorParameters<typeof ToolgenBroker>[0]["readCredential"]>>,
  ): Promise<Record<string, string>> {
    let seen: RequestInit | undefined;
    const d = deps({
      readCredential: async () => binding,
      doFetch: async (_u: string, init: RequestInit) => {
        seen = init;
        return new Response("ok");
      },
    });
    await new ToolgenBroker(d).handleFetch("tg_a", { url: "https://api.example.com/v1" });
    return (seen?.headers ?? {}) as Record<string, string>;
  }

  test("a bearer binding becomes an Authorization: Bearer header", async () => {
    expect((await headersFor({ type: "bearer", token: "t1" }))["Authorization"]).toBe("Bearer t1");
  });

  test("a header binding uses the operator's OWN header name, not Authorization", async () => {
    const headers = await headersFor({ type: "header", headerName: "X-Api-Key", value: "k1" });
    expect(headers["X-Api-Key"]).toBe("k1");
    expect(headers).not.toHaveProperty("Authorization");
  });

  test("a basic binding is base64-encoded as user:pass, never sent in the clear", async () => {
    const headers = await headersFor({ type: "basic", username: "u", password: "p" });
    expect(headers["Authorization"]).toBe(`Basic ${Buffer.from("u:p").toString("base64")}`);
    // The point of the encoding assertion: the raw password must not appear verbatim.
    expect(JSON.stringify(headers)).not.toContain('"p"');
  });
});

describe("readBoundedBody", () => {
  test("a response with NO body at all yields an empty string rather than throwing", async () => {
    // A 204 has a null `res.body`, so `getReader()` is never reachable — the early return is the
    // only thing standing between a legitimate empty response and a TypeError inside the broker.
    const d = deps({ doFetch: async () => new Response(null, { status: 204 }) });
    await expect(
      new ToolgenBroker(d).handleFetch("tg_a", { url: "https://api.example.com/v1" }),
    ).resolves.toMatchObject({ status: 204, body: "" });
  });
});

describe("a Vault failure reading the bound credential is REFUSED, and ledgered", () => {
  // The class contract is that every refusal past URL parsing appends a `blocked` row before
  // throwing. `readCredential` runs after the host is known, so a rejection there -- a locked
  // keychain, a libsecret error, a Vault IPC failure -- previously escaped `handleFetch` with the
  // destination already known and ZERO rows written, which is the one shape `nimbus prove` cannot
  // account for.
  test("the rejection becomes a refusal with a blocked row, not an escaping error", async () => {
    const d = deps({
      readCredential: async () => {
        throw new Error("vault is locked");
      },
      doFetch: async () => {
        throw new Error("a credential failure must never reach doFetch");
      },
    });
    await expect(
      new ToolgenBroker(d).handleFetch("tg_a", { url: "https://api.example.com/v1" }),
    ).rejects.toMatchObject({ code: "ERR_TOOLGEN_CREDENTIAL_UNAVAILABLE" });
    expect(rows(d.db)).toEqual([{ destination: "api.example.com", result_status: "blocked" }]);
  });

  test("it fails CLOSED -- the request is not sent uncredentialed instead", async () => {
    let fetched = false;
    const d = deps({
      readCredential: async () => {
        throw new Error("vault is locked");
      },
      doFetch: async () => {
        fetched = true;
        return new Response("ok");
      },
    });
    await expect(
      new ToolgenBroker(d).handleFetch("tg_a", { url: "https://api.example.com/v1" }),
    ).rejects.toThrow(ToolgenError);
    expect(fetched).toBe(false);
  });

  test("ABSENT is still not an error -- a host with no bound credential sends uncredentialed", async () => {
    // The distinction the fix must preserve: `null` means "nothing bound", which is normal.
    const d = deps({ readCredential: async () => null });
    await expect(
      new ToolgenBroker(d).handleFetch("tg_a", { url: "https://api.example.com/v1" }),
    ).resolves.toMatchObject({ status: 200 });
    expect(rows(d.db)).toEqual([{ destination: "api.example.com", result_status: "authorized" }]);
  });
});

describe("a credentialHosts host with no binding is refused, never sent uncredentialed", () => {
  // Before this fix, `null` fell straight through to `if (binding !== null) applyCredential(...)`
  // and the request went out unauthenticated -- the shipped defect Task 6 closes. Task 5's
  // boot/shutdown sweep is what makes this routine rather than rare: a saved tool's credentialed
  // hosts have no binding at all on the first request after every restart.
  test("refuses a fetch to a credentialHosts host with no binding, and makes NO request", async () => {
    let fetched = 0;
    const d = deps({
      credentialHostsFor: () => ["api.example.com"],
      readCredential: async () => null,
      doFetch: async () => {
        fetched++;
        return new Response("{}");
      },
    });
    await expect(
      new ToolgenBroker(d).handleFetch("tg_a", { url: "https://api.example.com/v1" }),
    ).rejects.toMatchObject({ code: "ERR_TOOLGEN_CREDENTIAL_REQUIRED" });
    // A refusal that still hits the network is the original bug wearing a different exit code.
    expect(fetched).toBe(0);
  });

  test("the refusal appends a blocked tool-class egress row", async () => {
    const d = deps({
      credentialHostsFor: () => ["api.example.com"],
      readCredential: async () => null,
    });
    await expect(
      new ToolgenBroker(d).handleFetch("tg_a", { url: "https://api.example.com/v1" }),
    ).rejects.toMatchObject({ code: "ERR_TOOLGEN_CREDENTIAL_REQUIRED" });
    expect(rows(d.db)).toEqual([{ destination: "api.example.com", result_status: "blocked" }]);
  });

  test("POSITIVE CONTROL -- the same host WITH a binding succeeds and carries the header", async () => {
    let seen: Headers | undefined;
    const d = deps({
      credentialHostsFor: () => ["api.example.com"],
      readCredential: async () => ({ type: "bearer" as const, token: "tok" }),
      doFetch: async (_u: string, init: RequestInit) => {
        seen = new Headers(init.headers);
        return new Response("{}");
      },
    });
    await new ToolgenBroker(d).handleFetch("tg_a", { url: "https://api.example.com/v1" });
    expect(seen?.get("authorization")).toBe("Bearer tok");
  });

  test("a host NOT in credentialHosts with no binding proceeds uncredentialed -- the deliberate asymmetry", async () => {
    // A blanket "no binding, no request" rule would break every tool that talks to a public API
    // needing no credential at all -- this pins that the refusal is scoped to `credentialHosts`
    // and does not widen into that blanket rule.
    let fetched = 0;
    const d = deps({
      approvedHostsFor: () => ["public.example.com"],
      credentialHostsFor: () => [],
      readCredential: async () => null,
      doFetch: async () => {
        fetched++;
        return new Response("{}");
      },
    });
    await expect(
      new ToolgenBroker(d).handleFetch("tg_a", { url: "https://public.example.com/v1" }),
    ).resolves.toMatchObject({ status: 200 });
    expect(fetched).toBe(1);
  });
});
