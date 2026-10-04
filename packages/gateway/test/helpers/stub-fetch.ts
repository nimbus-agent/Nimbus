import { requestUrl } from "./request-url.ts";

/** One request a {@link StubFetch} saw: its URL, its upper-cased method and lower-cased headers. */
export type StubFetchCall = {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
};

type StubRoute = {
  readonly method: string;
  readonly url: string | RegExp;
  readonly reply: () => Response;
};

/**
 * A routing `fetch` double for connector sync tests, safe to import from a `src/` test.
 *
 * The FIRST route whose method and URL match answers — a string route must equal the whole URL, a
 * RegExp route is tested against it. A request no route matches REJECTS, so an unexpected outbound
 * call fails the code under test instead of reaching the network. Every request is recorded in
 * `calls`, matched or not, so a test can also assert what was never asked for.
 *
 * Why not `MockFetch` (`./mock-fetch.ts`): a `src/` test drags whatever it imports into the
 * gateway's strict `tsc` run, and MockFetch still carries four strict-mode errors there (two
 * `exactOptionalPropertyTypes`, a `typeof fetch` without `preconnect`, an unresolved `HeadersInit`)
 * that are banked in `docs/structure-audit/typecheck-tests-baseline.json` — so importing it from
 * `src/` reds `bun run typecheck`. Once that debt is paid down the two should merge.
 */
export class StubFetch {
  readonly calls: StubFetchCall[] = [];
  private readonly routes: StubRoute[] = [];
  private saved: typeof fetch | undefined;

  /** Answer `method url` with `body` serialized as JSON. */
  respond(
    method: string,
    url: string | RegExp,
    body: unknown,
    opts: { status?: number; headers?: Record<string, string> } = {},
  ): void {
    const headers = opts.headers === undefined ? {} : { headers: opts.headers };
    const init = { status: opts.status ?? 200, ...headers };
    this.routes.push({ method: method.toUpperCase(), url, reply: () => Response.json(body, init) });
  }

  /** Answer `method url` with `text` verbatim — for bodies that must NOT be valid JSON. */
  respondWithText(
    method: string,
    url: string | RegExp,
    text: string,
    opts: { status?: number } = {},
  ): void {
    const status = opts.status ?? 200;
    this.routes.push({
      method: method.toUpperCase(),
      url,
      reply: () => new Response(text, { status }),
    });
  }

  /** Replace `globalThis.fetch`. Pair every call with {@link restore} (an `afterEach` does). */
  install(): void {
    if (this.saved !== undefined) {
      throw new Error("StubFetch.install() called twice without restore()");
    }
    this.saved = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
      Promise.try(() => this.answer(input, init))) as unknown as typeof fetch;
  }

  /** Put back the `fetch` that {@link install} replaced. A second call is a no-op. */
  restore(): void {
    if (this.saved === undefined) return;
    globalThis.fetch = this.saved;
    this.saved = undefined;
  }

  private answer(input: string | URL | Request, init?: RequestInit): Response {
    const url = requestUrl(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });
    this.calls.push({ url, method, headers });
    const route = this.routes.find(
      (r) => r.method === method && (typeof r.url === "string" ? r.url === url : r.url.test(url)),
    );
    if (route === undefined) throw new Error(`StubFetch: no route for ${method} ${url}`);
    return route.reply();
  }
}
