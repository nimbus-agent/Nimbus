# LLM Model Routes — Slice 2: Bearer-Key Clouds — Design Review

**Date:** 2026-08-28
**Reviewer:** Antigravity (AI Coding Assistant)
**Status:** Under Review
**Target Spec:** [2026-08-28-llm-model-routes-slice-2-design.md](./2026-08-28-llm-model-routes-slice-2-design.md)

---

## 1. Summary of Review

The design for **Slice 2: Bearer-Key Clouds** is exceptional. It correctly identifies the `provider.generate()` chokepoint as the correct abstraction layer for the egress ledger (correcting the Slice 1 assumption), closes a critical air-gap fallback bypass in `runTurn`, and establishes structural guards (such as **I34**) to ensure locality declarations cannot be forged or bypassed via local proxies (e.g., LiteLLM).

Below are specific suggestions, open questions, and improvements to consider during implementation.

---

## 2. Improvements & Suggestions

### 2.1 Mastra Integration & `LanguageModelV4` Custom Wrapper vs. `ModelRouterLanguageModel`

* **Observation:** In §6.3, the spec suggests using Mastra's `ModelRouterLanguageModel` and wrapping it with `wrapLedgeredMastraModel` to intercept `doGenerate` / `doStream`.
* **Risk:** As noted in §13, Mastra's internal registry may force particular behaviors or trigger offline-check network calls. Moreover, relying on internal types like `ModelRouterLanguageModel` might introduce fragility during Mastra upgrades.
* **Suggestion:** Since Mastra agents accept standard AI-SDK `LanguageModelV4` objects, we can construct our own clean adapter implementing `LanguageModelV4` directly. This adapter would wrap our own `LlmProvider` and implement the ledgering/air-gap logic, completely bypassing Mastra's custom model router. This keeps all LLM generation routing and ledgering unified under our code, rather than having two separate paths (one for LlmRouter, one for Mastra's router).

### 2.2 Egress Ledger Row Correlation (Synthesis vs. Model Egress)

* **Clarification:** With `recordSynthesisEgress` deleted (§5.4) and the wrapper handling all remote generates, a synthesized brief will now append a single `model` class row via `wrapLedgeredProvider`.
* **Verification:** Make sure that if an external client (HTTP / MCP) requests brief synthesis, the ledger records:
  1. The incoming request itself (class `mcp`/`http` based on the entry point / IPC dispatchers, if applicable).
  2. The outbound generation call (class `model` via the provider wrapper).
* **Fidelity:** Check that `egressMethod` correctly distinguishes between these. For example, if a brief is synthesized via a remote model, does the ledger record both the brief request (source metadata) and the raw LLM token egress? The design specifies this correctly, but the tests in §11 should explicitly verify that both rows are generated when triggered via external transports.

### 2.3 Strict Validation on TOML Parses

* **Observation:** §7.1 notes that a throw in `loadTomlSection`'s bare catch silently reverts the whole section.
* **Recommendation:** Ensure the custom post-parse validation in `platform/assemble.ts` runs on the parsed AST/JSON *before* applying defaults, so we can isolate and log vendor-specific issues without risking the reset of the `enforce_air_gap` flag.

---

## 3. Open Questions

1. **Custom/Third-Party OpenAI-Compatible Providers:**
   * If a user wants to configure a local provider that uses the OpenAI wire format (e.g., LM Studio, LocalAI, or llamafile on another port/host), how will they do so under this design?
   * Since `openai-provider.ts` and `xai-provider.ts` hardcode `isLocal = false` unconditionally, we ensure security by default. Will support for custom local OpenAI-compatible endpoints be deferred to Slice 4, or should we define a separate `openai-local` provider type?
2. **Handling Transient Network Issues in `isAvailable`:**
   * Since `isAvailable()` is answered offline (`enabled && key present`), if a remote provider is down or the user's internet is disconnected, the router will still select the route and try to call `generate()`.
   * This is correct to prevent background network leakage, but does the router's fallback logic handle the resulting network error gracefully by attempting the next prioritized route (if any), or does it fail immediately?
