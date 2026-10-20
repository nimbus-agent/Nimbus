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
        expect(r.status).toBe(want.status);
        if (r.status === "ok") {
          expect(r.dropped).toEqual({ undeclaredType: 0, malformed: 0, oversized: 0 });
          expect(r.rows.map((x) => `${x.service}:${x.externalId}`)).toEqual(want.rows);
          expect(r.hasMore).toBe(want.hasMore);
          expect(r.cursor).toBe(want.cursor);
        } else if (r.status === "rate_limited") {
          expect(r.retryAfterMs).toBe(want.retryAfterMs);
        }
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
