# Review: Negation Queries (W6-B.1) Design Spec

Below is a detailed review of the proposed negation queries design in [2026-08-20-negation-queries-design.md](./2026-08-20-negation-queries-design.md), including concrete proposals for the open questions and specific suggestions for technical alignment.

---

## 1. Responses to Open Questions

### Q1: Exit Code & Error-Path Helper for "Cannot Answer" Refusal

To align with the CLI's existing paradigms, we propose the following refusal execution contract:

* **Exit Code:** Use **Exit Code `1`** (general CLI error) when the query refuses due to a missing substrate, but ensure the structured output is cleanly separated.
* **Error-Path Helper:**
  * For **TTY/Human output**, write the remediation message directly to `process.stderr` using the output format from `packages/gateway/src/agents/_lib/gap-notes.ts:58` and then exit.
  * For **`--json` output**, print the structured refusal document to `process.stdout` (enabling scripting pipelines to parse it) and exit with code `1`.
  * **Structured Refusal Schema**:

    ```json
    {
      "status": "refused",
      "reason": "missing_substrate",
      "message": "No index data found for deployment correlation. Run a sync first.",
      "remediation": "nimbus sync <service>"
    }
    ```

### Q2: Subcommand Parsing & Scoping for `nimbus people`

The spec shows `nimbus people --not-reviewed --since 7d`. In the current tree:

* `packages/cli/src/commands/people.ts:151` expects a subcommand like `list`, `search`, `get`, `items`, or `link`.
* Passing `--not-reviewed` as the first argument would trigger an `"Unknown people subcommand"` error.

**Proposal:**

1. Support `--not-reviewed` and `--since` directly on the `list` subcommand:

   ```bash
   nimbus people list --not-reviewed --since 7d
   ```

2. For convenience, if the first argument starts with `--` (indicating a flag instead of a subcommand), default the routing inside `runPeople` to `list`. This preserves the cleaner `nimbus people --not-reviewed --since 7d` syntax without breaking subcommand dispatch.
3. Update the `people.list` IPC endpoint (`rpcPeopleList` in `packages/gateway/src/ipc/people-rpc.ts:83`) to accept:

   ```typescript
   type PeopleListParams = {
     unlinkedOnly?: boolean;
     limit?: number;
     notReviewed?: boolean;
     sinceMs?: number;
   };
   ```

---

## 2. Technical Alignment & Improvements

### A. Sharing parsing helpers for `--since`

* **Observation:** `nimbus people` does not currently parse `--since` or durations. `nimbus query` uses `parseSinceDurationToMs` from `../lib/parse-since.ts` to convert strings like `7d` to milliseconds.
* **Suggestion:** Export/reuse this utility in `packages/cli/src/commands/people.ts` to resolve `--since <window>` to an epoch offset before calling the IPC handler.

### B. IPC Payload Structure for `--explain`

* **Observation:** The spec states `--explain` adds the SQL, bound parameters, and substrate probes.
* **Proposal:** Extend the standard payload envelope in `index.queryItems` and `people.list` when `explain: true` is passed:

  ```typescript
  type ExplainResult = {
    sql: string;
    params: unknown[];
    substrate: {
      probeSql: string;
      passed: boolean;
      rowCount: number;
    };
  };
  ```

* Under `--json`, include this as an `explain` property at the root of the returned JSON array/object structure so that it is programmatically accessible.

### C. Validation on conflicting/missing type flags

* `--not-touching` requires `--type pr`. If `--not-touching` is passed with `--type commit` (or without `--type`), the CLI should fail fast with a clear error:
  `Error: --not-touching requires --type pr`
* `--no-downstream-incident` requires `--type deployment`. Conflicting or missing type scoping must fail-closed immediately.
