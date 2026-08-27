# LLM Model Routes — Design Review

**Date:** 2026-08-27  
**Reviewer:** Antigravity (AI Coding Assistant)  
**Status:** Under Review  
**Target Spec:** [2026-08-27-llm-model-routes-design.md](./2026-08-27-llm-model-routes-design.md)

---

## 1. Summary of Review

The proposed design for model routes is robust, elegant, and successfully addresses the current single-seat limitation of the LLM router by transitioning to a route-aware `(provider, model)` architecture. By making `isLocal` a required, provider-level property, the design also eliminates the risks associated with multiple definitions of local-ness.

Below are detailed suggestions, improvements, and open questions to ensure edge cases are handled before starting the implementation.

---

## 2. Improvements & Suggestions

### 2.1 Route ID Parsing & Slash Robustness (HuggingFace/Registry Model Names)

* **Issue:** The proposed route ID format is `${providerId}/${modelName}`. In some cases, model names themselves contain slashes (e.g., HuggingFace repositories like `meta-llama/Llama-3-8b` or local custom tags). If the router split logic simply splits on `/`, it could break or incorrectly identify the provider.
* **Suggestion:** Ensure that the parsing logic splits on the **first** slash only.

    ```typescript
    const slashIdx = routeId.indexOf('/');
    const providerId = routeId.substring(0, slashIdx);
    const modelName = routeId.substring(slashIdx + 1);
    ```

    This should be explicitly specified in the implementation details to avoid fragile string splits.

### 2.2 Model Lifecycle Management on Shared Runtimes

* **Issue:** When running multiple local models on the same runtime (e.g., `ollama/qwen3` and `ollama/gemma3`), there will be two separate `OllamaProvider` instances. `LlmRegistry` has lifecycle methods such as `loadModel`, `unloadModel`, and `pullModel`.
* **Question:** Do lifecycle actions execute against the specific instance (which holds the model name state)?
* **Suggestion:** Yes. Since the providers are lightweight and hold the model configuration, the registry should route the lifecycle operations to the specific provider instance matching the `routeId`. This keeps the provider implementation clean without needing to thread model arguments through the registry methods.

### 2.3 Context Overflow and Ledger Accuracy

* **Issue:** When the router triggers `tryRemoteFallback` (rewritten to walk the next available fitting routes in priority order), we must ensure that the egress ledger correctly reflects the model that *actually* executes.
* **Recommendation:**
    1. The fallback selection must happen **before** calling `recordSynthesisEgress`.
    2. If a fallback route is selected, the egress ledger row must use the fallback route's `providerId` as the destination.
    3. If no fallback route is found (or if all fitting routes are filtered out by air-gap / synthesis restrictions), the execution should fail-closed prior to ledgering or model execution.

### 2.4 Priority Walk vs. Capability & Security Filtering

* **Issue:** The priority order resolution is defined as: `Explicit task pin` -> `route_priority` -> `default ordering`, followed by filters for air-gap, capability floor, and availability.
* **Clarification:** To ensure security and correctness, filtering (especially security constraints like air-gaps) must act as a strict gate. The route selection algorithm should filter the candidate pool *first*, or skip any selected route during the priority walk if it fails the security/capability checks.

### 2.5 CLI Surface Layout (`nimbus llm status`)

* **Suggestion:** Since `nimbus llm status` will now list multiple routes, we should output a clean tabular format.

    ```text
    ROUTE ID          PROVIDER    MODEL       TYPE      STATUS    CONTEXT WINDOW
    ollama/qwen3      ollama      qwen3:8b    local     active    8,192
    ollama/gemma      ollama      gemma3:12b  local     inactive  131,072
    ```

---

## 3. Open Questions for Slice 2 & Beyond

1. **Opt-in Mechanism for Remote Vendors:**
    To implement the "explicit opt-in flag" discussed in Open Decision 3, will we introduce an `enabled = true` property inside the individual `[llm.remote.<vendor>]` TOML configuration tables?
2. **Telemetry and Error Handling for Unavailable Local Models:**
    If a configured local route's model is not yet pulled (e.g., `ollama/gemma3` is configured but not present in the local daemon), does `firstAvailable` automatically fall back to the next route, or does it trigger a pull/error?
