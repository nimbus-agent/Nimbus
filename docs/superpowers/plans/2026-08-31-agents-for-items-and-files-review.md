# Implementation Plan Review: Agents for Items and Files

**Date:** 2026-08-31  
**Reviewer:** Antigravity (AI Coding Assistant)  
**Status:** Under Review  
**Target Plan:** [`2026-08-31-agents-for-items-and-files.md`](./2026-08-31-agents-for-items-and-files.md)  
**Design Spec:** [`../specs/2026-08-31-agents-for-items-and-files-design.md`](../specs/2026-08-31-agents-for-items-and-files-design.md)  

---

## 1. Summary of Review

The implementation plan is comprehensive, well-structured into 14 incremental tasks, and follows a strict test-driven development (TDD) cycle. It thoroughly addresses the core requirements:

1. **Clear PR Slicing:** PR 1 (`itemUrl` arms), PR 2 (`resolveFileByRemote` + forge-file arms + `impact` fix), and PR 3 (`connections` + `currency` + HTTP roster update).
2. **Reverse Graph Traversals:** Task 4 properly handles the inverse `resolves` and sibling issue traversals needed when `why` answers about an issue rather than a PR.
3. **Robust Slash-in-Branch Resolution:** Task 10 handles forge file coordinates where branch names contain slashes without requiring client-side guessing.

Below are critical type mismatches, missing entity lookups, and technical improvements to resolve before beginning execution.

---

## 2. Critical Findings & Type Corrections

### F2.1: `resolveItemArm` (Task 2) Missing Entity ID & Number Lookups

* **Issue:** In Task 2 Step 3 (lines 176–203), `resolveItemArm` constructs `itemSubject` by reading fields directly off `item`:

  ```ts
  itemId: item.id,
  entityId: item.entityId, // ERROR: Property 'entityId' does not exist on ResolveCandidate
  number: item.number ?? null, // ERROR: Property 'number' does not exist on ResolveCandidate
  url: item.url, // TYPE MISMATCH: item.url is string | null, but WhyItemSubject.url is string
  ```

* **Root Cause:** `resolveItemByUrl` returns `{ found: true, item: ResolveCandidate & { modified_at: number } }`, where `ResolveCandidate` is defined in `packages/gateway/src/index/resolve-by-url.ts:13` as:

  ```ts
  export type ResolveCandidate = {
    readonly id: string;
    readonly service: string;
    readonly type: string;
    readonly title: string;
    readonly url: string | null;
  };
  ```

  `item` does **not** have `entityId` or `number`.
* **Fix:** In `resolveItemArm`, resolve `entityId` from `graph_entity` and extract `number` (e.g. from `metadata` or `item.id`):

  ```ts
  function resolveItemArm(db: Database, itemUrl: string): WhyLaneResolution {
    const resolved = resolveItemByUrl(db, itemUrl);
    if (!resolved.found) {
      return {
        subject: null,
        blame: null,
        pr: null,
        itemSubject: null,
        queryRef: itemUrl,
        queryLine: null,
      };
    }
    const item = resolved.item;
    // Find the backing graph entity
    const entity = db
      .query("SELECT id FROM graph_entity WHERE external_id = ? LIMIT 1")
      .get(item.id) as { id: string } | null;
    
    // Extract number if stored in item metadata
    const metaRow = db
      .query("SELECT json_extract(metadata, '$.number') AS number FROM item WHERE id = ? LIMIT 1")
      .get(item.id) as { number: number | null } | null;

    return {
      subject: null,
      blame: null,
      pr: null,
      itemSubject: {
        itemId: item.id,
        entityId: entity?.id ?? item.id,
        number: metaRow?.number ?? null,
        url: item.url ?? itemUrl,
        title: item.title,
        modifiedAt: item.modified_at ?? null,
        service: item.service,
        type: item.type,
      },
      queryRef: itemUrl,
      queryLine: null,
    };
  }
  ```

---

### F2.2: `ExpertBrief` Property Mismatch in Task 6 Test

* **Issue:** In Task 6 Step 1 (lines 535–537), the test asserts:

  ```ts
  const names = brief.findings.map((f) => f.title).join(" "); // ERROR: 'findings' does not exist on ExpertBrief
  expect(names).toContain("Dana");
  ```

* **Root Cause:** Unlike `WhyBrief` (which has `findings: WhyFinding[]`), `ExpertBrief` has `ranked: ExpertFinding[]`. Furthermore, `ExpertFinding` has `displayName: string` and `personId: string`, but does not have a `title` field.
* **Fix:** Update Task 6 Step 1 to read from `brief.ranked`:

  ```ts
  const names = brief.ranked.map((f) => f.displayName).join(" ");
  expect(names).toContain("Dana");
  expect(names).not.toContain("Rae");
  ```

---

### F2.3: `runExpert` Output on `itemUrl` Arm (Task 6)

* **Issue:** In Task 6 Step 3, `peopleForItem` returns `PersonRow[]` with `{ entity_id, name, edge }`.
* **Requirement:** `ExpertBrief` requires `ranked: ExpertFinding[]`, where each finding carries:

  ```ts
  export type ExpertFinding = {
    personId: string;
    displayName: string;
    evidence: Evidence[];
    score: number;
    confidence: "high" | "medium" | "low";
  };
  ```

* **Fix:** Ensure `runExpert` on the `itemUrl` arm maps `PersonRow` into `ExpertEvidenceStream` and passes it through `rankExpertFindings` (or directly maps to `ExpertFinding[]` with evidence tagged with the edge name), so the brief passes `isExpertBrief` and conforms to `ExpertBriefBase`.

---

## 3. Improvements & Suggestions

### S3.1: Task 10 `resolveFileByRemote` Path Separator Handling

* **Context:** In Task 10 Step 3 (line 872), candidate path lookup uses `fileExternalId(root, candidatePath)`.
* **Suggestion:** On Windows, `repoRoot` contains backslashes (e.g. `C:\gitrep\web`), while `refAndPath` uses forward slashes (`src/foo.ts`). Ensure `resolveFileByRemote` normalizes paths with `toPosixPath` or matches `ownership-pass.ts`'s formatting convention so that `fileExternalId` matches indexed `source_file` rows regardless of OS.

### S3.2: Re-exporting `WhyItemSubject`

* **Context:** Task 1 Step 3 notes `export type { WhyItemSubject } from "@nimbus-dev/sdk"`.
* **Suggestion:** Ensure `@nimbus-dev/sdk` dependency in `packages/gateway/package.json` is updated to the newly released version containing `WhyItemSubject` before running PR 1 typechecks.

---

## 4. Summary of Recommended Plan Edits

1. Update Task 2 Step 3 to explicitly query `graph_entity.id` and `metadata.number`.
2. Correct Task 6 Step 1 test from `brief.findings.map(f => f.title)` to `brief.ranked.map(f => f.displayName)`.
3. Clarify `runExpert` mapping from `peopleForItem` to `ExpertFinding[]` in Task 6 Step 3.
