# Design/Implementation Plan Review: Agent Personas (A2)

This document collects feedback, suggestions, and open questions on the [Agent Personas (A2) Implementation Plan](./2026-08-18-agent-personas-a2.md).

---

## 1. Open Questions & Potential Issues

### Q1: Test Pollution from `warnedIssues` State in `resolvePersona`

In Task 1 (Step 7), `persona.ts` introduces module-scoped state for tracking warned issues:

```ts
const warnedIssues = new Set<string>();

export function resetPersonaWarningsForTest(): void {
  warnedIssues.clear();
}
```

However, the proposed tests in `persona.test.ts` (Step 5) do not call `resetPersonaWarningsForTest()` before or after the test runs:

```ts
  test("warns once per distinct bad value, naming key, value and fallback", () => {
    // ...
    resolvePersona(dir, logger);
    resolvePersona(dir, logger);
    expect(warnings.length).toBe(1);
  });
```

* **Question:** If other tests (now or in the future) check warning logs, or if this test is run repeatedly/concurrently in some environments, will the lack of setup/teardown reset cause false passes or failures?
* **Recommendation:** Add a `beforeEach` hook in `persona.test.ts` to clear the warnings:

  ```ts
  import { resolvePersona, resetPersonaWarningsForTest } from "./persona.ts";

  beforeEach(() => {
    resetPersonaWarningsForTest();
  });
  ```

---

## 2. Suggestions & Improvements

### 1. Robustness of the `D6` Omission Regex (`OMISSION_PATTERN`)

In Task 2, `OMISSION_PATTERN` is defined as:

```ts
const OMISSION_PATTERN =
  /\b(omit|leave out|leave off|drop|skip|exclude|truncate|at most \d|no more than \d|limit (your|the) (answer|response|output|list) to \d|only (list|include|mention) \d)\b/i;
```

While this catches many common omission verbs/phrases, there are other synonyms or phrasing styles that might instruct a model to drop information (violating the spirit of D6).

* **Proposal:** Expand `OMISSION_PATTERN` to include additional common negative constraints such as:
  * `avoid` (e.g., "avoid listing non-critical gaps")
  * `without` (e.g., "without mentioning evidence rows")
  * `do not (include|show|list)` (e.g., "do not show details")
  * `ignore` (e.g., "ignore missing items")
  * `remove` / `cut` (e.g., "remove details")
* **Updated Regex Proposal:**

  ```ts
  const OMISSION_PATTERN =
    /\b(omit|leave out|leave off|drop|skip|exclude|truncate|avoid|ignore|remove|cut|without|do not (include|show|list)|at most \d|no more than \d|limit (your|the) (answer|response|output|list) to \d|only (list|include|mention) \d)\b/i;
  ```

### 2. Centralizing Provenance Field Attachment in `synthesize`

In Task 4, Step 4, the plan requires adding `persona: opts.runner?.persona` to all `attempted: true` provenance objects constructed throughout `synthesize()`.

* **Proposal:** Since there are multiple exit paths (error catch, timeout, contract violation, success), manually adding the field to every single literal instantiation of the provenance object might lead to developer omissions. If possible, post-process the constructed provenance object right before it is returned, or wrap the creation:

  ```ts
  const provenance: SynthesisProvenance = { ... };
  if (provenance.attempted) {
    provenance.persona = opts.runner?.persona;
  }
  return { markdown, provenance };
  ```

  This guarantees that all current and future `attempted: true` provenance objects automatically receive the persona information, reducing code duplication and human error.
