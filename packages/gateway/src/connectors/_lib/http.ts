import type { AuthHeaderProvider } from "./auth.ts";
import type { RateLimitObserver, RateLimitSnapshot } from "./rate-limit-observer.ts";

export interface HttpResponse<B = unknown> {
  readonly status: number;
  readonly headers: Headers;
  readonly body: B;
  readonly rateLimit: RateLimitSnapshot | null;
}

type FetchFn = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface ConnectorHttpClientOptions {
  readonly auth: AuthHeaderProvider;
  readonly observer: RateLimitObserver;
  readonly fetch?: FetchFn;
}

export class ConnectorHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    public readonly bodyText: string,
  ) {
    super(`HTTP ${status} from ${url}: ${bodyText.slice(0, 200)}`);
  }
}

export class ConnectorHttpClient {
  private readonly fetchFn: FetchFn;
  constructor(private readonly opts: ConnectorHttpClientOptions) {
    this.fetchFn = opts.fetch ?? (globalThis.fetch as FetchFn);
  }

  async get<B = unknown>(url: string, init: RequestInit = {}): Promise<HttpResponse<B>> {
    const u = new URL(url);
    const finalUrl = this.opts.auth.applyToUrl ? await this.opts.auth.applyToUrl(u) : u;
    const headers = await this.opts.auth.apply(new Headers(init.headers));
    const resp = await this.fetchFn(finalUrl, { ...init, method: init.method ?? "GET", headers });
    if (!resp.ok) {
      const text = await resp.text();
      throw new ConnectorHttpError(resp.status, finalUrl.toString(), text);
    }
    const contentType = resp.headers.get("content-type") ?? "";
    const body = contentType.includes("application/json") ? await resp.json() : await resp.text();
    return {
      status: resp.status,
      headers: resp.headers,
      body: body as B,
      rateLimit: this.opts.observer.observe(resp.headers),
    };
  }
}
