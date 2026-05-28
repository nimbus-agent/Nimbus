import { describe, expect, test } from "bun:test";
import { Anonymous } from "./auth.ts";
import { ConnectorHttpClient } from "./http.ts";
import { LinkHeaderPagination, OffsetPagination } from "./pagination.ts";
import { NoopObserver } from "./rate-limit-observer.ts";
import { runConnectorSync } from "./sync-runner.ts";

interface PageBody {
  items: { id: string }[];
  hasMore: boolean;
}

describe("runConnectorSync", () => {
  test("iterates pages until pagination exhausts", async () => {
    let pageIndex = 0;
    const pages = [
      { items: [{ id: "1" }, { id: "2" }], hasMore: true },
      { items: [{ id: "3" }], hasMore: false },
    ];
    const client = new ConnectorHttpClient({
      auth: new Anonymous(),
      observer: new NoopObserver(),
      fetch: async () =>
        new Response(JSON.stringify(pages[pageIndex++]), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    const seen: string[] = [];
    const result = await runConnectorSync<number, PageBody, { id: string }>({
      pagination: new OffsetPagination(2),
      fetchPage: (offset) => client.get<PageBody>(`https://api/items?offset=${offset ?? 0}`),
      mapBody: (body) => body.items,
      onItem: async (item) => {
        seen.push(item.id);
      },
    });
    expect(seen).toEqual(["1", "2", "3"]);
    expect(result.pageCount).toBe(2);
    expect(result.itemCount).toBe(3);
  });

  test("respects pageLimit", async () => {
    const client = new ConnectorHttpClient({
      auth: new Anonymous(),
      observer: new NoopObserver(),
      fetch: async () =>
        new Response(JSON.stringify({ items: [{ id: "x" }], hasMore: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    const result = await runConnectorSync<number, PageBody, { id: string }>({
      pagination: new OffsetPagination(1),
      fetchPage: () => client.get<PageBody>("https://api/x"),
      onItem: async () => {},
      mapBody: (body) => body.items,
      pageLimit: 3,
    });
    expect(result.pageCount).toBe(3);
  });

  test("supports Link-header pagination from real response headers", async () => {
    let n = 0;
    const client = new ConnectorHttpClient({
      auth: new Anonymous(),
      observer: new NoopObserver(),
      fetch: async () => {
        n++;
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (n === 1) headers["Link"] = '<https://api/p2>; rel="next"';
        return new Response(JSON.stringify({ items: [{ id: String(n) }] }), {
          status: 200,
          headers,
        });
      },
    });
    const seen: string[] = [];
    await runConnectorSync<string, { items: { id: string }[] }, { id: string }>({
      pagination: new LinkHeaderPagination(),
      fetchPage: (url) => client.get(url ?? "https://api/p1"),
      mapBody: (body) => body.items,
      onItem: async (item) => {
        seen.push(item.id);
      },
    });
    expect(seen).toEqual(["1", "2"]);
  });

  test("array-bodied API works when paired with a single-page pagination", async () => {
    const client = new ConnectorHttpClient({
      auth: new Anonymous(),
      observer: new NoopObserver(),
      fetch: async () =>
        new Response(JSON.stringify([{ id: "a" }, { id: "b" }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    const seen: string[] = [];
    const result = await runConnectorSync<number, { id: string }[], { id: string }>({
      pagination: new OffsetPagination(100),
      fetchPage: () => client.get<{ id: string }[]>("https://api/x"),
      mapBody: (body) => body,
      onItem: async (i) => {
        seen.push(i.id);
      },
    });
    expect(seen).toEqual(["a", "b"]);
    expect(result.pageCount).toBe(1);
  });
});
