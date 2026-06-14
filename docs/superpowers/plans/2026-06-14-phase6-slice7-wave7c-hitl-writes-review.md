# Review & Feedback: Phase 6 Slice 7 — Wave 7c HITL-Gated Warehouse/BI Writes Implementation Plan

**Review Date:** 2026-06-14  
**Plan Document Reviewed:** [2026-06-14-phase6-slice7-wave7c-hitl-writes.md](./2026-06-14-phase6-slice7-wave7c-hitl-writes.md)  
**Status:** Plan Feedback / Suggestions / Improvements

---

## 1. Snowflake Identifier Validation Limitations (Task 10)

### Context

In **Task 10 (Snowflake)**, the SQL identifier validator is specified as:

```typescript
// identifier: dotted, each part [A-Za-z_][A-Za-z0-9_$]* or "quoted"
const SF_IDENT = /^[A-Za-z_][A-Za-z0-9_$]*(\.[A-Za-z_][A-Za-z0-9_$]*)*$/;
```

### Problem / Improvement

- While the regex handles standard Snowflake identifiers, it fails to support **quoted identifiers** (e.g. `"My-Table"`, `"schema"."lowercase_table"`), which are very common in Snowflake database setups to support lowercase characters, spaces, dashes, or other special characters.
- Under the current `SF_IDENT` regex, any table name or tag containing double quotes or lowercase characters/special chars will throw an unsafe identifier error, blocking write actions for those assets.
- **Suggestion:** Refine the validator to handle double-quoted parts. For example:

  ```typescript
  const SF_IDENT_PART = /^(?:[A-Za-z_][A-Za-z0-9_$]*|"[^"]+")$/;
  function assertSfIdentifier(name: string, label: string): string {
    const parts = name.split(".");
    for (const part of parts) {
      if (!SF_IDENT_PART.test(part)) {
        throw new Error(`unsafe Snowflake identifier component for ${label}: ${part} in ${name}`);
      }
    }
    return name;
  }
  ```

---

## 2. Power BI `groupId` Optionality for My Workspace (Task 13)

### Context

In **Task 13 (Power BI)**, the plan specifies:
> schemas `z.object({ groupId: z.string().min(1), datasetId: z.string().min(1) })` and `z.object({ groupId: z.string().min(1), dataflowId: z.string().min(1) })`

### Problem / Improvement

- Power BI datasets and dataflows can be created/hosted in "My Workspace", which does not have a `groupId` (or is mapped as null/absent).
- Requiring `groupId: z.string().min(1)` means that refreshing any datasets or dataflows residing in a user's personal "My Workspace" will fail validation.
- **Suggestion:** Make `groupId` optional in the Zod schemas:

  ```typescript
  z.object({ groupId: z.string().optional(), datasetId: z.string().min(1) })
  ```

  And construct the API target URL dynamically based on its presence:

  ```typescript
  const url = p.groupId
    ? `${base}/v1.0/myorg/groups/${encodeURIComponent(p.groupId)}/datasets/${encodeURIComponent(p.datasetId)}/refreshes`
    : `${base}/v1.0/myorg/datasets/${encodeURIComponent(p.datasetId)}/refreshes`;
  ```

---

## 3. Bigeye Authorization Header Consistency (Task 15)

### Context

In **Task 15 (Bigeye)**, the API description says:
> header `Authorization: apikey <key>` or workspace token

### Suggestion

- The existing implementation of read tools in `packages/mcp-connectors/bigeye/src/server.ts` uses `Authorization: Bearer ${k}` in the `authHeader()` helper.
- **Recommendation:** Explicitly instruct the implementation step to reuse the existing `authHeader()` helper from `server.ts` to keep the authentication mechanism consistent and avoid runtime unauthorized errors.
