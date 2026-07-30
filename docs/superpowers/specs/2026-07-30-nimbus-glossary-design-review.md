# Review & Feedback: `nimbus glossary` Design

This document contains a structured review, suggestions, improvements, and open questions regarding the design of the `nimbus glossary` command and agent system specified in [2026-07-30-nimbus-glossary-design.md](file:///C:/gitrep/Nimbus/.claude/worktrees/nimbus-glossary/docs/superpowers/specs/2026-07-30-nimbus-glossary-design.md).

---

## 1. Questions on Incremental Processing & Watermarks

### Q1.1: Handling of Deleted or Edited Source Items (Stale Statistics)
The design states:
> For every candidate it touches, exact global statistics are recomputed from the existing `item_fts` index [...] Accumulated counters drift [...] Recomputed statistics are idempotent.

- **The Issue:** If an item is deleted (or edited such that a term is removed) and no other modified items touch that term, the term's statistics will *never* be recomputed because the term is not "touched" during incremental scans (`modified_at > watermark_ms`). Consequently, the term's `doc_freq` and `service_spread` in the database will remain stale and artificially inflated.
- **Questions:**
  1. Do we need a mechanism to periodically prune or re-evaluate glossary terms whose sources may have been deleted?
  2. Should we periodically run a full stats-refresh pass (e.g., once a week or on a full sync)?

### Q1.2: Scope of the Consolidation Step (Step 7)
Step 7 in the sequence states:
> Take the top `max_new_terms_per_pass` (default 25) unconsolidated rows by score.

- **Clarification Question:** Does this select from *all* accumulated `pending` rows currently in the database (i.e. `SELECT ... WHERE status = 'pending' ORDER BY score DESC LIMIT 25`), or is it limited only to the candidates newly discovered/modified in the current pass?
- **Recommendation:** It should select globally from the `glossary_term` table to ensure that high-scoring candidates found in previous passes eventually get consolidated even if they weren't modified in the current pass.

---

## 2. Resource Management & Local LLM Usage

### Q2.1: Concurrency Control for Local LLM Consolidation
Consolidating 25 terms per pass with local LLM calls can take substantial time (often several seconds per prompt on consumer hardware).
- **Questions:**
  1. Are these consolidation LLM calls executed sequentially or in parallel?
  2. If parallel, is there a concurrency limit (e.g. `p-limit`) to prevent overloading/exhausting memory of local LLM providers like Ollama?
- **Recommendation:** Implement a strict concurrency limit (e.g. max 2 or 3 concurrent requests) to maintain gateway stability, and ensure the entire pass orchestrator is fully cancellable / handles timeouts gracefully.

### Q2.2: Pass Interruption & Watermark Commit
If the Gateway is shut down or a sync is aborted during the consolidation of the 25 terms:
- **Question:** Do we commit the `watermark_ms` and progress only *after* all LLM calls finish, or incrementally?
- **Recommendation:** Update the watermark state only after successfully saving the consolidated terms for that pass, or track watermark progress per-item so we do not lose track of items we scanned but failed to consolidate.

---

## 3. Mining Accuracy & Stopwords

### Q3.1: Code Syntax Noise in Backticked Tokens
Because the design mines backticked tokens (Family: `Backticked / code-fenced token`), there is a high likelihood of capturing programming keywords (e.g., `const`, `import`, `return`, `async`, `await`, `function`, `class`, `interface`) if technical documentation, Markdown files, or commit messages are indexed.
- **Recommendation:** Ensure the `stopwords.ts` baseline includes standard programming language keywords across major languages (JS/TS, Go, Rust, Python, SQL) to avoid polluting the pending glossary with syntax noise.

### Q3.2: Capitalized Multi-word Phrases (Family 5)
Capitalized multi-word phrases (e.g., `"Shadow Traffic"`) can easily capture common English sentence starters (e.g., `"The target"`, `"On Sunday"`, `"In addition"`).
- **Recommendation:** Apply strict validation rules to capitalized multi-word phrases, such as checking that none of the words are common prepositional/article stopwords (like `In`, `On`, `At`, `The`, `And`) even if they are capitalized.

---

## 4. User Experience & Synonyms

### Q4.1: Searching Synonyms
When `nimbus glossary <term>` or `nimbus ask "what does X mean?"` is run, how do synonyms behave?
- **Question:** If `"CDR"` is consolidated, and `"Change Data Record"` is a synonym, does searching for `"Change Data Record"` direct the user to the definition of `"CDR"`?
- **Recommendation:** Ensure synonym mapping is bidirectional or indexed in FTS such that querying any of the synonyms returns the consolidated term's definition.

### Q4.2: Manual Override / Force Add
Since the glossary is entirely derived from mining:
- **Question:** Should we support a way for users to manually define a glossary term or correct an LLM definition (e.g. via a future write route or config file)? Even if out of scope for this slice, the design should note where this extension seam would live (e.g. custom mappings in `nimbus.toml`).
