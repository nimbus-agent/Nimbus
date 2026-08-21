import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BODY_MAX_PROSE } from "../index/body-caps.ts";
import { LocalIndex } from "../index/local-index.ts";
import { canonicalizeUrl } from "../util/url-canonical.ts";
import { ClipValidationError, ingestClip, validateClipInput } from "./clip-ingest.ts";

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  LocalIndex.ensureSchema(db); // creates the `item` table + FTS triggers
});
afterEach(() => db.close());

function getItem(id: string): Record<string, unknown> | undefined {
  return db.query("SELECT * FROM item WHERE id = ?").get(id) as Record<string, unknown> | undefined;
}

function metaOf(id: string): Record<string, unknown> {
  return JSON.parse(String(getItem(id)?.["metadata"])) as Record<string, unknown>;
}

describe("canonicalizeUrl", () => {
  test("strips tracking params and hash, drops trailing slash", () => {
    expect(canonicalizeUrl("https://ex.com/p/?utm_source=x&id=7#frag")).toBe(
      "https://ex.com/p?id=7",
    );
  });
  test("idempotent on a clean URL", () => {
    expect(canonicalizeUrl("https://ex.com/a")).toBe("https://ex.com/a");
  });
  test("root URL keeps its slash (no truncation)", () => {
    expect(canonicalizeUrl("https://ex.com/")).toBe("https://ex.com/");
  });
  test("root URL with and without slash canonicalize identically", () => {
    expect(canonicalizeUrl("https://ex.com")).toBe(canonicalizeUrl("https://ex.com/"));
  });
  test("non-URL string passes through unchanged", () => {
    expect(canonicalizeUrl("not a url")).toBe("not a url");
  });
});

describe("validateClipInput", () => {
  const good = {
    url: "https://ex.com/p",
    title: "Title",
    mode: "article",
    body: "text",
    capturedAt: 1750000000000,
  };
  test("accepts a well-formed article clip", () => {
    expect(validateClipInput(good).mode).toBe("article");
  });
  test("rejects missing title with field=title", () => {
    expect(() => validateClipInput({ ...good, title: undefined })).toThrow(ClipValidationError);
    try {
      validateClipInput({ ...good, title: undefined });
    } catch (e) {
      expect((e as ClipValidationError).field).toBe("title");
    }
  });
  test("rejects an unknown mode", () => {
    expect(() => validateClipInput({ ...good, mode: "weird" })).toThrow(ClipValidationError);
  });
  test("rejects non-object input", () => {
    expect(() => validateClipInput(null)).toThrow(ClipValidationError);
  });
  test("coerces missing tags to []", () => {
    expect(validateClipInput(good).tags).toEqual([]);
  });
});

describe("ingestClip", () => {
  const base = {
    url: "https://ex.com/p?utm_source=z",
    title: "Hello",
    mode: "article" as const,
    body: "The body text",
    tags: ["research"],
    capturedAt: 1750000000000,
  };

  test("article clip → created, web_clip row searchable by FTS", () => {
    const res = ingestClip(db, base);
    expect(res.status).toBe("created");
    const row = getItem(res.id);
    expect(row?.["service"]).toBe("nimbus");
    expect(row?.["type"]).toBe("web_clip");
    expect(row?.["canonical_url"]).toBe("https://ex.com/p");
    const fts = db
      .query(
        "SELECT i.id FROM item i INNER JOIN item_fts ON i.rowid = item_fts.rowid WHERE item_fts MATCH ?",
      )
      .all("Hello") as Array<{ id: string }>;
    expect(fts.some((r) => r.id === res.id)).toBe(true);
  });

  test("re-clipping the same canonical URL (article) updates the same row", () => {
    const a = ingestClip(db, base);
    const b = ingestClip(db, { ...base, title: "Hello v2" });
    expect(b.id).toBe(a.id);
    expect(b.status).toBe("updated");
    expect(getItem(a.id)?.["title"]).toBe("Hello v2");
  });

  test("two distinct selections on the same page get distinct ids", () => {
    const s1 = ingestClip(db, { ...base, mode: "selection", body: "first highlight" });
    const s2 = ingestClip(db, { ...base, mode: "selection", body: "second highlight" });
    expect(s1.id).not.toBe(s2.id);
  });

  test("calls scheduleEmbedding with the upserted id", () => {
    const seen: string[] = [];
    const res = ingestClip(db, base, (id) => seen.push(id));
    expect(seen).toEqual([res.id]);
  });

  test("tags + mode + wordCount land in metadata JSON", () => {
    const res = ingestClip(db, base);
    const meta = JSON.parse(String(getItem(res.id)?.["metadata"])) as Record<string, unknown>;
    expect(meta["tags"]).toEqual(["research"]);
    expect(meta["mode"]).toBe("article");
    expect(meta["wordCount"]).toBe(3);
  });

  test("whitespace-only body → wordCount 0", () => {
    const res = ingestClip(db, { ...base, body: "   " });
    const meta = JSON.parse(String(getItem(res.id)?.["metadata"])) as Record<string, unknown>;
    expect(meta["wordCount"]).toBe(0);
  });

  test("a clip that fits carries no truncation keys", () => {
    const res = ingestClip(db, base);
    const meta = JSON.parse(String(getItem(res.id)?.["metadata"])) as Record<string, unknown>;
    expect(meta["truncated"]).toBeUndefined();
    expect(meta["sourceWordCount"]).toBeUndefined();
  });

  describe("over-cap article (#1005)", () => {
    // 20,000 single-char words: length 39,999 > BODY_MAX_PROSE (16,384), so the
    // store clamps. Space-separated so a word count is exactly derivable at any
    // cut point rather than approximated.
    const WORDS = 20_000;
    const bigBody = Array.from({ length: WORDS }, () => "w").join(" ");

    test("stores a clamped body and marks it incomplete", () => {
      const res = ingestClip(db, { ...base, body: bigBody });
      const row = getItem(res.id);
      expect(String(row?.["body"])).toHaveLength(BODY_MAX_PROSE);
      expect(row?.["body_complete"]).toBe(0);
    });

    test("wordCount describes the STORED body, not the submitted text", () => {
      const res = ingestClip(db, { ...base, body: bigBody });
      const meta = JSON.parse(String(getItem(res.id)?.["metadata"])) as Record<string, unknown>;
      // 16,384 chars of "w " pairs → 8,192 whole words, and the clamp lands on a
      // space so no partial word is counted. The point of the assertion is that
      // it is nowhere near WORDS: the old code reported all 20,000.
      expect(meta["wordCount"]).toBe(8_192);
      expect(meta["wordCount"]).not.toBe(WORDS);
    });

    test("the loss is detectable — truncated + sourceWordCount disclose it", () => {
      const res = ingestClip(db, { ...base, body: bigBody });
      const meta = JSON.parse(String(getItem(res.id)?.["metadata"])) as Record<string, unknown>;
      expect(meta["truncated"]).toBe(true);
      expect(meta["sourceWordCount"]).toBe(WORDS);
      expect(meta["sourceWordCount"]).toBeGreaterThan(meta["wordCount"] as number);
    });
  });

  test("caller-supplied canonicalUrl is canonicalized and used", () => {
    const res = ingestClip(db, { ...base, canonicalUrl: "https://other.com/x/?utm_source=q" });
    expect(getItem(res.id)?.["canonical_url"]).toBe("https://other.com/x");
  });

  test("rejects non-finite capturedAt", () => {
    expect(() => validateClipInput({ ...base, capturedAt: Number.POSITIVE_INFINITY })).toThrow(
      ClipValidationError,
    );
  });

  test("rejects tags that are not an array", () => {
    expect(() => validateClipInput({ ...base, tags: "research" })).toThrow(ClipValidationError);
  });

  test("rejects a tags array containing a non-string", () => {
    expect(() => validateClipInput({ ...base, tags: ["ok", 7] })).toThrow(ClipValidationError);
  });

  test("a web clip written through ingestClip is resolvable", () => {
    const res = ingestClip(db, { ...base, url: "https://example.com/post?utm_source=news" });
    const row = db.query("SELECT resolve_key FROM item WHERE id = ?").get(res.id) as {
      resolve_key: string | null;
    };
    // Not NULL is the whole point: clip-ingest calls upsertIndexedItem DIRECTLY, bypassing
    // upsertIndexedItemForSync. Deriving the key in the wrapper would leave every clip unresolvable.
    expect(row.resolve_key).toBe("https://example.com/post");
  });
});

describe("clip source metadata — validateClipInput", () => {
  const good = {
    url: "https://ex.com/p",
    title: "Title",
    mode: "article" as const,
    body: "text",
    capturedAt: 1750000000000,
  };

  test("source absent → the field is absent, not {}", () => {
    expect(validateClipInput(good).source).toBeUndefined();
    expect("source" in validateClipInput(good)).toBe(false);
  });

  test("a full source keeps all five fields", () => {
    const source = {
      author: "Ada Lovelace",
      publishedAt: 1700000000000,
      siteName: "Example",
      lang: "en-US",
      leadImage: "https://ex.com/hero.jpg",
    };
    expect(validateClipInput({ ...good, source }).source).toEqual(source);
  });

  test.each([
    ["a string", "nope"],
    ["null", null],
    ["an array", []],
  ])("source that is %s → ClipValidationError with field=source", (_label, source) => {
    expect(() => validateClipInput({ ...good, source })).toThrow(ClipValidationError);
    try {
      validateClipInput({ ...good, source });
    } catch (e) {
      expect((e as ClipValidationError).field).toBe("source");
    }
  });

  // The rule a reviewer will most want to see proven: one bad <meta> tag must not
  // cost the user their capture, so a wrong-typed member is DROPPED, not thrown.
  test("a wrong-typed member is dropped and its valid siblings survive", () => {
    const out = validateClipInput({ ...good, source: { author: 42, siteName: "Example" } });
    expect(out.source).toEqual({ siteName: "Example" });
  });

  test("a 5,000-character author is truncated to 200", () => {
    const out = validateClipInput({ ...good, source: { author: "a".repeat(5_000) } });
    expect(out.source?.author).toHaveLength(200);
  });

  test("an unknown member is discarded — the whitelist, not a blocklist", () => {
    const out = validateClipInput({
      ...good,
      source: { author: "A", junk: "x".repeat(70_000) },
    });
    expect(out.source).toEqual({ author: "A" });
    expect(Object.keys(out.source ?? {})).toEqual(["author"]);
  });

  test("a whitespace-only author is dropped, and source is omitted rather than {}", () => {
    expect(validateClipInput({ ...good, source: { author: "   " } }).source).toBeUndefined();
  });

  test("an empty source object is omitted rather than stored as {}", () => {
    expect(validateClipInput({ ...good, source: {} }).source).toBeUndefined();
  });

  test("a 30-character lang is DROPPED, not truncated", () => {
    const out = validateClipInput({ ...good, source: { lang: "e".repeat(30) } });
    expect(out.source).toBeUndefined();
  });

  // 20 is OUR product limit, not a BCP 47 maximum: the standard sets none, and
  // `en-x-abcdefgh-abcdefgh` is a perfectly valid 22-character tag. We drop it anyway.
  test("a valid 22-character BCP 47 tag is dropped — the bound is deliberate", () => {
    const out = validateClipInput({ ...good, source: { lang: "en-x-abcdefgh-abcdefgh" } });
    expect(out.source).toBeUndefined();
  });

  test("a 3,000-character leadImage is DROPPED, not truncated", () => {
    const out = validateClipInput({
      ...good,
      source: { leadImage: `https://ex.com/${"q".repeat(3_000)}.jpg` },
    });
    expect(out.source).toBeUndefined();
  });

  // The case that motivated a 2048 bound rather than 200: CDN image URLs routinely
  // carry resize, format and signature parameters.
  test("a 900-character CDN leadImage is kept intact", () => {
    const leadImage = `https://cdn.ex.com/i/hero.jpg?w=1200&h=630&fm=webp&sig=${"a".repeat(830)}`;
    expect(leadImage.length).toBeGreaterThan(880);
    expect(leadImage.length).toBeLessThan(2_048);
    expect(validateClipInput({ ...good, source: { leadImage } }).source?.leadImage).toBe(leadImage);
  });

  test.each([
    ["a date string", "2026-01-01"],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a fractional ms", 1.5],
    ["a value outside Date's range", 1e300],
  ])("publishedAt that is %s is dropped", (_label, publishedAt) => {
    const out = validateClipInput({ ...good, source: { author: "A", publishedAt } });
    expect(out.source).toEqual({ author: "A" });
  });

  // Pre-1970 dates are LEGITIMATE. An index holding papers and archived essays will
  // meet 1965 publication dates, and dropping them would be wrong in exactly the
  // library case this field exists to serve.
  test("a 1965 publication date is kept", () => {
    const out = validateClipInput({ ...good, source: { publishedAt: -157766400000 } });
    expect(out.source?.publishedAt).toBe(-157766400000);
  });

  test("the far edge of Date's range is kept, one past it is dropped", () => {
    expect(validateClipInput({ ...good, source: { publishedAt: 8.64e15 } }).source).toEqual({
      publishedAt: 8.64e15,
    });
    const past = validateClipInput({ ...good, source: { publishedAt: 8.64e15 + 1 } });
    expect(past.source).toBeUndefined();
  });
});

describe("clip source metadata — storage", () => {
  const base = {
    url: "https://ex.com/p",
    title: "Hello",
    mode: "article" as const,
    body: "The body text",
    tags: ["research"],
    capturedAt: 1750000000000,
  };

  // The no-regression fence: a clip with no source must produce EXACTLY the
  // metadata it produced before this feature existed — no `source: {}`, no
  // `source: null`, no reordering that a consumer could trip over.
  test("no source → metadata is exactly what it was before", () => {
    const res = ingestClip(db, base);
    expect(metaOf(res.id)).toEqual({
      tags: ["research"],
      mode: "article",
      wordCount: 3,
      clippedAt: 1750000000000,
    });
  });

  test("a full source lands under metadata.source", () => {
    const source = {
      author: "Ada Lovelace",
      publishedAt: 1700000000000,
      siteName: "Example",
      lang: "en-US",
      leadImage: "https://ex.com/hero.jpg",
    };
    const res = ingestClip(db, { ...base, source });
    expect(metaOf(res.id)["source"]).toEqual(source);
  });

  test("source survives the round trip through validateClipInput", () => {
    const input = validateClipInput({
      ...base,
      source: { author: "Ada Lovelace", siteName: "Example" },
    });
    const res = ingestClip(db, input);
    expect(metaOf(res.id)["source"]).toEqual({ author: "Ada Lovelace", siteName: "Example" });
  });

  // The store's ceiling is 64 KB (65,536 bytes, `RAW_META_MAX_BYTES`); a 70 KB
  // `junk` sibling genuinely crosses it. Without the whitelist this item's
  // metadata would exceed that ceiling and `upsertIndexedItem` would THROW — a
  // page could deny ingestion of its own clip. This test is the proof that the
  // cap is load-bearing.
  test("a 70 KB unknown member cannot deny ingestion of its own clip", () => {
    const input = validateClipInput({
      ...base,
      source: { author: "A", junk: "x".repeat(70_000) },
    });
    const res = ingestClip(db, input);
    expect(res.status).toBe("created");
    const stored = metaOf(res.id)["source"] as Record<string, unknown>;
    expect(stored).toEqual({ author: "A" });
    expect(stored["junk"]).toBeUndefined();
  });

  test("a dropped-to-empty source stores no source key at all", () => {
    const input = validateClipInput({ ...base, source: { lang: "e".repeat(30) } });
    const res = ingestClip(db, input);
    expect("source" in metaOf(res.id)).toBe(false);
  });

  test("the pre-existing metadata keys are untouched when source is present", () => {
    const res = ingestClip(db, { ...base, source: { author: "Ada" } });
    const meta = metaOf(res.id);
    expect(meta["tags"]).toEqual(["research"]);
    expect(meta["mode"]).toBe("article");
    expect(meta["wordCount"]).toBe(3);
    expect(meta["clippedAt"]).toBe(1750000000000);
  });
});

// Three properties a future reader will assume this feature broke. Each is pinned
// so that breaking it is a test failure rather than a silent behaviour change.
describe("clip source metadata — what it must NOT change", () => {
  const base = {
    url: "https://ex.com/p",
    title: "Hello",
    mode: "article" as const,
    body: "The body text",
    tags: ["research"],
    capturedAt: 1750000000000,
  };

  // 1. Clip identity is untouched. `externalIdFor` hashes the canonicalised URL,
  //    plus the body for selections. Metadata is not in the hash and must not enter it.
  test("re-clipping with different metadata is an update on the SAME id", () => {
    const a = ingestClip(db, { ...base, source: { author: "Ada" } });
    const b = ingestClip(db, { ...base, source: { author: "Grace", siteName: "Example" } });
    expect(b.id).toBe(a.id);
    expect(b.status).toBe("updated");
    const rows = db.query("SELECT id FROM item").all() as Array<{ id: string }>;
    expect(rows).toHaveLength(1);
  });

  test("adding source to a previously sourceless clip does not fork its id", () => {
    const a = ingestClip(db, base);
    const b = ingestClip(db, { ...base, source: { author: "Ada" } });
    expect(b.id).toBe(a.id);
    expect(b.status).toBe("updated");
  });

  test("a selection's id still turns on its body, not on its source", () => {
    const sel = { ...base, mode: "selection" as const, body: "first highlight" };
    const a = ingestClip(db, { ...sel, source: { author: "Ada" } });
    const b = ingestClip(db, { ...sel, source: { author: "Grace" } });
    const c = ingestClip(db, { ...sel, body: "second highlight" });
    expect(b.id).toBe(a.id);
    expect(c.id).not.toBe(a.id);
  });

  // 2. `modified_at` still comes from `capturedAt`. Letting `publishedAt` drive it
  //    was considered and deliberately rejected for this slice — it would change
  //    clip sort order on data already in every user's index.
  test("modified_at comes from capturedAt, never from publishedAt", () => {
    const res = ingestClip(db, { ...base, source: { publishedAt: -157766400000 } });
    const row = getItem(res.id);
    expect(row?.["modified_at"]).toBe(1750000000000);
    expect(row?.["synced_at"]).toBe(1750000000000);
    expect(metaOf(res.id)["source"]).toEqual({ publishedAt: -157766400000 });
  });

  // 3. `author_id` stays null. Resolving a byline string to a `person` row is fuzzy,
  //    cross-connector, and a design of its own. `metadata.source.author` is a string
  //    the clip carries, not an identity claim.
  test("author_id stays null even when the clip carries an author", () => {
    const res = ingestClip(db, { ...base, source: { author: "Ada Lovelace" } });
    expect(getItem(res.id)?.["author_id"]).toBeNull();
  });

  // Inherited behaviour, DOCUMENTED rather than fixed: `upsertIndexedItem` replaces
  // metadata wholesale, so a re-clip without `source` clears a stored one — exactly
  // as `tags` already behave. Left silent, the first person to notice files it as a bug.
  test("a re-clip without source clears a stored one, as tags already do", () => {
    const a = ingestClip(db, { ...base, source: { author: "Ada" }, tags: ["research"] });
    expect(metaOf(a.id)["source"]).toEqual({ author: "Ada" });
    const b = ingestClip(db, { ...base, tags: [] });
    expect(b.id).toBe(a.id);
    expect("source" in metaOf(b.id)).toBe(false);
    expect(metaOf(b.id)["tags"]).toEqual([]);
  });
});
