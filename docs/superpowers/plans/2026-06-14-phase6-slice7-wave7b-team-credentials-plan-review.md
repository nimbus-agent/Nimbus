# Review & Feedback: Phase 6 Slice 7 — Wave 7b Team-Shared Credentials Implementation Plan

**Review Date:** 2026-06-14  
**Plan Document Reviewed:** [2026-06-14-phase6-slice7-wave7b-team-credentials.md](./2026-06-14-phase6-slice7-wave7b-team-credentials.md)  
**Status:** Plan Feedback / Suggestions / Improvements

---

## 1. Power BI Redundant Full-Fetches during Client-Side Pagination (Task 13)

### Context

In **Task 13 (Power BI)**, the cursor contract specifies:
> fetch the full `value` array once; page client-side. `cursor` = offset string (absent → 0); slice `value.slice(offset, offset+limit)`; `nextCursor` = `String(offset+limit)` when `offset+limit < value.length`, else `null`.

### Problem / Improvement

- Since `listConnectorItems` runs iteratively page-by-page over a `ConnectorToolSession`, calling `powerbi_list(cursor, limit)` on subsequent pages will trigger the connector to repeatedly make HTTP requests fetching the **entire** reports array from Power BI, only to slice it. For $N$ pages, this results in $N$ redundant, slow cloud fetches.
- **Suggestion:** Since report lists are typically small (almost always $< 500$ entries), we should skip pagination entirely for the Power BI connector. Instead, the first execution of `powerbi_list` should return the entire set of reports with `nextCursor: null`. This avoids all redundant API requests, reduces latency, and simplifies the codebase.

---

## 2. Actionable Error Messages CLI Commands (Task 6 Step 6)

### Context

In **Task 6 Step 6**, the plan suggests adding:
> `return "team-credential sync for ${req.service} blocked: your identity is invalid/expired — re-run the device-code login."`

### Suggestion

- To make this fully actionable, we should explicitly recommend the correct Nimbus command in the error text itself.
- For example, update the identity error message to:
  `re-run the device-code login using: nimbus identity login`
- This aligns with the error message for missing vault entries which provides the exact CLI command: `nimbus team vault put ${req.entry} ${req.service} --secret <key>=<value>`.

---

## 3. LookML Models and Views Lineage under Team Credentials (Task 12)

### Context

In **Task 12 (Looker)**, the caution section states:
> If the model fetch also needs the team credential, route it through a second `looker_models_list` drained tool; otherwise leave it on the personal path for 7b and note the limitation in the design's known-limitations.

### Problem / Suggestion

- If the sync is configured to use team credentials (`credential = "team"`), it's highly likely that personal credentials for Looker either don't exist or don't have access. Leaving LookML model fetching on the personal path will result in sync failures or partial data (missing lineage) for team setups.
- **Recommendation:** Rather than deferring this, we should explicitly route the LookML models listing through a second team-credentialed tool (`looker_models_list`) or aggregate both under the single `looker_list` tool (e.g. returning a unified payload structure containing both dashboards and models). This keeps team-credential syncs fully functional out of the box.

---

## 4. Tableau Cursor Edge Case (Task 11)

### Context

In **Task 11 (Tableau)**, the cursor is defined as:
> `cursor` = page number as string (absent → page 1).

### Suggestion

- Ensure that the parser logic in `tableau_list` robustly handles `null`, `undefined`, empty string, and `0`.
- Some systems default page index to `0` or `1`. If a user/tool passes `0`, we should map it to the correct first page offset (typically `1` in Tableau's pagination model) to avoid out-of-bounds queries or repeating the first page. E.g., use `Number(p.cursor) || 1`.
