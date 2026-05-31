export interface AuthHeaderProvider {
  apply(headers: Headers): Promise<Headers>;
  applyToUrl?(url: URL): Promise<URL>;
}

export class BearerPat implements AuthHeaderProvider {
  constructor(private readonly getToken: () => Promise<string>) {}
  async apply(headers: Headers): Promise<Headers> {
    const out = new Headers(headers);
    out.set("Authorization", `Bearer ${await this.getToken()}`);
    return out;
  }
}

export class OAuthWithRefresh implements AuthHeaderProvider {
  constructor(private readonly getAccessToken: () => Promise<string>) {}
  async apply(headers: Headers): Promise<Headers> {
    const out = new Headers(headers);
    out.set("Authorization", `Bearer ${await this.getAccessToken()}`);
    return out;
  }
}

export class QueryStringToken implements AuthHeaderProvider {
  constructor(
    private readonly param: string,
    private readonly getToken: () => Promise<string>,
  ) {}
  async apply(headers: Headers): Promise<Headers> {
    return headers;
  }
  async applyToUrl(url: URL): Promise<URL> {
    const out = new URL(url.toString());
    out.searchParams.set(this.param, await this.getToken());
    return out;
  }
}

export class Anonymous implements AuthHeaderProvider {
  async apply(headers: Headers): Promise<Headers> {
    return headers;
  }
}
