/**
 * Test-only `fetch` shim that stages canned Responses keyed by
 * (method, URL-pattern, optional body-matcher) and records every call.
 *
 * Lives under test/helpers/ so it is NOT subject to the per-file
 * coverage floor — it is the testing tool, not production code.
 */

export type FetchCall = {
  readonly url: string;
  readonly method: string;
  readonly body: string | null;
  /**
   * Request headers captured from `init.headers` at call time, normalized to
   * lower-cased keys for case-insensitive lookup (HTTP header semantics).
   * Empty record when no headers were provided.
   */
  readonly headers: Readonly<Record<string, string>>;
};

type BodyMatcher = (parsedBody: unknown, rawBody: string) => boolean;

type Stub = {
  readonly method: string;
  readonly url: string | RegExp;
  readonly bodyMatch?: BodyMatcher;
  readonly response: () => Response;
};

export class MockFetch {
  readonly calls: FetchCall[] = [];
  private readonly stubs: Stub[] = [];
  private original: typeof globalThis.fetch | null = null;

  /**
   * Stage a response. URL may be a literal string (exact match) or a RegExp.
   * The first stub that matches in registration order wins.
   * A stub without `bodyMatch` matches any body; register more-specific stubs (with `bodyMatch`) BEFORE catch-all stubs for the same URL.
   *
   * @example
   * mock.respond("POST", "https://slack.com/api/auth.test", {
   *   ok: true, url: "https://acme.slack.com/",
   * });
   */
  respond(
    method: string,
    url: string | RegExp,
    bodyOrJson: unknown,
    opts?: { status?: number; headers?: Record<string, string>; bodyMatch?: BodyMatcher },
  ): void {
    const status = opts?.status ?? 200;
    const headers = opts?.headers ?? { "content-type": "application/json" };
    const body = typeof bodyOrJson === "string" ? bodyOrJson : JSON.stringify(bodyOrJson);
    this.stubs.push({
      method: method.toUpperCase(),
      url,
      bodyMatch: opts?.bodyMatch,
      response: () => new Response(body, { status, headers }),
    });
  }

  /** Stage a non-JSON text response (used to test the JSON-parse-failure branch). */
  respondWithText(
    method: string,
    url: string | RegExp,
    text: string,
    opts?: { status?: number; bodyMatch?: BodyMatcher },
  ): void {
    this.stubs.push({
      method: method.toUpperCase(),
      url,
      bodyMatch: opts?.bodyMatch,
      response: () =>
        new Response(text, {
          status: opts?.status ?? 200,
          headers: { "content-type": "text/plain" },
        }),
    });
  }

  install(): void {
    if (this.original !== null) {
      throw new Error("MockFetch.install() called twice without restore()");
    }
    this.original = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
      this.handle(input, init)) as typeof globalThis.fetch;
  }

  restore(): void {
    if (this.original !== null) {
      globalThis.fetch = this.original;
      this.original = null;
    }
  }

  /**
   * Return the first recorded call. Throws a descriptive error if no calls
   * have been recorded yet. Use when you want to read `.url` / `.headers`
   * / `.body` on a guaranteed-present call without sprinkling
   * `noUncheckedIndexedAccess` narrowing boilerplate through tests.
   */
  firstCall(): FetchCall {
    const c = this.calls[0];
    if (c === undefined) {
      throw new Error("MockFetch.firstCall(): no calls recorded");
    }
    return c;
  }

  /**
   * Helper for assertions: every call body that matches `urlPattern`,
   * parsed as JSON. Throws on bodies that aren't valid JSON.
   */
  bodiesFor(method: string, urlPattern: string | RegExp): unknown[] {
    return this.calls
      .filter((c) => c.method === method.toUpperCase() && this.matchesUrl(urlPattern, c.url))
      .map((c) => {
        if (c.body === null) return null;
        try {
          return JSON.parse(c.body) as unknown;
        } catch {
          throw new Error(
            `MockFetch.bodiesFor: body is not valid JSON for ${c.method} ${c.url} — raw: ${c.body.slice(0, 120)}`,
          );
        }
      });
  }

  private async handle(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    // string -> as-is; URL -> href via toString(); Request -> input.url
    // (Request.toString() returns "[object Request]", which silently
    // breaks every URL matcher — explicit narrowing prevents that.)
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const rawBody = init?.body === undefined || init.body === null ? null : String(init.body);
    const headers = normalizeRequestHeaders(init?.headers);
    this.calls.push({ url, method, body: rawBody, headers });

    for (const stub of this.stubs) {
      if (stub.method !== method) {
        continue;
      }
      if (!this.matchesUrl(stub.url, url)) {
        continue;
      }
      if (stub.bodyMatch !== undefined) {
        let parsed: unknown = null;
        if (rawBody !== null && rawBody !== "") {
          try {
            parsed = JSON.parse(rawBody) as unknown;
          } catch {
            parsed = null;
          }
        }
        if (!stub.bodyMatch(parsed, rawBody ?? "")) {
          continue;
        }
      }
      return stub.response();
    }
    throw new Error(`MockFetch: no stub matched ${method} ${url}`);
  }

  private matchesUrl(pattern: string | RegExp, url: string): boolean {
    return typeof pattern === "string" ? pattern === url : pattern.test(url);
  }
}

/**
 * Normalize `RequestInit.headers` (Headers | [string, string][] | record)
 * into a plain `{ lowercase-key: value }` record. Returns an empty record
 * when no headers were provided so assertions can use `??` / direct lookup
 * without checking for `undefined`.
 */
function normalizeRequestHeaders(raw: HeadersInit | undefined): Readonly<Record<string, string>> {
  if (raw === undefined) {
    return Object.freeze({});
  }
  const out: Record<string, string> = {};
  if (raw instanceof Headers) {
    raw.forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
  } else if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (entry.length === 2) {
        out[entry[0].toLowerCase()] = entry[1];
      }
    }
  } else {
    for (const [key, value] of Object.entries(raw)) {
      out[key.toLowerCase()] = String(value);
    }
  }
  return Object.freeze(out);
}
