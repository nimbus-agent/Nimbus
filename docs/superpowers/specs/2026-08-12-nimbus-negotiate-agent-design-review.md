# Nimbus Negotiate Agent Design Review

> **HISTORICAL — do not read as current contract.** This is a point-in-time
> review of the design spec, kept for provenance. It records open questions as
> they stood *before* implementation; several were answered differently in the
> shipped code. The authoritative current contract is
> [`docs/cli-reference.md`](../../cli-reference.md)'s `nimbus negotiate`
> section plus the `agents.negotiate` block in
> [`docs/architecture.md`](../../architecture.md); the answers given at the
> time are in
> [`2026-08-12-nimbus-negotiate-agent-design-review-response.md`](./2026-08-12-nimbus-negotiate-agent-design-review-response.md).
> Note in particular that the shipped agent is excluded from the MCP tool
> surface as well as the local HTTP API, and that the personal-docs gate
> resolves per SERVICE rather than per item type.

## Open Questions & Risks

1. **Local HTTP API Exclusion (`HTTP_EXCLUDED_AGENT_METHODS`) vs. Client Integrations**
   - Under § 3.1, `agents.negotiate` is added to the exclusion list to prevent arbitrary local HTTP clients from assembling dossiers on coworkers using `--person`.
   - **Question**: How does this affect future client integrations (like the browser extension or Tauri UI) if they want to render the contribution/negotiate brief? Since Tauri communicates over JSON-RPC 2.0 IPC, it is fine, but if a browser-side gateway client needs it via local HTTP (e.g., `/v1/agents/negotiate`), it will be blocked. Is the threat model of a local token-holder querying other people's dossiers severe enough to permanently disable HTTP access, or should we gate `--person` support on the caller's transport/privilege level instead?
   - **Suggestion**: If HTTP exposure becomes necessary, we can allow the method on HTTP but restrict `--person` overrides on HTTP requests to only allow the resolved self-identity, returning a `403 Forbidden` if another ID is supplied.

2. **Source Identifiers and Consent UX for Personal Documents**
   - Under § 3.3, personal sources (like 1:1 notes) are opt-in via a `[negotiate]` block in `nimbus.toml`.
   - **Question**: How does a user discover the correct identifiers of their personal sources (e.g., Notion pages, Obsidian paths) to add them to `nimbus.toml`? If the identifier format is complex or non-obvious, users might struggle to configure consent.
   - **Suggestion**: Provide a helper CLI warning or suggestion when running `nimbus negotiate` if no personal sources are configured, pointing the user to a command (or list of directories/databases) that displays active personal connectors and how to reference them.

3. **Performance of Blame and Ownership Lanes**
   - Traversal of ownership graphs and git blame databases can be extremely heavy on large repositories.
   - **Question**: Is there a safeguard or timeout for the ownership lane query to prevent it from blocking the request-scoped `AgentCoordinator`?
   - **Suggestion**: Implement a limit on the number of traversed files/directories (e.g., prioritizing files with the highest blame weights or limit to active directories) and ensure database indexes on `blame` and `ownership` are optimized for person-based lookups.

4. **Consistency of Git Email / Identity Resolution**
   - Section 2 notes that `git_commit` items have `authorId: null` and there is no commit-level attribution.
   - **Question**: Since git commits lack author attribution, how does the blame lane correlate git emails from `git_blame_line` to the target Person (`--person <id>`)? If the Person entity doesn't have all their Git email aliases mapped, the ownership lane might silently omit their contributions.
   - **Suggestion**: Validate that identity resolution (`self-person.ts` or the graph populator) maps git email aliases to `person` entities, and include a diagnostic step in the gap notes if a target person has no associated git emails.

## Suggestions for Implementation Plan

- **Red-Proving HTTP Exclusion**: Write a dedicated integration test that attempts to call `POST /v1/agents/negotiate` via the mock HTTP server and asserts it returns `404 Not Found` (or the appropriate method-not-allowed / method-excluded response), ensuring the exclusion mechanism cannot be accidentally broken.
- **Granular Gap Notes for Decisions**: In § 8.2, if decision records have null authors, emit a specific gap note detail rather than falling back to a general failure.
