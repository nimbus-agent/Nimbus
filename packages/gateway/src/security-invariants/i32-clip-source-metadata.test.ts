import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { stripComments } from "../../../../scripts/structure-audit/lib.ts";
import { read } from "../../test/helpers/security-invariants.ts";

describe("I32 — clip source metadata is whitelist-constructed, so a page cannot deny ingestion of its own clip", () => {
  const CLIP_BASE = {
    url: "https://ex.com/p",
    title: "Hello",
    mode: "article" as const,
    body: "The body text",
    capturedAt: 1750000000000,
  };

  test("an unrecognised sibling key is discarded, and the clip still ingests", async () => {
    const { ingestClip, validateClipInput } = await import("../clips/clip-ingest.ts");
    const { LocalIndex } = await import("../index/local-index.ts");
    const db = new Database(":memory:");
    try {
      LocalIndex.ensureSchema(db);
      const input = validateClipInput({
        ...CLIP_BASE,
        source: { author: "A", junk: "x".repeat(70_000) },
      });
      const res = ingestClip(db, input);
      expect(res.status).toBe("created");
      const row = db.query("SELECT metadata FROM item WHERE id = ?").get(res.id) as {
        metadata: string;
      };
      const stored = (JSON.parse(row.metadata) as { source: Record<string, unknown> }).source;
      expect(stored).toEqual({ author: "A" });
      expect(Object.keys(stored)).toEqual(["author"]);
    } finally {
      db.close();
    }
  });

  test("the discarded payload genuinely exceeds the store's ceiling (the counterfactual)", async () => {
    // The assertion that makes the test above a DENIAL fence rather than a shape check.
    // Without it, a junk blob UNDER RAW_META_MAX_BYTES would still satisfy `toEqual` while
    // proving nothing — which is exactly what an earlier draft of #1285 shipped, at 60 KB
    // (60,112 bytes against a 65,536 ceiling). Pin the arithmetic, not the intent.
    const { RAW_META_MAX_BYTES } = await import("../index/constants.ts");
    const junk = "x".repeat(70_000);
    const hadTheWhitelistNotRun = {
      tags: [],
      mode: "article",
      wordCount: 3,
      clippedAt: CLIP_BASE.capturedAt,
      source: { author: "A", junk },
    };
    const bytes = Buffer.byteLength(JSON.stringify(hadTheWhitelistNotRun), "utf8");
    expect(bytes).toBeGreaterThan(RAW_META_MAX_BYTES);
  });

  test("upsertIndexedItem really does throw above the ceiling (the mechanism is not assumed)", async () => {
    // Proves the denial is real end-to-end: hand the store the metadata the whitelist withheld
    // and watch it refuse. If the 64 KB guard were ever removed, this test goes green-by-absence
    // of a throw and fails — which is the regression this invariant exists to detect.
    const { upsertIndexedItem } = await import("../index/item-store.ts");
    const { LocalIndex } = await import("../index/local-index.ts");
    const db = new Database(":memory:");
    try {
      LocalIndex.ensureSchema(db);
      expect(() =>
        upsertIndexedItem(db, {
          service: "nimbus",
          type: "web_clip",
          externalId: "clip:i32-counterfactual",
          title: "Hello",
          body: "The body text",
          modifiedAt: CLIP_BASE.capturedAt,
          syncedAt: CLIP_BASE.capturedAt,
          metadata: { source: { author: "A", junk: "x".repeat(70_000) } },
        }),
      ).toThrow(/exceeds 64 KB limit/);
    } finally {
      db.close();
    }
  });

  test("the validator CONSTRUCTS the source; it never passes the caller's object through", async () => {
    // The static half. A refactor that reintroduces a passthrough (`...o`, `...raw`, a cast of
    // the caller object to ClipSource, or `delete` on it) restores the un-ingestable-clip denial
    // even though every per-field bound still reads correctly.
    const src = stripComments(await read("packages/gateway/src/clips/clip-ingest.ts"));
    const fn = src.slice(src.indexOf("function validateClipSource"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    expect(body).toContain("const source: ClipSource = {");
    expect(body).not.toContain("...o");
    expect(body).not.toContain("...raw");
    expect(body).not.toContain("delete ");
    expect(body).not.toMatch(/as ClipSource/);
  });

  test("every ClipSource field is read by name and bounded", async () => {
    // A sixth field added to the interface but never read here would be silently dropped —
    // annoying but safe. A field read WITHOUT a bound is the unsafe direction, so assert each
    // of the five goes through one of the three bounding helpers.
    const src = stripComments(await read("packages/gateway/src/clips/clip-ingest.ts"));
    expect(src).toMatch(/const author = boundedProse\(o\["author"\], SOURCE_PROSE_MAX\)/);
    expect(src).toMatch(/const siteName = boundedProse\(o\["siteName"\], SOURCE_PROSE_MAX\)/);
    expect(src).toMatch(/const lang = boundedExact\(o\["lang"\], SOURCE_LANG_MAX\)/);
    expect(src).toMatch(
      /const leadImage = boundedExact\(o\["leadImage"\], SOURCE_LEAD_IMAGE_MAX\)/,
    );
    expect(src).toMatch(/const publishedAt = epochMs\(o\["publishedAt"\]\)/);
  });
});
