# Review & Feedback: PR Changed-File Indexing Implementation Plan

This document reviews [2026-08-19-pr-changed-file-indexing.md](./2026-08-19-pr-changed-file-indexing.md) and compiles open questions, suggestions, and potential improvements for the implementation steps.

---

## 1. Missing Sync Loop Integration Task

* **Context:** The implementation plan defines the schemas (Task 1), the store module (Task 2), the forge mappers (Tasks 3–4), and the candidate selector / cap helpers (Task 5). However, it does **not** specify a task for the actual integration into the scheduled sync ticks for each connector.
* **Gaps identified:**
  * No code modifications are scheduled for the sync managers or connectors (e.g., `packages/gateway/src/connectors/github-sync.ts`, `packages/gateway/src/connectors/gitlab-sync.ts`, or `packages/gateway/src/connectors/bitbucket-sync.ts`).
  * The actual HTTP network requests to fetch the files/diffstat from GitHub/GitLab/Bitbucket APIs are not defined in any task.
  * The loop that iterates over candidates, fetches pages, maps them, applies the caps, and writes them using `recordPrChangedFiles` is missing.
* **Recommendation:** Add a task (e.g., `Task 5.5: Sync Integration and Network Fetching`) detailing the changes to the sync connectors, detailing the API paths, pagination loops, rate-limiting, and error handling.

---

## 2. Bitbucket Pagination & Diffstat Envelope

* **Context:** In Task 4, Bitbucket's mapper is defined as:
  ```ts
  export function mapBitbucketPrFiles(payload: unknown): ChangedFileRow[]
  ```
  And Bitbucket's diffstat API is paginated with a `next` URL.
* **Question:** How is pagination handled for Bitbucket? 
  * If the network fetch loop in the connector retrieves pages sequentially, does it concatenate the `values` arrays first and pass the full payload to `mapBitbucketPrFiles`? Or does it map each page individually and concatenate the resulting `ChangedFileRow` arrays?
  * *Suggestion:* Clarify the sequence. Mapping page-by-page and then concatenating the mapped arrays is generally safer to avoid building very large temporary JSON structures.

---

## 3. Transaction Boundary in candidate loop

* **Context:** Task 2 states:
  > recordPrChangedFiles writes a PR's file set and its coverage row in one transaction
* **Recommendation:** Ensure that the loop fetching candidates executes each candidate's network fetch and DB write independently. If one candidate fails (e.g., HTTP 500 or rate limit exceeded), it should not roll back the successful syncs of other candidates in the same tick. The store's transaction should only wrap the writes for a single PR, as defined in `recordPrChangedFiles`.
