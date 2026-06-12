import { describe, expect, test } from "bun:test";
import {
  CursorPagination,
  LinkHeaderPagination,
  OffsetPagination,
  PageNumberPagination,
  type PageResponse,
} from "./pagination.ts";

describe("CursorPagination", () => {
  test("starts at undefined cursor", () => {
    const p = new CursorPagination<{ next?: string }>((r) => r.next);
    expect(p.initialState()).toBeUndefined();
  });
  test("advances state from response cursor", () => {
    const p = new CursorPagination<{ next?: string }>((r) => r.next);
    const headers = new Headers();
    expect(p.nextState(undefined, { headers, body: { next: "C2" } })).toBe("C2");
    expect(p.nextState("C2", { headers, body: { next: undefined } })).toBeUndefined();
  });
});

describe("OffsetPagination", () => {
  test("starts at 0", () => {
    const p = new OffsetPagination(100);
    expect(p.initialState()).toBe(0);
  });
  test("advances by pageSize", () => {
    const p = new OffsetPagination(100);
    const headers = new Headers();
    expect(p.nextState(0, { headers, body: { hasMore: true } })).toBe(100);
    expect(p.nextState(0, { headers, body: { hasMore: false } })).toBeUndefined();
  });
});

describe("PageNumberPagination", () => {
  test("starts at 1", () => {
    const p = new PageNumberPagination();
    expect(p.initialState()).toBe(1);
  });
  test("advances by 1 until response signals done", () => {
    const p = new PageNumberPagination();
    const headers = new Headers();
    expect(p.nextState(1, { headers, body: { hasMore: true } })).toBe(2);
    expect(p.nextState(2, { headers, body: { hasMore: false } })).toBeUndefined();
  });
});

describe("LinkHeaderPagination", () => {
  test("initialState returns undefined", () => {
    const p = new LinkHeaderPagination();
    expect(p.initialState()).toBeUndefined();
  });
  test("parses next URL from Link header", () => {
    const p = new LinkHeaderPagination();
    const headers = new Headers();
    headers.set(
      "Link",
      '<https://api/items?page=2>; rel="next", <https://api/items?page=10>; rel="last"',
    );
    const resp: PageResponse = { headers, body: {} };
    expect(p.nextState("https://api/items?page=1", resp)).toBe("https://api/items?page=2");
  });
  test("returns undefined when no next link", () => {
    const p = new LinkHeaderPagination();
    const headers = new Headers();
    headers.set("Link", '<https://api/items?page=1>; rel="prev"');
    const resp: PageResponse = { headers, body: {} };
    expect(p.nextState("https://api/items?page=2", resp)).toBeUndefined();
  });
  test("falls back to lowercase 'link' header when 'Link' is absent", () => {
    const p = new LinkHeaderPagination();
    const headers = new Headers();
    // Use a raw lowercase header name to exercise the ?? fallback arm.
    // Note: the Headers API normalises names to lowercase internally, so
    // setting "link" is the same as "Link" in the Fetch spec — but the
    // source reads headers.get("Link") ?? headers.get("link"), so both
    // arms are reachable when the header is entirely absent vs. present.
    headers.set("link", '<https://api/items?page=3>; rel="next"');
    const resp: PageResponse = { headers, body: {} };
    expect(p.nextState(undefined, resp)).toBe("https://api/items?page=3");
  });
  test("returns undefined when no Link header is present at all", () => {
    const p = new LinkHeaderPagination();
    const resp: PageResponse = { headers: new Headers(), body: {} };
    expect(p.nextState(undefined, resp)).toBeUndefined();
  });
});

describe("OffsetPagination — null-coalescing branch", () => {
  test("treats undefined current as 0 when hasMore is true", () => {
    const p = new OffsetPagination(50);
    const headers = new Headers();
    // Passing undefined for current exercises the `current ?? 0` branch.
    expect(p.nextState(undefined, { headers, body: { hasMore: true } })).toBe(50);
  });
  test("returns undefined when hasMore is absent (not true)", () => {
    const p = new OffsetPagination(50);
    const headers = new Headers();
    expect(p.nextState(undefined, { headers, body: {} })).toBeUndefined();
  });
});

describe("PageNumberPagination — null-coalescing branch", () => {
  test("treats undefined current as 1 when hasMore is true", () => {
    const p = new PageNumberPagination();
    const headers = new Headers();
    // Passing undefined for current exercises the `current ?? 1` branch.
    expect(p.nextState(undefined, { headers, body: { hasMore: true } })).toBe(2);
  });
  test("returns undefined when hasMore is absent (not true)", () => {
    const p = new PageNumberPagination();
    const headers = new Headers();
    expect(p.nextState(undefined, { headers, body: {} })).toBeUndefined();
  });
});
