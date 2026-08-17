# Design Review: Agent Brief Synthesis (W6-A0)

This document collects feedback, suggestions, and open questions on the [Agent Brief Synthesis Design](./2026-08-16-agent-brief-synthesis-design.md).

---

## 1. Open Questions

### Q1: Phrase Guard Resilience (Formatting & Punctuation)

The honesty guard relies on `requiredPhrases(brief)` matching contractual strings (e.g., `_could not be computed_`).

* **Question:** How strict is the phrase check? If a local LLM re-formats the phrase (e.g., changing `_could not be computed_` to `*could not be computed*`, or stripping the underscores), does it trigger a false fallback to the deterministic brief?
* **Recommendation:** Normalize both the required phrases and the LLM output before checking (e.g., stripping markdown formatting characters `_`, `*`, `` ` ``, and normalizing extra whitespace) or use simple case-insensitive substring checks on normalized text.

### Q2: Timeout Durations & Config

Section 2.6 mentions that synthesis is timeout-bounded to respect the latency budget.

* **Question:** What is the proposed default timeout duration for the synthesis? Will this timeout value be configurable in `nimbus.toml` (e.g., under `[agents] synthesis_timeout_ms`), or hardcoded to a value like 3000ms?
* **Recommendation:** Keep a reasonable built-in default (e.g., 3-5 seconds depending on whether local/remote is used), but make it optionally configurable to prevent slow local LLM startup/first-token latency from permanently blocking synthesis on lower-end hardware.

### Q3: Resolution Timing and Model Configuration Changes

Under `"local"`, non-local resolution is refused.

* **Question:** Is the provider resolved only once at client startup, or is it evaluated dynamically per brief request?
* **Recommendation:** Resolve per invocation. In local-first setups, Ollama might start up or shut down, or the user might toggle `prefer_local` or update their model setup while the Gateway remains running.

---

## 2. Suggestions & Improvements

### 1. Synthesis Rejection Observability

Section 5 highlights the risk of deterministic fallback masking broken synthesis.

* **Proposal:** Expose a debug metric or log warning when synthesis fails the honesty check or times out. For example, log a verbose trace message like:

  ```ts
  logger.warn(`Synthesis rejected: LLM output did not contain required contract phrases: ${missingPhrases.join(", ")}`);
  ```

  This makes it easy for developers and power users to diagnose why their briefs are silently defaulting to deterministic renders.

### 2. Compile-Time Exhaustiveness for `requiredPhrases`

Ensure that the `requiredPhrases` function uses TypeScript's `assertNever` check against the union of all brief kinds:

```ts
function requiredPhrases(brief: SynthInput): string[] {
  switch (brief.kind) {
    case "negotiate":
      return ["could not be computed", ...];
    // ... all other cases ...
    default:
      return assertNever(brief);
  }
}
```

This guarantees that adding a new brief kind fails compilation immediately if `requiredPhrases` is not updated.
