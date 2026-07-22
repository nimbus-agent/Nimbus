/** Caps and bounds for research briefs. See docs/superpowers/specs/2026-07-21-research-briefs-design.md. */

/**
 * Live runs held in memory at once, counting only `collecting`/`running`.
 * Bounds worst-case source memory at 3 x MAX_RUN_BYTES = 12 MB. Terminal runs
 * have already dropped their bodies, so counting them against a MEMORY cap
 * would be incoherent — and would lock a user out for 20 minutes over ~60 KB.
 */
export const MAX_CONCURRENT_RUNS = 3;
/**
 * Terminal runs retained for GET/save after finishing, oldest evicted first.
 * Without this the create rate limit alone would permit ~600 retained reports
 * across a 30-minute TTL.
 */
export const MAX_RETAINED_TERMINAL_RUNS = 16;
/** Declared sources per run. The client caps its composer at this number. */
export const MAX_SOURCES_PER_RUN = 20;
/**
 * UTF-8 bytes of a single source body. 256 KB against the client's 200 KB
 * extraction cap, leaving headroom for JSON escaping and multi-byte text.
 */
export const MAX_SOURCE_BYTES = 256 * 1024;
/**
 * UTF-8 bytes of all bodies in one run. DELIBERATELY NOT
 * MAX_SOURCES_PER_RUN * MAX_SOURCE_BYTES — the per-source cap stops one
 * pathological page, this one bounds what the gateway holds. A conforming
 * client (20 x 200 KB) lands exactly on it.
 */
export const MAX_RUN_BYTES = 4 * 1024 * 1024;
/** Run lifetime from creation. NOT refreshed on access — a polling client must not pin memory. */
export const DEFAULT_RUN_TTL_MS = 30 * 60_000;
/** Characters of the brief question itself. */
export const MAX_BRIEF_CHARS = 4000;

/** Report bounds — keep the saved report under RAW_META_MAX_BYTES (64 KB). */
export const MAX_FINDINGS = 25;
export const MAX_CONFLICTS = 25;
export const MAX_CITATIONS_PER_ITEM = 8;
export const MAX_QUOTE_CHARS = 200;
/** Characters of the report summary. Bounds the largest single free-text field. */
export const MAX_SUMMARY_CHARS = 2000;
/** Characters of one finding's or conflict's prose. */
export const MAX_ITEM_TEXT_CHARS = 600;

/** Indexed clips pulled in when useIndex is true. */
export const MAX_INDEX_HITS = 8;

/**
 * Characters of a source ref's `title`, once fed into the registry. A single
 * ref is copied into every citation that names it, so an unbounded title —
 * multiplied across up to 200 citations — would blow the report's 64 KB
 * metadata budget regardless of the count caps above.
 */
export const MAX_REF_TITLE_CHARS = 120;
/**
 * Characters of a source ref's `url`, once fed into the registry. Same
 * fan-out rationale as MAX_REF_TITLE_CHARS.
 */
export const MAX_REF_URL_CHARS = 300;
