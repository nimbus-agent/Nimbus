# LLM Model Routes — Implementation Plan Review

**Date:** 2026-08-27  
**Reviewer:** Antigravity (AI Coding Assistant)  
**Status:** Under Review  
**Target Plan:** [2026-08-27-llm-model-routes.md](file:///C:/gitrep/Nimbus/docs/superpowers/plans/2026-08-27-llm-model-routes.md)

---

## 1. Summary of Review

The implementation plan is exceptionally thorough, structured sequentially, and matches the approved design spec. The tasks compile and test incrementally, avoiding giant-step changes. 

The following suggestions address cache longevity, sorting robustness, config URL resolution, and error routing details to prevent minor edge cases during execution.

---

## 2. Improvements & Suggestions

### 2.1 Task 3: Ordering of Remaining Unpinned Routes
*   **Context:** Task 3 outlines sorting routes via `orderedRoutes`:
    ```typescript
    const ordered = explicit.map((id) => byId.get(id)).filter((r): r is ModelRoute => r !== undefined);
    const named = new Set(ordered.map((r) => r.routeId));
    return [...ordered, ...all.filter((r) => !named.has(r.routeId))];
    ```
*   **Suggestion:** The remaining routes appended to the end of the priority list should also respect `preferLocal`. Update the return value to sort the remaining routes before appending:
    ```typescript
    const remaining = all.filter((r) => !named.has(r.routeId));
    const local = remaining.filter((r) => r.provider.isLocal);
    const remote = remaining.filter((r) => !r.provider.isLocal);
    const sortedRemaining = preferLocal ? [...local, ...remote] : [...remote, ...local];
    return [...ordered, ...sortedRemaining];
    ```

### 2.2 Task 5: Availability Cache Persistence
*   **Context:** The TTL-based caching in `RouteAvailabilityProbe` is only effective if the probe instance persists.
*   **Suggestion:** Explicitly state in Task 5 that the `RouteAvailabilityProbe` must be instantiated once as a private member on `LlmRouter` (e.g., `private readonly availabilityProbe = new RouteAvailabilityProbe();`) rather than dynamically inside `firstAvailableRoute` or walk methods, which would discard the cache instantly.

### 2.3 Task 8: Resolved Base URL Collisions
*   **Context:** Task 8 checks for duplicate `llamacpp` `base_url`s.
*   **Suggestion:** If a route omits `base_url`, it defaults to the runtime's default host (e.g. `http://127.0.0.1:8080`). The collision check should compare the *resolved* base URLs (accounting for defaults) rather than raw string values, otherwise two routes omitting `base_url` will bypass the check and collide at runtime.

### 2.4 Task 10: Call Site Audits for Dropped RPC Helpers
*   **Context:** Task 10 drops `requireLocalProvider` and `LOCAL_PROVIDERS`.
*   **Suggestion:** Ensure we list exactly where these functions are called outside `llm-rpc.ts` (e.g., in auth/security gates or debug tools) and document how they will retrieve local-ness from the router's registered provider instance instead.

---

## 3. Open Questions

1.  **Throw Behavior on Malformed Configurations:**
    Task 8 notes: *"a malformed value keeps the silent-ignore behaviour, while an unresolvable route reference throws."* Does throwing during TOML parsing completely block gateway startup (fail-fast), or is it caught and surfaced via standard config diagnostics? Fail-fast is safer, but we should align with Nimbus's boot sequence.
