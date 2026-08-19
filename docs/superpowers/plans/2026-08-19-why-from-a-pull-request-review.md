# Review: why-from-a-pull-request Plan

A detailed review of the proposed plan: [2026-08-19-why-from-a-pull-request.md](2026-08-19-why-from-a-pull-request.md).

---

## 1. Suggestions & Technical Improvements

### A. Use `URL.canParse` for cleaner URL validation in the CLI

In **Task 5 (Step 5)**, the plan suggests:

```ts
function whyParamsFor(ref: string, line: number | undefined): Record<string, unknown> {
  let parsed: URL | null = null;
  try {
    parsed = new URL(ref);
  } catch {
    parsed = null;
  }
  if (parsed !== null && (parsed.protocol === "http:" || parsed.protocol === "https:")) {
    return { prUrl: ref };
  }
  return line === undefined ? { ref } : { ref, line };
}
```

**Suggestion:** Since Nimbus runs on Bun (v1.2+), we can leverage standard `URL.canParse()` to simplify this check, or keep standard parsing if we need access to the parsed protocol. Since we need to check the protocol (`http:` / `https:`), `new URL()` is appropriate, but we can write it a bit more concisely:

```ts
function whyParamsFor(ref: string, line: number | undefined): Record<string, unknown> {
  try {
    const parsed = new URL(ref);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return { prUrl: ref };
    }
  } catch {}
  return line === undefined ? { ref } : { ref, line };
}
```

This avoids initializing the `parsed` mutable variable to `null` first.

### B. Double check case-sensitivity of the SQLite Join

In **Task 1 (Step 4)**, the resolver joins `item` and `graph_entity`:

```sql
SELECT e.id                                  AS entity_id,
       e.label                               AS label,
       json_extract(e.metadata, '$.repo')    AS entity_repo,
       json_extract(i.metadata, '$.repo')    AS item_repo,
       CAST(json_extract(i.metadata, '$.number') AS INTEGER) AS number
  FROM graph_entity e
  JOIN item i ON i.id = e.external_id
 WHERE e.type = 'pr' AND e.external_id = ?
 LIMIT 1
```

* **Verify:** Since `item.id` and `graph_entity.external_id` are derived from the same indexing logic (i.e. `syncPrGraph` inserts `externalId: row.id`), the casing matches exactly. This is correct and safe.

---

## 2. Compatibility & Alignment Verification

* **SDK Version bump:** `@nimbus-dev/sdk` bump to `^1.18.0` is verified as the source of truth for `WhyChangeSubject`.
* **PrForSha mapping:** The mapping in Task 4 Step 4 matches the five expected fields of `PrForSha` (`entityId`, `number`, `title`, `url`, `modifiedAt`) exactly.
* **TUTORIAL-CONSTRAINTS:** No `any` is introduced; only strict TypeScript constructs and explicit type assertions/guards are used.
* **HTTP / whyPeek status:** The plan correctly honors the constraint that `whyPeek` is line-level and does not accept `prUrl`.

---

## 3. Open Questions / Edge Cases

### A. Multiple matching `graph_entity` entries

Is there any scenario where an `item` has multiple corresponding `graph_entity` entries of type `pr`? Under normal operation, the external ID maps 1-to-1. The query uses `LIMIT 1` which is safe, but it might be worth verifying if database consistency tests enforce the uniqueness of `(type, external_id)` in `graph_entity`.

### B. Fallback in `renderWhySubjectLine` when `cs.number` is missing but parsed as `0`

In **Task 5 (Step 3)**:

```ts
const num = cs.number === null ? "" : `#${String(cs.number)}`;
```

If a PR number happens to be parsed as `0` (unlikely for PRs, but possible in edge cases/mock data), this will render `#0`. This is correct.
