import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { RAW_META_MAX_BYTES } from "../../index/constants.ts";
import { ExtensionSyncResponseError, parseSyncResponse } from "./sync-response.ts";

const ctx = { indexServiceId: "readwise", itemTypes: ["highlight", "book"], syncedAt: 1234 };
const item = (over: Record<string, unknown> = {}) => ({
  type: "highlight",
  externalId: "1",
  title: "t",
  modifiedAt: 5,
  metadata: {},
  ...over,
});
const ok = (items: unknown[], extra: Record<string, unknown> = {}) => ({
  status: "ok",
  items,
  cursor: null,
  hasMore: false,
  ...extra,
});
const page = (raw: unknown) => {
  const r = parseSyncResponse(raw, ctx);
  if (r.status !== "ok") {
    throw new Error("expected ok");
  }
  return r;
};

describe("parseSyncResponse", () => {
  test("undeclared type dropped and counted", () => {
    const p = page(ok([item(), item({ type: "tweet", externalId: "2" })]));
    expect(p.rows).toHaveLength(1);
    expect(p.dropped.undeclaredType).toBe(1);
  });

  test("colliding externalId across types dropped", () => {
    const p = page(ok([item({ externalId: "9" }), item({ type: "book", externalId: "9" })]));
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0]?.type).toBe("highlight");
    expect(p.dropped.malformed).toBe(1);
  });

  test("oversized metadata dropped, not truncated", () => {
    const big = { blob: "x".repeat(RAW_META_MAX_BYTES) };
    const p = page(ok([item({ metadata: big }), item({ externalId: "2" })]));
    expect(p.rows).toHaveLength(1);
    expect(p.dropped.oversized).toBe(1);
  });

  test("item cannot choose its service or syncedAt", () => {
    const p = page(ok([item({ service: "github", syncedAt: 1 })]));
    expect(p.rows[0]?.service).toBe("readwise");
    expect(p.rows[0]?.syncedAt).toBe(1234);
  });

  test("body and bodyPreview together is malformed", () => {
    const p = page(ok([item({ body: "a", bodyPreview: "b" })]));
    expect(p.dropped.malformed).toBe(1);
  });

  test("status union maps", () => {
    expect(parseSyncResponse({ status: "rate_limited", retryAfterMs: 30 }, ctx)).toEqual({
      status: "rate_limited",
      retryAfterMs: 30,
    });
    expect(parseSyncResponse({ status: "rate_limited" }, ctx)).toEqual({ status: "rate_limited" });
    expect(parseSyncResponse({ status: "unauthenticated" }, ctx)).toEqual({
      status: "unauthenticated",
    });
    const p = page(ok([], { cursor: "c", hasMore: true }));
    expect(p.cursor).toBe("c");
    expect(p.hasMore).toBe(true);
  });

  test("non-object response throws", () => {
    for (const bad of [null, "x", 3, [], { status: "nope" }]) {
      expect(() => parseSyncResponse(bad, ctx)).toThrow(ExtensionSyncResponseError);
    }
  });

  test("hasMore with a null or empty cursor throws", () => {
    expect(() => parseSyncResponse(ok([], { hasMore: true, cursor: null }), ctx)).toThrow(
      ExtensionSyncResponseError,
    );
    expect(() => parseSyncResponse(ok([], { hasMore: true, cursor: "" }), ctx)).toThrow(
      ExtensionSyncResponseError,
    );
  });
});

const VALID_EXPECTED: Record<
  string,
  {
    status: string;
    rows?: string[];
    hasMore?: boolean;
    cursor?: string | null;
    retryAfterMs?: number;
  }
> = {
  "valid-ok-body.json": {
    status: "ok",
    rows: ["readwise:book/7"],
    hasMore: false,
    cursor: "opaque é cursor",
  },
  "valid-ok-has-more.json": { status: "ok", rows: [], hasMore: true, cursor: "page-2" },
  "valid-ok-minimal.json": { status: "ok", rows: [], hasMore: false, cursor: null },
  "valid-ok-preview.json": { status: "ok", rows: ["readwise:101"], hasMore: true, cursor: "c1" },
  "valid-rate-limited-bare.json": { status: "rate_limited" },
  "valid-rate-limited.json": { status: "rate_limited", retryAfterMs: 1500 },
  "valid-unauthenticated.json": { status: "unauthenticated" },
};

describe("sync v1 corpus", () => {
  const dir = join(import.meta.dir, "__fixtures__", "sync-v1");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();

  test("fixture list is pinned", () => {
    expect(files).toEqual([
      "invalid-body-and-preview.json",
      "invalid-has-more-empty-cursor.json",
      "invalid-has-more-missing.json",
      "invalid-has-more-null-cursor.json",
      "invalid-items-not-array.json",
      "invalid-metadata-array.json",
      "invalid-missing-title.json",
      "invalid-modified-at-float.json",
      "invalid-not-object.json",
      "invalid-retry-after-negative.json",
      "invalid-truncated-without-body.json",
      "invalid-unknown-status.json",
      "valid-ok-body.json",
      "valid-ok-has-more.json",
      "valid-ok-minimal.json",
      "valid-ok-preview.json",
      "valid-rate-limited-bare.json",
      "valid-rate-limited.json",
      "valid-unauthenticated.json",
    ]);
  });

  for (const f of files) {
    test(f, () => {
      const raw: unknown = JSON.parse(readFileSync(join(dir, f), "utf8"));
      const cctx = { ...ctx, itemTypes: ["highlight", "book", "t"] };
      if (f.startsWith("valid-")) {
        const r = parseSyncResponse(raw, cctx);
        const want = VALID_EXPECTED[f];
        if (want === undefined) {
          throw new Error(`no expectation for ${f}`);
        }
        if (r.status === "ok") {
          expect(r.dropped).toEqual({ undeclaredType: 0, malformed: 0, oversized: 0 });
        }
        // One projection per status arm, compared whole against the expectation.
        const got: Record<string, unknown> =
          r.status === "ok"
            ? {
                status: r.status,
                rows: r.rows.map((x) => `${x.service}:${x.externalId}`),
                hasMore: r.hasMore,
                cursor: r.cursor,
              }
            : r.status === "rate_limited"
              ? { status: r.status, retryAfterMs: r.retryAfterMs }
              : { status: r.status };
        expect(got).toEqual(want);
        return;
      }
      let dropped = 0;
      try {
        const r = parseSyncResponse(raw, cctx);
        dropped = r.status === "ok" ? r.dropped.malformed + r.dropped.oversized : 0;
      } catch (e) {
        expect(e).toBeInstanceOf(ExtensionSyncResponseError);
        return;
      }
      expect(dropped).toBeGreaterThan(0);
    });
  }
});

describe("parseSyncResponse: item validation and envelope", () => {
  const dropped = (over: Record<string, unknown>) => page(ok([item(over)]));

  test("a body, a truncation flag and a preview are accepted only in their valid combinations", () => {
    const full = page(ok([item({ body: "text", bodyTruncated: true })]));
    expect(full.rows[0]).toMatchObject({ body: "text", bodyTruncated: true });
    const plain = page(ok([item({ body: "text" })]));
    expect(plain.rows[0]).toMatchObject({ body: "text" });
    expect(plain.rows[0]).not.toHaveProperty("bodyTruncated");
    const preview = page(ok([item({ bodyPreview: "short" })]));
    expect(preview.rows[0]).toMatchObject({ bodyPreview: "short" });
    expect(page(ok([item()])).dropped.malformed).toBe(0);
  });

  test.each([
    ["both body and preview", { body: "a", bodyPreview: "b" }],
    ["a non-string body", { body: 5 }],
    ["a non-boolean bodyTruncated beside a body", { body: "a", bodyTruncated: "yes" }],
    ["bodyTruncated without a body", { bodyTruncated: true }],
    ["a non-string preview", { bodyPreview: 5 }],
    ["a non-string url", { url: 5 }],
    ["a non-string canonicalUrl", { canonicalUrl: {} }],
    ["an empty externalId", { externalId: "" }],
    ["a fractional modifiedAt", { modifiedAt: 1.5 }],
    ["a negative modifiedAt", { modifiedAt: -1 }],
    ["array metadata", { metadata: [] }],
    ["a non-string title", { title: 3 }],
  ])("%s is dropped as malformed", (_n, over) => {
    const p = dropped(over);
    expect(p.rows).toHaveLength(0);
    expect(p.dropped.malformed).toBe(1);
  });

  test("null urls and a non-object item are handled", () => {
    const p = page(ok([item({ url: null, canonicalUrl: "https://x" }), "junk", null]));
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0]).toMatchObject({ url: null, canonicalUrl: "https://x" });
    expect(p.dropped.malformed).toBe(2);
  });

  test("a malformed envelope is a response error, never a partial page", () => {
    const bad = (raw: unknown): void => {
      expect(() => parseSyncResponse(raw, ctx)).toThrow(ExtensionSyncResponseError);
    };
    bad("nope");
    bad([]);
    bad({ status: "ok", items: "x", cursor: null, hasMore: false });
    bad({ status: "ok", items: [], cursor: 5, hasMore: false });
    bad({ status: "ok", items: [], cursor: null, hasMore: "no" });
    bad({ status: "ok", items: [], cursor: null, hasMore: true });
    bad({ status: "ok", items: [], cursor: "", hasMore: true });
    bad({ status: "mystery" });
  });

  test("rate limits and authentication failures are passed through", () => {
    expect(parseSyncResponse({ status: "rate_limited" }, ctx)).toEqual({ status: "rate_limited" });
    expect(parseSyncResponse({ status: "rate_limited", retryAfterMs: 30 }, ctx)).toEqual({
      status: "rate_limited",
      retryAfterMs: 30,
    });
    expect(parseSyncResponse({ status: "unauthenticated" }, ctx)).toEqual({
      status: "unauthenticated",
    });
    for (const retryAfterMs of [-1, 1.5, "5"]) {
      expect(() => parseSyncResponse({ status: "rate_limited", retryAfterMs }, ctx)).toThrow(
        "retryAfterMs",
      );
    }
  });
});
