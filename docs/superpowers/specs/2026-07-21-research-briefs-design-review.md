# Design Review: Research Briefs (Gateway Side)

**Date:** 2026-07-21
**Target Spec:** [2026-07-21-research-briefs-design.md](file:///C:/gitrep/Nimbus/.claude/worktrees/research-briefs-gateway/docs/superpowers/specs/2026-07-21-research-briefs-design.md)

---

## 1. Memory and Cap Consistency

### Cap Overlap
- **Observation:** `MAX_SOURCES_PER_RUN = 20` and `MAX_SOURCE_BYTES = 256 KB` results in a theoretical maximum source payload of **5 MB** ($20 \times 256 \text{ KB}$) per run. However, the `MAX_RUN_BYTES` is capped at **4 MB**.
- **Impact:** A client trying to legitimately feed 20 sources of ~220 KB each will be blocked at the 16th/17th source with a `413 Payload Too Large` error, even though all individual constraints (`MAX_SOURCE_BYTES`, `MAX_SOURCES_PER_RUN`) are respected.
- **Suggestion:** Align the caps so they are mathematically consistent. Either increase `MAX_RUN_BYTES` to **5 MB** or reduce `MAX_SOURCES_PER_RUN` / `MAX_SOURCE_BYTES` accordingly.

### Concurrency Cap & Memory Eviction
- **Observation:** Eviction of expired runs (`RUN_TTL_MS = 30 min`) is stated as **lazy** (evaluated on access).
- **Potential Issue:** If a client initiates 3 concurrent runs (filling `MAX_CONCURRENT_RUNS = 3`), lets them time out, and never polls/accesses those run IDs again, they remain in the map. A new `POST /v1/briefs` call might return `429 Rate Limited` if it checks the size of the active runs map before evicting expired runs.
- **Suggestion:** Explicitly mandate that the creation endpoint (`POST /v1/briefs`) must perform a sweeping eviction on the entire in-memory run store before validating the concurrency cap of 3.

---

## 2. Citation and Quote Validation Robustness

### Normalizing Substring Matching for Quotes
- **Observation:** "A `quote` that is not a verbatim substring of the cited body is dropped."
- **Potential Issue:** LLMs are notorious for slightly modifying quotes, such as changing smart quotes to straight quotes, normalizing line breaks (LF vs CRLF), stripping double spaces, or converting non-breaking spaces to standard spaces. A strict binary substring match (`body.includes(quote)`) will fail for these trivial differences, resulting in lost citations.
- **Suggestion:** Implement a normalized substring check. Before checking containment:
  - Collapse all consecutive whitespace characters to a single space.
  - Normalize quote characters (e.g., replace `“”` with `""`).
  - Strip leading/trailing punctuation if necessary.
  - Compare using case-insensitive/whitespace-normalized equivalents.

### Save-back Size Limits
- **Observation:** The final report is saved under the generic `item` table with `metadata` capped at 64 KB (`RAW_META_MAX_BYTES`).
- **Potential Issue:** If a synthesis yields a long summary, many findings/conflicts, and dozens of cited source objects (with their titles, URLs, and metadata), the JSON string could theoretically approach 64 KB. 
- **Suggestion:** Add a check during `POST /v1/briefs/{id}/save` that ensures the serialized payload fits within the 64 KB limit. If it does not, clean up or truncate non-critical details (like long titles/URLs in `SourceRef` or reducing the summary) rather than failing the write.

---

## 3. Ephemeral Collection and Modifiability

### URL Updates/Refreshes
- **Observation:** `POST /v1/briefs/{id}/sources` is idempotent per canonical URL. Re-feeding a URL returns `{ accepted: false }`.
- **Potential Issue:** If the clipper user clicks "refresh" or extracts a tab again while the brief is still in the `collecting` phase, the updated body is silently rejected.
- **Suggestion:** Allow source replacement during the `collecting` phase, or document why updates are blocked. If overwriting is permitted, ensure total byte counters (`bytesHeld`) are correctly decremented by the old body's size before applying the new body.

---

## 4. Query Routing & Search Pre-processing

### Passing Long Questions to Semantic Search
- **Observation:** `useIndex` retrieves related clips via `searchRankedAsync` matching the `brief` name (i.e., the user's brief question).
- **Observation:** A brief question like *"compare MV3 service worker lifecycles across Chrome and Firefox"* is natural language. If keyword fallbacks or hybrid search models are used, passing a long sentence directly can yield poor recall.
- **Suggestion:** Consider whether the query passed to `searchRankedAsync` should be pre-processed (e.g. by extracting keywords or asking the LLM for search queries) or if we rely entirely on semantic vector matching on the raw natural language question. If the latter, document that semantic matching is expected to handle full questions.
