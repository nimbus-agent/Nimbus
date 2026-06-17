# Review & Feedback: jscpd Duplication Reduction & Gate Tightening

**Date:** 2026-06-17
**Related Spec:** [2026-06-17-jscpd-duplication-reduction-design.md](file:///C:/gitrep/Nimbus/.claude/worktrees/jscpd-dedup/docs/superpowers/specs/2026-06-17-jscpd-duplication-reduction-design.md)

---

## 1. Open Questions

### Q1.1: Rate Limiting and Retry Logic in Stage A
* **Context:** The design proposes extracting a generic `runPaginatedSync(...)` helper. Syncing from diverse cloud APIs ( Zendesk, Vercel, StackOverflow, etc.) often requires handling rate limits (e.g., HTTP 429, back-off rules).
* **Question:** Should rate-limiting / retry wrapping be built directly into the new `paginated-sync.ts` helper, or is it assumed that the caller-provided `fetch` client handles all retries/back-offs transparently? If the latter, we must verify that all target connectors use a unified, rate-limit-aware fetch client (e.g., from `science-skills-common` or gateway core).

### Q1.2: local-first MCP SDK Package Exports and Linking
* **Context:** Monorepos using Bun workspaces handle inter-package dependencies smoothly. However, moving registration helpers to `@nimbus-dev/sdk` requires those exports to be configured correctly.
* **Question:** Do we need to expose new build targets or entry points in `packages/sdk/package.json` for helper utilities so they don't bloat the core SDK runtime for basic consumers? Are there any potential circular dependency issues with other package imports?

### Q1.3: Handling Auto-Generated Code
* **Context:** The spec states: *"never by adding jscpd ignores"*.
* **Question:** Does this strict prohibition also apply to auto-generated code, such as DB migration schemas, auto-generated RPC/IPC client bindings, or type declarations generated from tools? If any such files currently contribute to the duplication score, ignoring them is standard practice since they cannot be refactored into shared helpers. Should we explicitly define the boundaries of this rule (e.g., *"never ignore handwritten source code, but auto-generated artifacts may be ignored"*).

---

## 2. Suggestions & Improvements

### Suggestion 2.1: Declarative OAuth Providers (Stage D)
* **Problem:** OAuth registration and token handling across different providers (`auth/oauth-registry.ts` and `ipc/connector-rpc-handlers/auth.ts`) usually shares identical flow logic, varying only by URL endpoints, client scopes, and basic metadata.
* **Improvement:** Instead of extracting procedural helper functions, define a unified OAuth provider schema/type and model providers as a declarative configuration map:
  ```typescript
  interface OAuthProviderConfig {
    authUrl: string;
    tokenUrl: string;
    scopes: string[];
    // ...
  }
  ```
  This eliminates duplicate functions entirely and makes adding future providers a simple config addition.

### Suggestion 2.2: Strong Generic Typing for `runPaginatedSync`
* **Problem:** Broad parameterization can easily degrade into using `any` or loose `unknown` casts, violating the **Non-Negotiables** (*No `any` — TypeScript strict mode is non-negotiable*).
* **Improvement:** Ensure `runPaginatedSync` uses strong generics:
  ```typescript
  export async function runPaginatedSync<TPageResponse, TItem, TMappedItem>({
    fetchPage,
    extractItems,
    mapItem,
    upsert,
    // ...
  }: PaginatedSyncOptions<TPageResponse, TItem, TMappedItem>): Promise<SyncOutcome>
  ```
  This preserves complete type safety through the entire pagination and mapping pipeline.

### Suggestion 2.3: Standardized Logging / Telemetry Hook
* **Problem:** Different connectors log errors, progress, and upsert status slightly differently, which could lead to small block variations that trigger jscpd clones.
* **Improvement:** Incorporate a standardized telemetry hook/callback in `runPaginatedSync` that handles standard lifecycle logging (e.g., page fetched, items upserted, rate-limit hit, sync failed), ensuring consistent log structure across all connectors.
