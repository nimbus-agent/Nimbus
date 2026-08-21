# Clip source metadata Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `POST /v1/clips` accepts one optional `source` object — author, publish date, site name, language, lead image — and stores it at `metadata.source`, so a web clip stops being the one item type in the index that arrives without provenance.

**Architecture:** A single new validation block in `validateClipInput` **constructs** a `ClipSource` from five known fields (never returns or spreads the caller's object), and `ingestClip` passes that constructed object straight into the metadata it already composes. No new route, no new table, no new outbound request. Malformed members are dropped rather than thrown, because a bad `<meta>` tag must not cost the user their capture.

**Tech Stack:** TypeScript (strict, `bun`), `bun:test`, `bun:sqlite`. All work is inside `packages/gateway/src/clips/`.

**Spec:** [`docs/superpowers/specs/2026-08-20-clip-source-metadata-design.md`](../specs/2026-08-20-clip-source-metadata-design.md) — approved 2026-08-20. The spec is the binding contract; every rule below is argued there. Read it before Task 1.

## Global Constraints

- **Whitelist, never blocklist.** `validateClipInput` builds a **new** `ClipSource` object literal from the five known fields. It must never return the caller's `source`, spread it, or `delete` keys from it. Every per-field cap is worthless if an unrecognised sibling key rides along: `upsertIndexedItem` serialises the whole metadata object and **throws** above 64 KB (`packages/gateway/src/index/item-store.ts:85`), so a page that put a large enough blob under `source.junk` — one that crosses that 64 KB ceiling — could deny ingestion of its own clip.
- **A malformed member is dropped, not thrown.** `asString` throws because a clip without a title is not a clip; a clip with a malformed byline is still a perfectly good clip. A `source` that is not a JSON object (a string, `null`, an array) is still a `ClipValidationError` with `field: "source"` — that is caller error, not page noise.
- **Prose truncates; structured values drop.** `author` 200 chars → truncated. `siteName` 200 chars → truncated. `lang` 20 chars → **dropped**. `leadImage` 2048 chars → **dropped**. Half a URL is a broken link, not a shorter one, and a consumer cannot tell it was cut.
- **The 20 for `lang` is a product limit, not a fact about the standard.** BCP 47 sets no maximum tag length; `en-x-abcdefgh-abcdefgh` is a valid 22-character tag and is dropped **deliberately**.
- **`publishedAt` is epoch ms, normalised client-side.** Validate only "an integer inside `Date`'s range" (|v| ≤ 8.64e15). Pre-1970 and far-future values are **valid** and must stay: an index holding archived essays will meet 1965 publication dates, and embargoed posts carry future dates honestly.
- **An empty string after trimming is dropped**, and if every member is absent or dropped, `source` is omitted entirely rather than stored as `{}`.
- **Three properties this must not change**, each pinned by a test: clip identity (`externalIdFor` hashes the canonical URL and, for selections, the body — never metadata), `modified_at` still comes from `capturedAt`, and `author_id` stays null.
- **TypeScript strict, no `any`.** External data is `unknown`, narrowed by a guard. No `console.*` in `src/`.
- **Gates before the PR:** `bun run typecheck`, `bun run lint`, `bun test packages/gateway`, `bun run lint:markdown`, `bun scripts/structure-audit/check-doc-references.ts --check`.
- **Two gates that look like they apply and do not** — already verified, do not redo: `packages/gateway/openapi/v1.yaml` does not describe `/v1/clips`, and `WRITE_ROUTE_ALLOWLIST` / `I30` are untouched because this adds a field to an existing route, not a route.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/gateway/src/clips/clip-ingest.ts` | Modify. Adds `ClipSource`, the four bound constants, the three field-narrowing helpers, `validateClipSource`, the `source` line in `validateClipInput`'s return, and the `source` key in `ingestClip`'s metadata. |
| `packages/gateway/src/clips/clip-ingest.test.ts` | Modify. Adds a `describe("clip source metadata")` block covering validation, storage, the whitelist, and the three invariant pins. |
| `docs/CHANGELOG.md` | Modify. One dated entry under `## Post-Phase-6 deliveries`. |

Everything lands in files that already exist. No new module: the validation is ~40 lines and belongs beside the seven field checks it sits with, not in a file of its own.

---

## Task 1: `ClipSource` validation

**Files:**

- Modify: `packages/gateway/src/clips/clip-ingest.ts` (add types + helpers above `validateClipInput`, add one line to its return)
- Test: `packages/gateway/src/clips/clip-ingest.test.ts`

**Interfaces:**

- Consumes: `ClipValidationError` (already exported from `clip-ingest.ts`), `validateClipInput(parsed: unknown): ClipInput`.
- Produces: `export interface ClipSource { readonly author?: string; readonly publishedAt?: number; readonly siteName?: string; readonly lang?: string; readonly leadImage?: string }` and `ClipInput.source?: ClipSource`. Task 2 reads `input.source`.

- [ ] **Step 1: Write the failing tests**

Append this block to `packages/gateway/src/clips/clip-ingest.test.ts`, at the end of the file (after the closing `});` of `describe("ingestClip")`):

```ts
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

  test.each([["a string", "nope"], ["null", null], ["an array", []]])(
    "source that is %s → ClipValidationError with field=source",
    (_label, source) => {
      expect(() => validateClipInput({ ...good, source })).toThrow(ClipValidationError);
      try {
        validateClipInput({ ...good, source });
      } catch (e) {
        expect((e as ClipValidationError).field).toBe("source");
      }
    },
  );

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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/gateway/src/clips/clip-ingest.test.ts`

Expected: FAIL. The `source` cases fail because `validateClipInput` drops the field entirely, so `out.source` is `undefined` everywhere and the `ClipValidationError` cases throw nothing. Typecheck will also complain that `source` is not a property of `ClipInput` — that is the same failure.

- [ ] **Step 3: Add the type and the bounds**

In `packages/gateway/src/clips/clip-ingest.ts`, directly below the `ClipInput` interface, add `ClipSource` and add `source` to `ClipInput`:

```ts
/**
 * Provenance a clip carries from the page it was captured from.
 *
 * Every member is optional and every member is bounded, because all of these
 * values are controlled by whatever page the user is looking at and
 * `upsertIndexedItem` THROWS when an item's serialised metadata exceeds 64 KB
 * (`../index/item-store.ts`). Without bounds a hostile page could make its own
 * clip un-ingestable.
 */
export interface ClipSource {
  readonly author?: string;
  readonly publishedAt?: number; // epoch ms, normalised by the client
  readonly siteName?: string;
  readonly lang?: string;
  readonly leadImage?: string; // absolute http(s) URL, stored as a reference and never fetched
}

export interface ClipInput {
  readonly url: string;
  readonly canonicalUrl?: string;
  readonly title: string;
  readonly mode: "article" | "selection";
  readonly body: string;
  readonly tags: readonly string[];
  readonly capturedAt: number;
  readonly source?: ClipSource;
}
```

Note the existing `ClipInput` body is unchanged — only the final `source` line is new. Delete the old standalone `ClipInput` declaration rather than leaving two.

- [ ] **Step 4: Add the helpers and `validateClipSource`**

Directly above `export function validateClipInput`, add:

```ts
const SOURCE_PROSE_MAX = 200;
const SOURCE_LANG_MAX = 20;
const SOURCE_LEAD_IMAGE_MAX = 2048;
/** The largest absolute epoch-ms value `Date` can represent. */
const DATE_RANGE_MAX_MS = 8.64e15;

/**
 * Prose DEGRADES under a cap: a byline cut to 200 characters is still a byline
 * and still tells you who wrote the thing.
 */
function boundedProse(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  return trimmed === "" ? undefined : trimmed.slice(0, max);
}

/**
 * Structured values CORRUPT under a cap, so they are dropped instead. Half a URL
 * is not a slightly-worse URL — it is a broken link, and a consumer cannot tell
 * it was truncated. A language tag past 20 characters is, in practice, a page's
 * prose leaking into the wrong `<meta>`, and `en-US`-shaped nonsense cut out of
 * it would be actively misleading.
 */
function boundedExact(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  return trimmed === "" || trimmed.length > max ? undefined : trimmed;
}

/**
 * `publishedAt` is bounded by TYPE, not by length. The only caller normalises
 * through `Date.parse`, which yields integers, so a non-integer is garbage rather
 * than legitimate data being narrowed. `Number.isInteger` rejects `NaN` and
 * `Infinity` on its own.
 *
 * Pre-1970 and far-future values are deliberately VALID: archived essays carry
 * 1965 publication dates and embargoed posts carry future ones. Nothing sorts on
 * this field — `modified_at` still comes from `capturedAt` — so a wild value
 * cannot disturb ordering. If a later change makes `publishedAt` drive ordering,
 * that change owns the tighter bound.
 *
 * A UNIT error is therefore undetectable here and is the CLIENT's to prevent. A
 * seconds-denominated timestamp (`1750000000`) is an integer inside the range and
 * is accepted as ~1970-01-21. The gateway cannot distinguish it from a genuine
 * January 1970 date, and the heuristic that would — "reject implausibly small
 * magnitudes" — is exactly the rule the pre-1970 decision above rejects. So the
 * scaling contract lives at the extraction site, next to the `Date.parse` that
 * produces the value.
 */
function epochMs(v: unknown): number | undefined {
  if (typeof v !== "number" || !Number.isInteger(v) || Math.abs(v) > DATE_RANGE_MAX_MS) {
    return undefined;
  }
  return v;
}

/**
 * Builds a NEW `ClipSource` from the five known fields. It must never return the
 * caller's object, spread it, or delete keys from it: `ingestClip` stores what it
 * is given without further filtering, `upsertIndexedItem` serialises the whole
 * metadata object, and it throws above 64 KB. A page that put a large enough
 * blob under `source.junk` — one that crosses that 64 KB ceiling — would make
 * its own clip un-ingestable — precisely the denial the
 * per-field caps exist to prevent. A whitelist, not a blocklist: the shape
 * TypeScript describes and the shape that reaches storage are the same object,
 * built here.
 *
 * Wrong-typed MEMBERS are dropped rather than thrown, unlike every other field on
 * this body. `asString` throws because a clip without a title is not a clip; a
 * clip with a malformed byline is still a perfectly good clip, and failing it
 * would mean one bad `<meta>` tag costs the user the capture. A `source` that is
 * not an object is different — that is caller error, and it throws.
 */
function validateClipSource(raw: unknown): ClipSource | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ClipValidationError("source must be a JSON object", "source");
  }
  const o = raw as Record<string, unknown>;
  const author = boundedProse(o["author"], SOURCE_PROSE_MAX);
  const publishedAt = epochMs(o["publishedAt"]);
  const siteName = boundedProse(o["siteName"], SOURCE_PROSE_MAX);
  const lang = boundedExact(o["lang"], SOURCE_LANG_MAX);
  const leadImage = boundedExact(o["leadImage"], SOURCE_LEAD_IMAGE_MAX);
  const source: ClipSource = {
    ...(author === undefined ? {} : { author }),
    ...(publishedAt === undefined ? {} : { publishedAt }),
    ...(siteName === undefined ? {} : { siteName }),
    ...(lang === undefined ? {} : { lang }),
    ...(leadImage === undefined ? {} : { leadImage }),
  };
  return Object.keys(source).length === 0 ? undefined : source;
}
```

- [ ] **Step 5: Wire it into `validateClipInput`**

In `validateClipInput`, below the existing `canonicalUrl` line, add the call and extend the return. The return statement is currently:

```ts
  return { url, title, body, mode, capturedAt, tags, ...(canonicalUrl ? { canonicalUrl } : {}) };
```

Replace those two statements with:

```ts
  const canonicalUrl =
    typeof o["canonicalUrl"] === "string" ? (o["canonicalUrl"] as string) : undefined;
  const source = validateClipSource(o["source"]);
  return {
    url,
    title,
    body,
    mode,
    capturedAt,
    tags,
    ...(canonicalUrl ? { canonicalUrl } : {}),
    ...(source === undefined ? {} : { source }),
  };
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test packages/gateway/src/clips/clip-ingest.test.ts`

Expected: PASS, all tests including the pre-existing ones.

- [ ] **Step 7: Typecheck and lint**

Run: `bun run typecheck && bun run lint`

Expected: zero errors. If Biome reformats the new code, accept its formatting.

- [ ] **Step 8: Commit**

```bash
git add packages/gateway/src/clips/clip-ingest.ts packages/gateway/src/clips/clip-ingest.test.ts
git commit -m "feat(clips): validate an optional source object on POST /v1/clips"
```

---

## Task 2: `metadata.source` reaches storage

**Files:**

- Modify: `packages/gateway/src/clips/clip-ingest.ts` (the `metadata` object literal inside `ingestClip`)
- Test: `packages/gateway/src/clips/clip-ingest.test.ts`

**Interfaces:**

- Consumes: `ClipSource` and `ClipInput.source` from Task 1.
- Produces: an item whose `metadata` JSON carries a `source` key when, and only when, `input.source` is defined.

- [ ] **Step 1: Write the failing tests**

Append to `packages/gateway/src/clips/clip-ingest.test.ts`:

```ts
describe("clip source metadata — storage", () => {
  const base = {
    url: "https://ex.com/p",
    title: "Hello",
    mode: "article" as const,
    body: "The body text",
    tags: ["research"],
    capturedAt: 1750000000000,
  };

  function metaOf(id: string): Record<string, unknown> {
    return JSON.parse(String(getItem(id)?.["metadata"])) as Record<string, unknown>;
  }

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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/gateway/src/clips/clip-ingest.test.ts`

Expected: FAIL on every assertion reading `metadata.source` — `ingestClip` composes its metadata itself and does not know about `input.source` yet. The "no source → metadata is exactly what it was before" test should already PASS; that is the fence, and it must stay green through Step 3.

- [ ] **Step 3: Add the one key**

In `ingestClip`, in the `metadata` object literal passed to `upsertIndexedItem`, add a `source` spread after `clippedAt`:

```ts
    metadata: {
      tags: input.tags,
      mode: input.mode,
      wordCount: extent.storedWords,
      ...(extent.sourceWords === undefined
        ? {}
        : { sourceWordCount: extent.sourceWords, truncated: true }),
      clippedAt: input.capturedAt,
      // `input.source` is the object `validateClipInput` BUILT, never the one the
      // caller sent — see `validateClipSource`. Nothing filters it here, so the
      // filtering has to have already happened.
      //
      // Note that a re-clip WITHOUT `source` clears a previously-stored one:
      // `upsertIndexedItem` replaces metadata wholesale (`metadata = excluded.metadata`),
      // so every metadata key is last-write-wins. `tags` already behave exactly this
      // way. This is inherited behaviour, documented rather than changed here.
      ...(input.source === undefined ? {} : { source: input.source }),
    },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/gateway/src/clips/clip-ingest.test.ts`

Expected: PASS, all tests.

- [ ] **Step 5: Run the full gateway suite**

Run: `bun test packages/gateway`

Expected: PASS. Any clip-adjacent route or index test that asserts on metadata shape would surface here; nothing should, because the key is absent when `source` is.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/clips/clip-ingest.ts packages/gateway/src/clips/clip-ingest.test.ts
git commit -m "feat(clips): store validated clip provenance at metadata.source"
```

---

## Task 3: Pin the three things this must not change

**Files:**

- Test: `packages/gateway/src/clips/clip-ingest.test.ts` (tests only — no source change is expected)

**Interfaces:**

- Consumes: everything from Tasks 1 and 2.
- Produces: nothing new. These tests exist so a future reader cannot assume the properties were broken, and so a future change that breaks one fails loudly.

- [ ] **Step 1: Write the tests**

Append to `packages/gateway/src/clips/clip-ingest.test.ts`:

```ts
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

  function metaOf(id: string): Record<string, unknown> {
    return JSON.parse(String(getItem(id)?.["metadata"])) as Record<string, unknown>;
  }

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
```

- [ ] **Step 2: Run the tests**

Run: `bun test packages/gateway/src/clips/clip-ingest.test.ts`

Expected: PASS immediately, with no source change. These pin existing behaviour — a failure here means Task 1 or 2 broke something and must be fixed in `clip-ingest.ts`, not by weakening the test.

- [ ] **Step 3: Commit**

```bash
git add packages/gateway/src/clips/clip-ingest.test.ts
git commit -m "test(clips): pin clip identity, modified_at and author_id against source metadata"
```

---

## Task 4: Changelog, gates, and the PR

**Files:**

- Modify: `docs/CHANGELOG.md`

**Interfaces:**

- Consumes: the finished behaviour from Tasks 1–3.
- Produces: the merged branch.

- [ ] **Step 1: Add the changelog entry**

In `docs/CHANGELOG.md`, insert this as the **first** bullet under the `## Post-Phase-6 deliveries` heading, above the `2026-08-21 — Listed in the official MCP Registry` entry (the file is reverse-chronological):

```markdown
- **2026-08-21 — A web clip can finally say who wrote it.**
  `POST /v1/clips` gains one optional `source` object — `author`, `publishedAt` (epoch ms),
  `siteName`, `lang`, `leadImage` — which lands at `metadata.source`. Until now a clip was the
  one item type in the index that arrived without provenance: `validateClipInput` read exactly
  seven fields and dropped the rest, so the `byline`, `siteName`, `publishedTime` and `lang`
  Mozilla Readability already parses had nowhere on the wire to go. Every field is optional and
  every field is bounded, because all of them are controlled by whatever page the user is looking
  at and `upsertIndexedItem` throws above 64 KB of serialised metadata. **Three choices here are
  deliberate and unlike the rest of this body.** A malformed *member* is **dropped, not rejected**
  — `asString` throws because a clip without a title is not a clip, but a clip with a garbled
  byline is still a perfectly good clip, and failing it would let one bad `<meta>` tag cost the
  user their capture; a `source` that is not a JSON object is still a validation error, because
  that is caller error rather than page noise. Prose **truncates** and structured values **drop**:
  `author` and `siteName` are cut to 200 characters and are still useful, while an over-length
  `lang` (20) or `leadImage` (2048) is discarded, since half a URL is a broken link rather than a
  shorter one and a consumer cannot tell it was cut. And the validator **constructs** a new object
  from the five known fields rather than passing the caller's through — a whitelist, not a
  blocklist, because a single unrecognised sibling key, large enough to cross the store's 64 KB
  ceiling, would let a page deny ingestion of its own clip. `publishedAt` is normalised to
  epoch ms by the client and checked here only for "an integer inside `Date`'s range"; pre-1970
  and far-future values are valid and kept, because archived essays and embargoed posts carry them
  honestly and nothing sorts on this field. Clip identity, `modified_at` and `author_id` are
  unchanged and now pinned by tests: `externalIdFor` still hashes only the canonical URL (and the
  body, for selections), so re-clipping a page whose byline changed is an `updated` on the same
  id; `modified_at` still comes from `capturedAt`; and `author_id` stays null, since a byline
  string is not an identity claim. One inherited behaviour is worth knowing rather than
  discovering: a re-clip that sends no `source` **clears** a stored one, because
  `upsertIndexedItem` replaces metadata wholesale — exactly as `tags` already behave.
  Design: [clip source metadata](./superpowers/specs/2026-08-20-clip-source-metadata-design.md).
```

- [ ] **Step 2: Run every gate**

Run each, and read the output rather than assuming:

```bash
bun run typecheck
bun run lint
bun test packages/gateway
bun run lint:markdown
bun scripts/structure-audit/check-doc-references.ts --check
```

Expected: all pass. `bun run lint:markdown` is the gate that most often turns a locally-green branch red here — it covers `docs/**`, so both the changelog entry and this plan document are in scope. Fix any MD rule it reports rather than adding a suppression.

- [ ] **Step 3: Commit**

```bash
git add docs/CHANGELOG.md docs/superpowers/plans/2026-08-21-clip-source-metadata.md
git commit -m "docs: record optional clip source metadata on POST /v1/clips"
```

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin dev/asafgolombek/clip-source-metadata-impl
```

Open the PR against `main` using `.github/PULL_REQUEST_TEMPLATE.md`. Type of Change is **New feature (non-breaking)**. In the Summary, state that this is **S2** of `nimbus-web-clipper` roadmap item **2.5**, that S1 (canonical-URL fidelity) shipped as `nimbus-web-clipper#67`, and that **S3 is gated on this being released, not merely merged** — shipping the client extraction earlier would show Author and Published in the extension's pre-send preview while a deployed validator still discarded them. Note explicitly that `openapi/v1.yaml` and `WRITE_ROUTE_ALLOWLIST` were checked and need no edit, so a reviewer does not re-derive it.

---

## Self-Review

- **Spec coverage.** Contract → Task 1 Step 3. Validation rules (absent, non-object, wrong-typed member, empty-after-trim, all-dropped, unknown discarded) → Task 1 Steps 4–5. The four length bounds and the `publishedAt` type bound → Task 1 Step 4. `metadata.source` composition → Task 2 Step 3. All twenty-odd named test cases → Tasks 1–3. The three "what this does not change" pins → Task 3. The wholesale-replace behaviour documented rather than fixed → Task 2 Step 3 comment, Task 3 final test, Task 4 changelog. `docs/CHANGELOG.md` → Task 4. The two non-applicable gates → Global Constraints and Task 4 Step 4.
- **Placeholders.** None: every code step carries the literal code, every test step carries the literal assertions, and every run step carries the exact command and expected result.
- **Type consistency.** `ClipSource` is declared once (Task 1 Step 3) and referenced by that name in Tasks 1–3. `validateClipSource`, `boundedProse`, `boundedExact` and `epochMs` are each defined once and called under those exact names. `SOURCE_PROSE_MAX` / `SOURCE_LANG_MAX` / `SOURCE_LEAD_IMAGE_MAX` / `DATE_RANGE_MAX_MS` are defined in Task 1 Step 4 and used only there.
