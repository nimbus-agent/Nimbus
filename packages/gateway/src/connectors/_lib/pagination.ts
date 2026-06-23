export interface PageResponse {
  readonly headers: Headers;
  readonly body: unknown;
}

export interface Pagination<S> {
  initialState(): S | undefined;
  nextState(current: S | undefined, response: PageResponse): S | undefined;
}

export class CursorPagination<B> implements Pagination<string> {
  constructor(private readonly extract: (body: B) => string | undefined) {}
  initialState(): string | undefined {
    return undefined;
  }
  nextState(_current: string | undefined, response: PageResponse): string | undefined {
    return this.extract(response.body as B);
  }
}

export class OffsetPagination implements Pagination<number> {
  constructor(private readonly pageSize: number) {}
  initialState(): number {
    return 0;
  }
  nextState(current: number | undefined, response: PageResponse): number | undefined {
    const more = (response.body as { hasMore?: boolean }).hasMore === true;
    if (!more) return undefined;
    return (current ?? 0) + this.pageSize;
  }
}

export class PageNumberPagination implements Pagination<number> {
  initialState(): number {
    return 1;
  }
  nextState(current: number | undefined, response: PageResponse): number | undefined {
    const more = (response.body as { hasMore?: boolean }).hasMore === true;
    if (!more) return undefined;
    return (current ?? 1) + 1;
  }
}

export class LinkHeaderPagination implements Pagination<string> {
  initialState(): string | undefined {
    return undefined;
  }
  nextState(_current: string | undefined, response: PageResponse): string | undefined {
    const link = response.headers.get("Link") ?? response.headers.get("link");
    if (!link) return undefined;
    for (const part of link.split(",")) {
      const m = /<([^<>]+)>;\s*rel="next"/.exec(part.trim());
      if (m) return m[1];
    }
    return undefined;
  }
}
