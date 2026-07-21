import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
});
