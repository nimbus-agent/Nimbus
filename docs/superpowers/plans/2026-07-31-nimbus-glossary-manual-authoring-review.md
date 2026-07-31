# Review & Suggestions: Nimbus Glossary — Manual Term Authoring Implementation Plan

This document contains a structured review, suggestions, improvements, and open questions regarding the implementation plan specified in [2026-07-31-nimbus-glossary-manual-authoring.md](./2026-07-31-nimbus-glossary-manual-authoring.md).

---

## 1. Batch Transaction for `applyManualTerms` (Task 5)

### The Issue

In Task 5, the plan implements the manual pre-pass by running a database transaction per term upsert and another transaction per demoted term:

- An `db.transaction()` wrapper for *each* `term` in `cfg.terms` (during upsert/projection).
- A separate `db.transaction()` wrapper for *each* removed term in `listManualKeys(db)`.

If a user configures dozens of manual terms and has some removed, this results in running dozens of individual SQLite transactions. In SQLite, executing multiple independent transaction commits is a known performance bottleneck due to disk/write synchronization overhead.

### Suggestion

Wrap the entire `applyManualTerms` body (or the loops collectively) in a single database transaction. This reduces overhead to a single commit operation, boosting performance and ensuring that the entire set of manual terms is applied atomically (either all changes succeed, or none do).

```typescript
export function applyManualTerms(
  db: Database,
  cfg: GlossaryManualConfig,
  opts: { nowMs: number },
): ManualPassSummary {
  if (!cfg.loaded) {
    return { added: 0, removed: 0, skipped: [] };
  }

  // ... (setup / preparation logic) ...

  let added = 0;
  let removed = 0;

  db.transaction(() => {
    // Upsert configured terms
    for (const term of cfg.terms) {
      upsertManualTerm(db, { ... });
      const stored = getTerm(db, term.termKey);
      if (stored !== null) projectTerm(db, stored, opts.nowMs);
      added += 1;
    }

    // Demote removed terms
    const configured = new Set(cfg.terms.map((t) => t.termKey));
    for (const key of listManualKeys(db)) {
      if (configured.has(key)) continue;
      unprojectTerm(db, key);
      demoteTerm(db, key, opts.nowMs);
      removed += 1;
    }
  })();

  return { added, removed, skipped: cfg.skipped };
}
```

---

## 2. Duplicate Synonym/Alias Detection (Task 4)

### The Issue

In `buildSynonyms` (Task 4), the parser loops over raw synonym entries and populates the output map:

```typescript
const out = new Map<string, string>();
for (const { key, value } of raw) {
  // ... validation ...
  out.set(alias, target);
}
```

If a user accidentally defines the same alias twice in `[glossary.synonyms]`, the latter definition will silently overwrite the former without reporting any warnings or errors.

### Suggestion

Add a duplicate check for alias keys and push a descriptive entry to `skipped` so the user is informed of the collision under `--refresh`:

```typescript
if (out.has(alias)) {
  skipped.push({ entry: key, reason: `duplicate alias definition for "${key}"` });
  continue;
}
```

---

## 3. Alternative/Valid TOML Syntax Layouts (Task 4)

### The Issue

`collectBlocks` uses a simple header-based parser that expects exact section headers (`[glossary.terms]` and `[glossary.synonyms]`). If a user organizes their TOML file using nested/alternative paths like:

```toml
[glossary]
terms.CDR = "..."
```

or

```toml
[glossary.terms]
CDR = "..."
```

The line-based scanner will fail to collect these keys because `target` will remain `null`.

### Suggestion

Since Nimbus relies on a custom line-by-line parser to avoid dependencies and keep the gateway lightweight, full TOML compliance is not expected. However, we should explicitly document this structural limitation in `docs/cli-reference.md` and inline comments within `nimbus-toml-glossary-terms.ts`, confirming that manual terms *must* reside under the flat table headers `[glossary.terms]` and `[glossary.synonyms]` respectively, without dot-nested prefixes.
