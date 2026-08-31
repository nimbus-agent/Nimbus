# Design Review: Agents That Answer About an Item, and About a File You Are Reading

**Date:** 2026-08-31  
**Reviewer:** Antigravity (AI Coding Assistant)  
**Status:** Under Review  
**Target Spec:** [`2026-08-31-agents-for-items-and-files-design.md`](./2026-08-31-agents-for-items-and-files-design.md)  
**Related Specs:**  

- Web Clipper: [`nimbus-web-clipper` / `2026-08-31-lanes-for-every-recognised-page-design.md`](../../../nimbus-web-clipper/.claude/worktrees/lanes-everywhere/docs/superpowers/specs/2026-08-31-lanes-for-every-recognised-page-design.md)  
- SDK: [`nimbus-sdk` / `2026-08-31-connections-and-currency-briefs-design.md`](../../../nimbus-sdk/.claude/worktrees/connections-currency-briefs/docs/superpowers/specs/2026-08-31-connections-and-currency-briefs-design.md)

---

## 1. Summary of Review

The design specification is exceptionally well-researched and grounded in the existing codebase architecture:

1. **Preserving API Stability (F2):** Introducing `WhyItemSubject` and `WhyBrief.itemSubject` as an additive third arm avoids widening `WhyChangeSubject.repo` to nullable, preventing a breaking change on a **stable** SDK tier.
2. **Leveraging Existing Graph Infrastructure (F1, F4):** Reusing `resolveItemByUrl` and walking the `workspace --tracks_remote--> repo` bridge neatly bridges the browser's forge coordinates (`service:repo` + `path`) to local checkout entities (`source_file`).
3. **Stand-Alone Correctness Fix (F3):** Fixing `impact`'s non-PR arm to check `source_file` exact matches before falling back to `symbol` `LIKE` search resolves a real bug on the terminal CLI surface.
4. **Principled Verification for `currency` (F6):** Enforcing that every currency claim carries supporting evidence rather than returning unsubstantiated "looks stale / current" verdicts.

Below are key open questions, improvements, and edge-case considerations to address before and during implementation.

---

## 2. Open Questions & Architectural Ambiguities

### Q2.1: Semantics of `why` Sub-Agents on Non-PR Items (`itemUrl`)

- **Context:** §4.1 states: *"Each arm is: validate the URL, call `resolveItemByUrl`, take the item and its `graph_entity`, and run the agent body that already exists against that entity."*
- **Ambiguity:** In `packages/gateway/src/agents/why.ts`, the coordinator executes 6 sub-agents (`subAuthorship`, `subPullRequest`, `subTicket`, `subDiscussion`, `subDriver`, `subDownstream`). These sub-agents are strictly coupled to either a file line (`ref` arm) or a PR entity (`prUrl` arm, e.g. `ticketRowsForPr` joins `WHERE pe.type = 'pr' AND r.from_id = ? AND r.type = 'resolves'`):
  - If the subject is a **Jira/Linear issue**: `subPullRequest` expects a PR entity ID to find reviewers; `subTicket` expects a PR entity ID to find tickets resolved by it. If handed an issue entity ID, both return 0 rows. Does `why` look for incoming `resolves` edges (i.e. PRs that resolved this issue) or related/blocking tickets?
  - If the subject is a **Confluence doc** or **incident**: How do `subPullRequest`, `subTicket`, and `subDiscussion` query the graph?
- **Recommendation:** Explicitly document the query behavior of each `why` sub-lane when `arm === "item"`:
  - `subPullRequest`: Look for PRs that link to or resolve the item (`graph_relation` where `to_id = item.entityId` and `type = 'resolves'`).
  - `subTicket`: Look for connected/parent/blocking issues (`type = 'depends_on'` or `type = 'mentions'`).
  - `subAuthorship` & `subDownstream`: Stay silent / skipped (matching the `prUrl` arm behavior).
  - `subDiscussion`: Query discussions attached to or mentioning the item entity.

### Q2.2: `expert` Agent Execution on Entities vs Lexical Text Search

- **Context:** §4.1 states: *"The free-text path stays for callers who want it. The `itemUrl` arm resolves the URL to an item and answers from the entity, which is a different and better question."*
- **Ambiguity:** Currently, `runExpert` in `packages/gateway/src/agents/expert.ts` only accepts `input.topicOrFile: string` and executes 5 sub-agents (`subBlame`, `subPrAuthored`, `subPrReviewed`, `subIncidentResolved`, `subChatMentions`) that run SQL queries with `LIKE '%' || ? || '%'` against titles and previews. It does not have an entity-based query implementation.
- **Recommendation:** Define the entity-based query paths for `expert` when given an item entity (or forge file coordinate):
  - **Item Entity:** Query direct relation edges into `person` entities (`authored`, `reviewed`, `assigned`, `posted`, `resolved`).
  - **Forge File Entity (`source_file`):** Query `git blame` for the file on disk + commits touching the file + authors/reviewers of PRs that modified the file.

### Q2.3: `OwnershipBrief` Schema & Target Kinds on `itemUrl`

- **Context:** §4.1 states: *"requireOwnershipParams already rejects path and service together. itemUrl joins that mutual exclusion as a third member... All three answer with their existing brief shapes."*
- **Ambiguity:** In `packages/gateway/src/agents/_lib/ownership-types.ts`:
  - `OwnershipTargetView` is typed with `kind: "source_file" | "directory" | "service"`.
  - `OwnershipBrief.query` is typed `{ readonly path: string | null; readonly service: string | null }`.
  - If a user passes `itemUrl` for a Jira issue or doc, what is `target.kind`? Does `ownership` resolve the item to its owning service (returning `kind: "service"`) or does `OwnershipTargetView.kind` widen to `"item"`?
  - Does `OwnershipBrief.query` gain `itemUrl?: string | null`?
- **Recommendation:** Clarify the exact shape:
  - If `ownership` maps the item to its service via the `belongs_to` relation, `target.kind` remains `"service"` and `service.id` is populated.
  - If `ownership` returns item-level owners directly, `OwnershipTargetView.kind` must add `"item"` (or `"indexed_item"`), and `query` should include `itemUrl: string | null`.

### Q2.4: Exact Wire Schema and Method Names for `connections` and `currency` (PR 3)

- **Context:** The SDK and Clipper specs rely on the Nimbus gateway spec as the source of truth for wire schemas.
- **Ambiguity:** §4.3 and §4.4 explain the semantics but omit the exact JSON-RPC method names and brief type properties.
- **Recommendation:** Define the exact schemas in §4.3 and §4.4:
  - **RPC Methods:** `agents.connections` (notification: `connections.briefReady`), `agents.currency` (notification: `currency.briefReady`).
  - **Brief Discriminants:** `kind: "connections"` (or `"connection"`) and `kind: "currency"`.
  - **`ConnectionsBrief` payload:**

    ```ts
    export type ConnectionNeighbour = {
      edgeType: string;
      direction: "inbound" | "outbound";
      entityId: string;
      entityType: string;
      label: string;
      item?: { id: string; service: string; type: string; title: string; url: string | null } | null;
    };
    ```

  - **`CurrencyBrief` payload:**

    ```ts
    export type CurrencyFinding = {
      claim: string;
      verdict: "stale" | "current" | "unverified";
      signal: "resolved_issue_pr_merged" | "mentioned_item_updated" | "incident_closed" | "inactivity_threshold";
      evidence: { detail: string; sourceUrl?: string; modifiedAt?: number }[];
    };
    ```

---

## 3. Technical Improvements & Edge Cases

### I3.1: Cross-Platform Path Normalization in `resolveFileByRemote`

- **Issue:** On Windows, local filesystem roots are stored with backslashes (e.g. `C:\gitrep\acme-web`), while forge coordinates from the browser always use forward slashes (e.g. `src/components/Button.tsx`).
- **Risk:** Deterministic IDs formatted as `file:<repoRoot>:<path>` could suffer from mismatched slashes if `repoRoot` is normalized differently across platforms, or if `path` is not normalized to POSIX format.
- **Suggestion:** Explicitly specify that `resolveFileByRemote` normalizes both `repoRoot` and `path` to use standard POSIX separators (`/`) before constructing or querying `file:<repoRoot>:<path>` external IDs.

### I3.2: Forge Remote URL Normalization in `tracks_remote` Bridge

- **Issue:** Git remote URLs can take several forms:
  - HTTPS: `https://github.com/acme/web.git` or `https://github.com/acme/web`
  - SSH: `git@github.com:acme/web.git`
  - Custom SSH aliases: `ssh://git@github.com-work/acme/web`
- **Suggestion:** Ensure the ownership pass's remote parser (`bindRootRemote`) and `resolveFileByRemote` apply identical canonicalization: strip protocol, strip `.git`, lower-case host and organization/repository name, producing a consistent `<service>:<owner>/<repo>` external ID (e.g. `github:acme/web`).

### I3.3: Handling Multiple Local Workspaces Tracking the Same Remote

- **Issue:** A developer may have multiple local clones or git worktrees for `github:acme/web` (e.g. main repo at `C:\gitrep\web` and a worktree at `C:\gitrep\web-hotfix`).
- **Risk:** Walking `repo --tracks_remote--> workspace` could match multiple `workspace` entities.
- **Suggestion:** In `resolveFileByRemote`, handle multiple candidate workspaces deterministically:
  1. Check which workspace actually contains the requested `path` in `source_file`.
  2. If multiple workspaces index the file, break ties using the most recently indexed workspace (`modified_at` or lowest entity ID).

### I3.4: Structured Miss Response for `resolveFileByRemote`

- **Observation:** §4.2 notes two distinct misses: `no such remote is tracked` vs `tracked, but that path is not indexed`.
- **Suggestion:** Return this distinction as a typed discriminant in the internal resolver response:

  ```ts
  type ResolveFileResult =
    | { ok: true; fileEntityId: string; repoRoot: string; path: string }
    | { ok: false; reason: "remote_not_tracked" | "file_not_indexed"; repo: string; path: string };
  ```

  When translating to agent gap notes, emit distinct `category` or structured `detail` so client surfaces do not need to scrape human-readable strings.

---

## 4. Testing Strategy Recommendations

1. **`why` and `expert` Non-PR Matrix:** Add dedicated unit/integration tests for each supported connector entity type (`issue`, `doc`, `incident`) asserting that findings/gaps populate correctly without throwing or returning empty payloads.
2. **Windows Path Separator Test:** Explicitly test `resolveFileByRemote` on Windows paths containing mixed slashes (`C:\repo/src\file.ts`).
3. **Ambiguous / Multi-Worktree Resolution:** Test remote resolution when multiple worktrees share the same tracked remote.
