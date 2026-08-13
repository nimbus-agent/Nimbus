# Nimbus Negotiate Agent Plan Review

> **HISTORICAL — do not read as current contract.** This is a point-in-time
> review of the implementation plan, kept for provenance. It records open
> questions as they stood *before* implementation; several were answered
> differently in the shipped code. The authoritative current contract is
> [`docs/cli-reference.md`](../../cli-reference.md)'s `nimbus negotiate`
> section plus the `agents.negotiate` block in
> [`docs/architecture.md`](../../architecture.md); the answers given at the
> time are in
> [`2026-08-12-nimbus-negotiate-agent-review-response.md`](./2026-08-12-nimbus-negotiate-agent-review-response.md).
> Note in particular that this document places `renderNegotiate` in
> `agents/_lib/synthesize.ts`; it ships in `agents/_lib/render.ts`.

## Open Questions & Risks

1. **Synthesizer LLM Fallback Behavior**
   - The plan maps `ctx.llm` into `emitBriefWithSynthesis` if defined (Task 1 and Task 7).
   - **Question**: If no LLM is configured (e.g., in a purely local environment without Ollama/OpenAI API keys, or when LLM queries are disabled), does `emitBriefWithSynthesis` have a robust local template/prose fallback to render the brief's markdown, or will the agent fail to render/synthesize entirely?
   - **Suggestion**: Ensure that the e2e test suite or a unit test verifies the agent's behavior when `llm` is omitted (i.e., verifying the template fallback works and outputs correct SQL-derived numbers without throwing).

2. **Personal Documents Opt-In Config Helper**
   - In Task 6 Step 3, the `nimbus-toml.ts` parser will read `personal_sources` from the `[negotiate]` block.
   - **Question**: What happens if the array contains malformed string entries, or services that are not currently configured as connectors? Will the parser filter them out, or will the lane attempt to run and throw?
   - **Suggestion**: Ensure that `laneWriting` only queries active/recognized services or logs a minor debug warning for unknown/unconfigured personal services in `nimbus.toml` rather than failing the lane.

3. **Unmapped Git Identity Warning for Coworkers (`--person`)**
   - The under-count guard `detectUnmappedGitIdentity` is only active for the resolved self-user, since git aliases for a different subject are unknown to the local Git config.
   - **Question**: Can we improve attribution visibility when a manager runs a dossier for a colleague (`--person <id>`) where the database itself might have unmapped `git:<email>` ownership edges?
   - **Suggestion**: Instead of relying purely on a generic caveat, query the `owns` relationships in the DB to see if any `git:email` entities exist with significant blame weight that share a name/email substring matching the target Person, and list them as "potentially unmapped aliases" to help the user improve database mapping.

4. **Query Performance on metadata JSON parsing**
   - In Task 2, `json_extract` and `json_valid` are used on `item.metadata`.
   - **Question**: Will these JSON functions impact performance on large databases with thousands of items?
   - **Suggestion**: Since the query restricts rows by `i.service = 'github'` and `i.type = 'review'`, verify that the local database schema has an index covering `(service, type, author_id)` or `(type, author_id)` so SQLite filters candidate rows before parsing JSON metadata.
