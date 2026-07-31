# Review & Feedback: `nimbus glossary` Manual Term Authoring Design

This document contains a structured review, suggestions, improvements, and open questions regarding the design of the manual term authoring surface specified in [2026-07-31-nimbus-glossary-manual-authoring-design.md](./2026-07-31-nimbus-glossary-manual-authoring-design.md).

---

## 1. TOML Parser Repair & Robustness (§3)

### Q1.1: Quote-Aware `#` Parsing Logic

The design notes that `stripComment` will be repaired so that it does not truncate at `#` characters nested inside double-quoted strings.

- **The Issue:** Since `nimbus.toml` uses a hand-rolled line parser rather than a full lexer, repairing this correctly requires tracking quote boundaries. For instance, we must handle:
  - Escaped quotes within quotes (e.g., `\"` or `\\"`).
  - Unbalanced quotes on malformed lines.
  - Multi-char sequences or trailing spaces.
- **Recommendation:** Document the exact matching strategy/regex to be used in the parser fix. A standard approach in line-by-line parsing is to iterate through characters or use a regex that matches either a double-quoted string (including escapes) or a comment character. For example:

  ```ts
  // Match either a double-quoted string literal (ignoring its contents) OR a comment
  const commentRegex = /"([^"\\]|\\.)*"|(#.*)/g;
  ```

  Using such a regex ensures that comments are stripped only if they start outside string boundaries.

### Q1.2: Support for Escape Characters (e.g., `\n` or `\t`)

- **Question:** Under the single-line definition limitation (§4.2), can definitions contain escaped characters like `\n` to represent newlines?
- **Recommendation:** Clarify if `parseString` should unescape `\n` to an actual newline character (`\n`) and `\t` to a tab (`\t`). If not supported, any manually authored definition will be strictly single-line visually, which might limit readability when rendered in terminal/UI descriptions.

---

## 2. Config Updates & Display Term Clobbering (§4.1, §6.2)

### Q2.1: Updating Display Casing/Form from Config

The design correctly prevents mined sightings from clobbering manual display terms in §6.2 by using:

```sql
display_term = CASE WHEN definition_source = 'manual'
                    THEN display_term ELSE excluded.display_term END
```

- **Question:** How does `applyManualTerms` (the pre-pass) handle a casing change initiated by the user in `nimbus.toml`? For example, if a term is changed from `[glossary.terms] CDR = "..."` to `[glossary.terms] Cdr = "..."`, both normalize to the same `termKey` (`cdr`).
- **Recommendation:** Ensure that the pre-pass `applyManualTerms` uses an upsert query that *does* overwrite `display_term` when the conflict arises from the manual pass itself (since the user explicitly changed the casing in the config).
  For example, the manual pre-pass upsert statement should unconditionally set:

  ```sql
  display_term = excluded.display_term
  ```

  This distinction (pre-pass updates display term, mining pass preserves manual display term) must be clearly split between the two SQL queries.

---

## 3. Synonym Shadowing & Diagnostics (§4.1)

### Q3.1: Visibility of Shadowed Synonyms

Section 4.1 mentions that if a manually configured alias/synonym normalizes to the key of an existing mined term, the exact match wins, making the alias unreachable.

- **The Issue:** The user has no easy way to know that their alias is non-functional without looking at the background log/skipped count.
- **Recommendation:**
  1. When running `nimbus glossary --refresh`, print the skipped count and a list of warnings for any skipped/shadowed synonyms directly to `stdout`.
  2. In `nimbus glossary list` or `status`, list active warnings or shadowed config terms to help the user diagnose why an alias isn't working.

---

## 4. Tombstone Accumulation & Cleanup (§5)

### Q4.1: Database Bloat from Deleted Manual-Only Terms

When a manual-only term (with `doc_freq = 0` and no mined evidence) is removed from `nimbus.toml`, it is demoted to `pending` with `definition_source = NULL`.

- **Question:** Because `doc_freq` is `0`, these rows will never clear the `selectPendingBatch` threshold and will sit in the database indefinitely as tombstones. While the database is small, is there a point where we should hard-delete orphaned terms?
- **Recommendation:** During a `--rebuild` or a database optimization pass, purge any terms where `status = 'pending'`, `doc_freq = 0`, and `definition_source IS NULL`. This ensures the database doesn't gather dead rows over long periods of config editing.
