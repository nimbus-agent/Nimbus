# Review & Feedback: Wave 7a Implementation Plan (read-only connectors + lineage)

**Review Date:** 2026-06-13  
**Reviewer:** AI Coding Assistant (Antigravity)  
**Target Plan:** [2026-06-13-phase6-slice7-wave7a-data-warehouse-bi.md](2026-06-13-phase6-slice7-wave7a-data-warehouse-bi.md)

---

## 1. Executive Summary & Review Focus

This review analyzes the Wave 7a implementation plan for the Data Warehouse & BI connectors, identifying technical inconsistencies between the design spec and the plan, potential run-time errors in the planned Snowflake endpoints, and improvements to the key normalization parser.

---

## 2. Inconsistencies & Critical Feedback

### Q2.1: Discrepancy in Lineage Relation Naming (`feeds` vs. `upstream_refs`)

* **The Issue:**
  * The design spec (§4) specifies the relationship name as **`feeds`** (`data_model` → `dashboard`).
  * The implementation plan (Task 2 & Task 5) uses **`upstream_refs`** for the same relationship.
* **Impact:** This mismatch can lead to integration errors or confusion during query-time BFS traversal in `relationship-graph.ts`.
* **Recommendation:** Standardize on one relation name across both documents. If `upstream_refs` is preferred to align with `agents/impact.ts` (as noted in Task 2), update the design spec to match.

### Q2.2: Invalid Snowflake API Endpoint URL

* **The Issue:** Task 8 step 3 specifies querying:
  `https://${creds.account}.snowflakecomputing.com/api/v2/information-schema/tables`
* **The Reality:** Snowflake does not expose a native `/api/v2/information-schema/tables` endpoint. To fetch metadata via Snowflake's REST/SQL API, one must send a `POST` request to the statement execution endpoint:
  `/api/v2/statements`
  with a payload containing the SQL query (e.g., `SELECT * FROM information_schema.tables`).
* **Recommendation:** Correct the sync handler specification in Task 8 to perform a POST request to `/api/v2/statements` with the SQL statement query.

---

## 3. Technical Improvements & Edge Cases

### S3.1: Parsing Quoted Dots in `normalizeDataModelKey()`

* **The Issue:** In Task 3, `normalizeDataModelKey` splits the input string blindly on the `.` character.
* **The Risk:** If a schema or table identifier contains a literal dot and is quoted (e.g., `ANALYTICS.PUBLIC."Sales.2026"`), the blind split will slice `"Sales` and `2026"` into separate parts, resulting in a corrupted normalized key:
  `analytics.public.sales.2026` instead of `analytics.public.sales.2026` representing a 3-part identifier.
* **Recommendation:** While simple split handles most cases, we should note in the codebase comment that literal dots inside quoted identifiers are not supported, or implement a regex-based identifier tokenizer that ignores dots inside quotes.

### S3.2: Task 16 `toRow` Adaptor Signature

* **The Issue:** Task 16 references `toRow(...)` as a local helper to convert a mapped row into an `upsertIndexedItem` input.
* **Recommendation:** Explicitly outline the helper structure in the test file so implementers do not get stuck, e.g.:

  ```typescript
  function toRow(mapped: any) {
    return {
      id: mapped.externalId,
      service: mapped.service,
      type: mapped.type,
      title: mapped.title,
      bodyPreview: mapped.bodyPreview,
      url: mapped.url,
      canonicalUrl: mapped.canonicalUrl,
      modifiedAt: mapped.modifiedAt,
      metadata: mapped.metadata,
    };
  }
  ```

---

## 4. Consolidated findings & dispositions (Claude — verified against the worktree)

I verified every claim against the real code (`connector-sync-test-helpers.ts`, `item-store.ts`,
`_lib/fetch-outcome.ts`, `connector-vault.ts`). The production-code tasks (Part A graph handlers,
V40 FK-seed, `normalizeDataModelKey`, mappers, sync handlers, registration) are correct against
real signatures; the defects are concentrated in the **test scaffolding** + two spec/endpoint nits.

| # | Finding | Disposition |
|---|---------|-------------|
| **Q2.1** | `feeds` vs `upstream_refs` mismatch | **FIX** — not a spec↔plan mismatch; the plan + spec §4 already use `upstream_refs`. The residual is spec-**internal**: §7 line 204 still said `feeds`. Fixed spec §7 → `upstream_refs`. |
| **Q2.2** | Snowflake `GET /api/v2/information-schema/tables` is not a real endpoint | **FIX** — correct. Task 8 rewritten to `POST /api/v2/statements` with a SQL body, plus a `rowsFromStatementsResponse()` step that zips `resultSetMetaData.rowType` names with `data` row-arrays into the named objects the mapper consumes. |
| **S3.1** | `normalizeDataModelKey` blind `.` split breaks a quoted literal dot (`"Sales.2026"`) | **FIX (comment) + DEFER (tokenizer)** — documented the limitation in the function comment; a quote-aware tokenizer is YAGNI (warehouse identifiers with literal dots are vanishingly rare). |
| **S3.2** | Spell out the `toRow` helper | **SUPERSEDED by R2** — `toRow` is unnecessary entirely. |
| **R1** | Tasks 8 & 16 use a **non-existent** test fixture (`createConnectorSyncFixture`/`fetchFake.enqueueJson`/`fx.*`) | **FIX** — rewrote Task 8 (the exemplar all 5 Part-C connectors copy) to the real helpers: `createMemoryIndexDb`, `createStubVault`, `syncTestContext`, `describeWithFetchRestore` + a `globalThis.fetch` stub, `expectServiceItemCount`. |
| **R2** | Task 16 `toRow` adapter is unnecessary and wrong-shaped | **FIX** — `upsertIndexedItem(db, row)` is exported and takes the `MappedRow` shape directly, and already calls `syncGraphFromIndexedItem` (auto-populates the graph). Task 16 now calls `upsertIndexedItem(db, mapped!)`. |
| **R3** | Secret keys are statically required to be `"<serviceId>.<suffix>"` (`ConnectorSecretKeyOf`) | **FIX (note)** — added to Task 9 so an implementer doesn't write bare keys (`tsc` would reject them). |
| **R4** | Service-id hyphen split (`monte-carlo` vs `montecarlo`) breaks the typed coupling | **FIX (note)** — Task 14 pins `montecarlo` as the canonical typed service id; the package dir / `com.nimbus.monte-carlo` may keep the hyphen. |
| **R5** | Does fetch-faking flow through `connectorFetch`? | **CONFIRMED** — `connectorFetch` defaults `fetchFn` to `globalThis.fetch` (`fetch-outcome.ts:16`); the global stub is the correct (and only) seam. No change. |

**Net:** no production-code task changed shape; the exemplar test now compiles against real
helpers, the Snowflake endpoint is real, and one stale spec word is corrected. Cleared to execute.
