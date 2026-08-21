# Review: Clip Source Metadata (S2) Implementation Plan

Below is a detailed review of the proposed execution plan in [2026-08-21-clip-source-metadata.md](./2026-08-21-clip-source-metadata.md), outlining validation correctness, code safety, and suggestions.

---

## 1. Validation & Code Safety Observations

### A. Non-Finite / Floating-Point Date Protection

In `epochMs`:

```ts
function epochMs(v: unknown): number | undefined {
  if (typeof v !== "number" || !Number.isInteger(v) || Math.abs(v) > DATE_RANGE_MAX_MS) {
    return undefined;
  }
  return v;
}
```

* **Pros**: Using `Math.abs(v)` correctly bounds-checks both future and past dates. The inclusive range is April 20, 271821 BCE to September 13, 275760 CE — the millisecond bound is symmetric, the calendar endpoints are not. Rejects `NaN` and `Infinity` safely since they are not integers.
* **Suggestion**: Ensure that callers from client-side normalise properly to milliseconds, as a standard Unix epoch timestamp in seconds (e.g., `1750000000`) is technically a valid integer within the millisecond-range but would point to January 1970 if not scaled. The client-side normalization must handle this, which is outside the scope of the server validator but worth documenting.

### B. Object Construction Style

In `validateClipSource`:

```ts
  const source: ClipSource = {
    ...(author === undefined ? {} : { author }),
    ...(publishedAt === undefined ? {} : { publishedAt }),
    ...(siteName === undefined ? {} : { siteName }),
    ...(lang === undefined ? {} : { lang }),
    ...(leadImage === undefined ? {} : { leadImage }),
  };
```

* **Pros**: Safely filters out `undefined` properties, preventing them from serializing as explicit `{ "author": null }` or `{ "author": undefined }` keys in JSON.
* **Improvement**: Although the spread pattern works perfectly, an alternative clean construction pattern that avoids multiple object allocations (especially since this executes on every clip ingestion) is:

  ```ts
  const source: { -readonly [K in keyof ClipSource]: ClipSource[K] } = {};
  if (author !== undefined) source.author = author;
  if (publishedAt !== undefined) source.publishedAt = publishedAt;
  if (siteName !== undefined) source.siteName = siteName;
  if (lang !== undefined) source.lang = lang;
  if (leadImage !== undefined) source.leadImage = leadImage;
  ```

  Both styles are acceptable, but the direct assignment is slightly more performant and avoids intermediate object allocation.

  **Outcome: this suggestion was NOT adopted; the spread construction shipped.** Recorded here
  so the rejection is not re-litigated. The accumulator was first drafted as
  `Record<string, any>`, which fails two repository rules outright — Biome sets
  `noExplicitAny: "error"`, and an open index signature admits keys outside the five-field
  `ClipSource` shape, which is exactly the whitelist property this validator exists to hold. The
  mutable-mapped-type form above fixes both and is what a corrected version of the suggestion
  looks like, but it was still declined: the object literal is the form a reader can compare
  against `ClipSource` at a glance, and a mutable accumulator is the shape that invites a later
  `source[key] = value` loop — which would reintroduce the hole. The allocation cost is
  unmeasurable beside the `sha256`, two SQLite statements and full-metadata `JSON.stringify`
  already on this path.

---

## 2. Test Verification

### A. Missing `db` Import Context

In Task 2, `db` is used directly in `describe("clip source metadata — storage")`.

* **Note**: In `clip-ingest.test.ts`, `db` is defined in the top-level block and initialized in `beforeEach`. Nested `describe` blocks in Bun Test correctly inherit variables from the parent scope, so this will work seamlessly.

### B. Whitelist / Unknown Fields Verification

The whitelist testing:

```ts
  test("an unknown member is discarded — the whitelist, not a blocklist", () => {
    const out = validateClipInput({
      ...good,
      source: { author: "A", junk: "x".repeat(60_000) },
    });
    expect(out.source).toEqual({ author: "A" });
    expect(Object.keys(out.source ?? {})).toEqual(["author"]);
  });
```

This is an excellent test case. It proves that extraneous metadata fields (like `junk`) are stripped before writing, mitigating potential database payload bloat or serialization errors.

---

## 3. Suggestions

1. **URL Schema check (Optional)**: `leadImage` is validated only by length (`SOURCE_LEAD_IMAGE_MAX`). While validating full URL schema (e.g., protocol check `http:` or `https:`) is sometimes helpful, dropping a URL that fails a regex check but is otherwise valid is risky. The choice to only length-limit it is pragmatic and robust.
2. **Metadata wholesale replacement documentation**: The plan explicitly highlights that re-clipping without `source` clears a previously-stored one. Keeping this behavior documented in both the test files and code comments is a strong engineering choice.
