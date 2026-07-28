# Implementation Plan Review: Credential Health

This document contains a review of the implementation plan [2026-07-28-credential-health.md](./2026-07-28-credential-health.md), listing open questions, potential edge cases, and suggested improvements for the tasks.

---

## 1. Open Questions & Edge Cases

### 1.1. Classification of `parse_error` Outcomes in Task 8

During a sync attempt, a fetch can return `parse_error` (meaning the HTTP request succeeded with 2xx but the body could not be parsed as JSON).

* **The Question**: Does a `parse_error` count as a healthy credential check?
* **Impact**: If the HTTP status was 200, the credentials succeeded in authenticating. If we do not record this as `ok`, we might degrade the credential to `unknown`.
* **Suggestion**: In Task 8, explicitly map `parse_error` to `{ kind: "ok" }` for the purpose of credential health, since any successful HTTP 2xx response implies valid credentials regardless of whether the JSON parser succeeded on the body.

### 1.2. Handling XML and SOAP Error Bodies in Task 3

In `extract-error-detail.ts`, the function `looksLikeHtml` is used to strip markup from error pages.

* **The Question**: What if a connector interacts with an enterprise system that returns XML/SOAP errors (e.g. some Jenkins plugins, or on-premise Active Directory/Exchange)?
* **Impact**: The XML tags might remain in the extracted error detail if it doesn't match `looksLikeHtml`, leading to messy string details containing XML tags.
* **Suggestion**: Extend `looksLikeHtml` to also detect XML (e.g. checking if it starts with `<?xml` or `<ns:`), or generalize it to a `looksLikeMarkup` check that strips tags for both HTML and XML.

---

## 2. Improvements & Code Suggestions

### 2.1. Task 1: Robust Suffix Matching for `suffixOf`

In `credential-keys.ts`, `suffixOf(key)` splits the key by dot:

```ts
function suffixOf(key: string): string {
  const dot = key.indexOf(".");
  return dot === -1 ? key : key.slice(dot + 1);
}
```

* **Suggestion**: For vault keys with multiple dots (if any exist, e.g., `service.sub.credential`), `indexOf(".")` only strips the first segment. If all vault keys follow a strict `<connector_id>.<key_name>` pattern (exactly one dot), this is fine. If there are keys with multiple dots, `key.slice(key.lastIndexOf(".") + 1)` would be safer to get only the final suffix.

### 2.2. Task 11: Cursor Safety in Concurrent Probes

In `checkAllCredentials`, the concurrent worker is:

```ts
  const worker = async (): Promise<void> => {
    while (cursor < queue.length) {
      const connectorId = queue[cursor++];
      ...
```

* **Issue**: Since JavaScript is single-threaded, the synchronous increment `cursor++` is safe from race conditions, but if `cursor` is shared, we must ensure `cursor++` occurs atomically before any `await` statement. The current code does:

  ```ts
  const connectorId = queue[cursor++];
  if (connectorId === undefined) return;
  const cls = await probeConnector(deps, connectorId);
  ```

  This is fully safe because the lookup and increment occur before the first `await`. However, adding a small comment clarifying this atomic property prevents future refactoring from introducing concurrency bugs.

### 2.3. Task 11: `checkAllCredentials` Concurrency Test

The plan suggests adding a test asserting no more than `MAX_CONCURRENT_PROBES` are in flight.

* **Suggestion**: Provide a code snippet or guidance for how this test can be written deterministically using a mock delay inside `callListTool` and tracking a counter. E.g.:

  ```ts
  let active = 0;
  let maxActive = 0;
  const callListTool = async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise(r => setTimeout(r, 10));
    active--;
    return { kind: "ok" as const };
  };
  ```
