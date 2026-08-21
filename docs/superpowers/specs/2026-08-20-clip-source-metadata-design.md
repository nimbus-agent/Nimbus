# Clip source metadata — author, publish date and site name on `POST /v1/clips`

> **Status:** design, approved 2026-08-20. This is the **gateway slice** of a
> cross-repo feature; the browser slice is
> `nimbus-web-clipper` → `docs/superpowers/specs/2026-08-20-faithful-metadata-and-canonical-url-design.md`
> (roadmap item **2.5**). The contract below is proposed here and consumed
> there. The clipper's other two slices do **not** depend on this one and are
> not blocked by its review.

## What the clipper is asking for

The web clipper extracts a page with Mozilla Readability, which already returns
`byline`, `siteName`, `publishedTime` and `lang` — parsed from JSON-LD and
OpenGraph. It throws all four away, because there is nowhere on the wire to put
them.

`validateClipInput` (`packages/gateway/src/clips/clip-ingest.ts:46`) reads
exactly seven fields:

```ts
const url = asString(o, "url");
const title = asString(o, "title");
const body = asString(o, "body");
// mode, capturedAt, tags, canonicalUrl
return { url, title, body, mode, capturedAt, tags, ...(canonicalUrl ? { canonicalUrl } : {}) };
```

Everything else in the request body is dropped on the floor. `ingestClip` then
composes the item's `metadata` itself (`clip-ingest.ts:144`) from `tags`,
`mode`, `wordCount` and `clippedAt`. So a clip today is a title, a body and a
URL — a page you saved, with no record of who wrote it or when.

That is the gap. A clip that cannot say who wrote it is not a citeable record,
and it is the one item type in the index that arrives without provenance —
every connector-sourced item has an author and a modified time from its source.

## The contract

One optional object on the request body, namespaced so it can never collide
with the metadata keys `ingestClip` composes for itself:

```ts
export interface ClipSource {
  readonly author?: string;
  readonly publishedAt?: number;   // epoch ms
  readonly siteName?: string;
  readonly lang?: string;
  readonly leadImage?: string;     // absolute http(s) URL
}

export interface ClipInput {
  // …the seven existing fields, unchanged…
  readonly source?: ClipSource;
}
```

It lands as `metadata.source`:

```ts
metadata: {
  tags: input.tags,
  mode: input.mode,
  wordCount: extent.storedWords,
  …,
  clippedAt: input.capturedAt,
  ...(input.source === undefined ? {} : { source: input.source }),
}
```

`input.source` here is the object **`validateClipInput` built**, never the one
the caller sent — see the whitelist rule below. `ingestClip` stores what it is
given without further filtering, so the filtering has to have already happened.

### Why `publishedAt` is a number, not a string

`article:published_time` and JSON-LD `datePublished` carry whatever format the
publisher chose. Parsing that is real work with real ambiguity (two-digit years,
missing zones, locale orderings), and it does not belong on a locked ingest path
where a parse failure would cost the caller their clip.

So the **client normalises to epoch ms** — matching `capturedAt`, which is
already epoch ms on this same body — and this validator checks only that the
number is an integer inside `Date`'s range. A date the client cannot parse is a
field the client omits. This keeps the gateway's date handling at zero and puts
the messy parsing next to the messy input.

### Validation rules

`validateClipInput` gains one block, and its shape is deliberately unlike the
existing field checks:

- **`source` absent** → `undefined`, as today. The overwhelmingly common shape.
- **`source` present but not an object** (or `null`, or an array) →
  `ClipValidationError("source must be a JSON object", "source")`. A caller
  sending the wrong *kind* of thing is a bug worth reporting.
- **A member of the wrong type** → **dropped, not thrown.** This is the
  departure. `asString` throws because a clip without a title is not a clip; a
  clip with a malformed byline is still a perfectly good clip, and failing it
  would mean one bad `<meta>` tag on a page costs the user the capture. Wrong
  types here are page-supplied noise, not caller error.
- **An empty string after trimming** → dropped, so `metadata.source` never
  carries `author: ""`.
- **Every member absent or dropped** → `source` is omitted entirely rather than
  stored as `{}`.
- **Unknown members are discarded.** `validateClipInput` **constructs a new
  `ClipSource`** from the five fields named above; it never returns the caller's
  object, spread or otherwise. This is not tidiness — it is the load-bearing
  half of the bounds below. Every per-field cap is worthless if an unrecognised
  sibling key rides along beside them: `ingestClip` stores whatever `source`
  holds, `upsertIndexedItem` serialises the whole metadata object, and it
  **throws** above 64 KB (`RAW_META_MAX_BYTES`, 65,536 bytes). A page that put
  enough under `source.junk` to cross that ceiling would make its own clip
  un-ingestable, which is precisely the denial the caps exist to prevent. A
  whitelist, not a blocklist: the shape TypeScript describes and the shape that
  reaches storage must be the same object, built here.

Every field is bounded, because `upsertIndexedItem` throws outright when an
item's serialised metadata exceeds 64 KB
(`packages/gateway/src/index/item-store.ts:85`) and all of these values are
controlled by whatever page the user is looking at. Without bounds, a hostile
page could make a clip un-ingestable. But **how** a field is bounded depends on
what kind of value it is:

| Field | Bound | Over the bound |
| --- | --- | --- |
| `author` | 200 chars | truncated |
| `siteName` | 200 chars | truncated |
| `lang` | 20 chars | **dropped** |
| `leadImage` | 2048 chars | **dropped** |

**Prose degrades; structured values corrupt.** A byline cut to 200 characters is
still a byline and still tells you who wrote the thing. Half a URL is not a
slightly-worse URL — it is a broken link, and storing it is worse than storing
nothing, because a consumer cannot tell it was truncated. The same is true of a
language tag: BCP-47 tags top out around 10 characters (`zh-Hans-CN`), so
anything past 20 is, in practice, garbage prose in the wrong field rather than a
tag, and truncating it to `en-US`-shaped nonsense would be actively misleading.

To be precise about that bound, since the reasoning above reads like a fact
about the standard and is not: **BCP 47 sets no maximum total tag length.**
Private-use and extension subtags can repeat, so `en-x-abcdefgh-abcdefgh` is a
perfectly valid 22-character tag. **20 is a product limit**, chosen because
every tag this field will realistically carry — `en`, `en-US`, `zh-Hans-CN` —
fits inside it with room to spare, and a longer value is far likelier to be a
page's prose leaking into the wrong `<meta>` than a genuine private-use tag we
would do anything with. Tags over the bound are dropped **deliberately**, not
by accident of the standard.

`leadImage`'s bound is 2048 rather than 200 for the same reason review raised
it: CDN image URLs routinely carry resize, format and signature parameters, and
200 characters would put most real lead images over the line. 2048 is the
practical URL ceiling most stacks assume, and even a full set of these fields at
their bounds is under 3 KB against a 64 KB ceiling — the cap is there to stop
abuse, not to economise.

`publishedAt` is bounded too, and by type rather than length:

- **must be an integer** — `Number.isFinite` alone admits `1.5`, and a
  fractional millisecond is meaningless. The only caller normalises through
  `Date.parse`, which yields integers, so a non-integer is garbage rather than
  legitimate data being narrowed; it is dropped, consistent with the rule above.
- **must be within the range `Date` can represent** (|v| ≤ 8.64e15). This is a
  principled bound rather than an arbitrary one: it is exactly "a number
  `new Date()` can turn into a date".

Two range rules review proposed are **deliberately not adopted**:

- **Rejecting negative (pre-1970) values.** They are legitimate. An index that
  holds papers, archived essays and scanned documents will meet 1965 publication
  dates, and a clipper that silently dropped them would be wrong in exactly the
  library case this field exists to serve.
- **Rejecting dates more than a year in the future.** Embargoed and scheduled
  posts carry future dates honestly. The concern review raised — garbage
  "corrupting the index sort order/display" — does not arise here, because
  `publishedAt` lands in `metadata` and **nothing sorts on it**; `modified_at`
  still comes from `capturedAt` (see below). If a later change makes
  `publishedAt` drive ordering, that change owns the bound, and it will have a
  concrete reason to pick one.

`leadImage` is stored as a reference and **never fetched**. Nothing in this
change makes an outbound request, so it adds no egress surface and no `I29`
coverage class.

## What this does not change

Three properties the tests must pin, because each is the kind of thing a future
reader will assume was broken:

1. **Clip identity is untouched.** `externalIdFor` (`clip-ingest.ts:76`) hashes
   the canonicalised URL, plus the body for `mode: "selection"`. Metadata is not
   in the hash and must not enter it. Re-clipping a page after its byline
   changed stays an `updated` on the same `id` — not a second item.
2. **`modified_at` still comes from `capturedAt`.** Letting `publishedAt` drive
   `modified_at` was considered and deliberately rejected for this slice: it
   would change clip sort order and the panel's freshness line on data already
   in every user's index, which is a behaviour change on shipped state rather
   than an addition. Worth doing, worth doing on its own.
3. **`author_id` stays null.** Resolving a byline string to a `person` row is
   fuzzy, cross-connector, and a design of its own. `metadata.source.author` is
   a string the clip carries, not an identity claim.

One inherited behaviour must be **documented rather than fixed**: a re-clip that
sends no `source` clears a previously-stored one, because `upsertIndexedItem`
replaces metadata wholesale (`item-store.ts:130`, `metadata = excluded.metadata`).
`tags` already behave exactly this way. Left silent, the first person to notice
will file it as a bug.

## Surfaces touched

| File | Change |
| --- | --- |
| `packages/gateway/src/clips/clip-ingest.ts` | `ClipSource`, validation block, `metadata.source` |
| `packages/gateway/src/clips/clip-ingest.test.ts` | the cases below |
| `docs/CHANGELOG.md` | the new optional field |

Two gates that look like they apply and do not:

- **`packages/gateway/openapi/v1.yaml` needs no edit.** The clip routes are not
  described there — the file covers the read-only data API, and `/v1/clips`
  appears nowhere in its 482 lines. Checked rather than assumed.
- **`WRITE_ROUTE_ALLOWLIST` needs no edit.** This adds a field to an existing
  route, not a route. No `I13` allowlist change, no `I30` minting change, no
  clip-token scope change.

`docs/architecture.md`'s allowlist row (line 1689) describes routes, not body
shapes, so it is likewise unchanged.

## Testing

Against `clip-ingest.test.ts`'s existing style:

- `source` absent → item metadata is byte-identical to today's (the
  no-regression fence)
- a full `source` → all five land under `metadata.source`
- `source: "nope"` / `source: null` / `source: []` → `ClipValidationError` with
  `field: "source"`
- `author: 42` alongside a valid `siteName` → the clip ingests, `author` is
  gone, `siteName` is there (the drop-don't-throw rule, which is the one a
  reviewer will most want to see proven)
- a 5,000-character `author` → truncated to 200, and the item still ingests
- **a 70 KB unknown member** (`source: { author: "A", junk: "<70KB>" }`) → the
  clip ingests, `metadata.source` carries `author` and **no `junk` key**. This
  is the test that proves the whitelist: without it the item would exceed the
  store's 64 KB metadata ceiling and `upsertIndexedItem` would throw, so a page
  could deny ingestion of its own clip.
  **The size has to be over the ceiling, not merely large.** This bullet said
  60 KB when the spec was approved, and the implementation copied it before
  review caught the arithmetic: that metadata serialises to 60,112 bytes against
  `RAW_META_MAX_BYTES` of 65,536, so it never crossed, and the test passed on its
  `toEqual` assertion while advertising itself as a denial-of-ingestion fence.
  70 KB serialises to 70,112 bytes and genuinely crosses. Shipped that way in
  #1285
- a valid 22-character BCP 47 tag (`en-x-abcdefgh-abcdefgh`) → dropped, and the
  clip still ingests — pinning that the 20-character bound is a product limit
  applied deliberately, not a claim that longer tags are malformed
- a 30-character `lang` → **dropped, not truncated** — with the stored metadata
  asserted to have no `lang` key at all, since "truncated to something
  plausible" is the failure this rule exists to prevent
- a 3,000-character `leadImage` → **dropped, not truncated**, same assertion
- a 900-character CDN `leadImage` with resize and signature parameters →
  **kept intact**, which is the case that motivated the 2048 bound
- `publishedAt: "2026-01-01"` → dropped, clip ingests
- `publishedAt: Number.NaN` / `Infinity` / `1.5` → dropped, clip ingests
- `publishedAt: -157766400000` (a 1965 publication date) → **kept**, pinning
  that pre-1970 dates are legitimate
- `publishedAt: 1e300` → dropped (outside `Date`'s range)
- `author: "   "` → dropped, and `metadata.source` is absent rather than `{}`
- **identity**: ingest, then re-ingest the same URL with a different `source` →
  same `id`, `status: "updated"`, one row
- **metadata replacement**: ingest with `source`, re-ingest without → `source`
  is gone, documenting the inherited wholesale-replace behaviour

## Gates

`bun run lint:markdown` covers `docs/` and will fail this document if it drifts
from the house rules — it is the gate that most often turns a locally-green
branch red here. Otherwise the usual: `bun run typecheck`, `bun run lint`, the
gateway test suite.
