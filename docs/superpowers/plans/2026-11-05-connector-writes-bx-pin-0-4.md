# Connector Writes B-X: Pin @nimbus-dev/connectors 0.4.0 and Classify Its New Writes

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the gateway to `@nimbus-dev/connectors` 0.4.0 the day it publishes, and classify its 14 new write tools (plus one new read) everywhere the gateway requires, so the version-skew audit and every write-classification test stay green. Nothing is offered to the model yet (no templates; B1–B4 add them).

**Spec:** `docs/superpowers/specs/2026-11-04-connector-writes-design.md` § 14 (branch `dev/asaf/connector-writes-spec`). Connector PR: nimbus-agent/nimbus-mcp-servers#64 (merged `c7c35e6b6`).

## Global Constraints
- Branch from `origin/main` AFTER 0.4.0 is on npm (`npm view @nimbus-dev/connectors version` prints `0.4.0`). Plans and the spec never land on `main`.
- No behaviour change beyond: the new tools are classified writes (HITL, refused over federation, D20-confined), and the Outlook connector requests `Mail.ReadWrite`.
- Gate-confined ids (D17/D19) are never spelled outside their gates.
- Before every push: `bun run preflight:fast`, `bun run typecheck:tests`; the version-skew audit passes.
- Commit trailers as before.

## The 14 new writes (all `transport: "mesh"`, wave 2; action type = tool id with `_` → `.`)
- `tickets.ts`: `github_issue_comment_create`, `github_issue_labels_add`, `github_issue_assignees_add`, `github_issue_state_set`, `gitlab_issue_create`, `gitlab_issue_note_create`, `gitlab_mr_note_create`, `gitlab_issue_labels_add`, `gitlab_issue_assignees_add`, `gitlab_issue_state_set`, `jira_issue_transition`.
- `mail-calendar.ts`: `outlook_draft_create`.
- `messaging.ts`: `discord_message_post`.
- `knowledge.ts`: `confluence_page_append`.
The new READ `jira_issue_transitions_list` is not a row; confirm `isReadOnlyToolId` accepts it (it ends `_list`).

## Tasks

### Task 1: Pin, lockfile and manifest
`packages/gateway/package.json` → `"@nimbus-dev/connectors": "^0.4.0"`; `bun install` (commit `bun.lock`; bump every workspace manifest that pins it — check with `git grep '"@nimbus-dev/connectors"'`); `bun run gen:connector-write-manifest` (expect 87 + 14 = 101 entries; re-derive); `bun run gen:connector-registry` if the bundled registry changes; `bun run audit:connector-version-skew` passes.

### Task 2: Rows, frozen set, proposability, counts
- Add the 14 rows to their group files (`row(toolId, actionType, "mesh", 2)`).
- Add the 14 action types to `HITL_REQUIRED_BACKING` (hand-written literal, `engine/executor.ts`).
- Classify each in `ACTION_PROPOSABILITY` under a NEW denied class `"not_yet_offered"` (add it to `DeniedClass` with a doc comment: a real, routable write whose MCP proposal is withheld until its B PR adds a preview template; check every consumer of `DeniedClass` — the MCP refusal mapping and its tests — handles the new value). `unroutable` means "no tool can resolve" and would be false here.
- Update the count pins after finding each with `git grep -n "88\b"` in tests and docs: `rows.test.ts` (88 → 102; leave `REFUSED_BEFORE_A1` at 88), the row-count assertions in `security-invariants.test.ts` (find them; do not assume which invariant blocks hold them), the A3 per-write coverage (102 + 4), any wave-count test (wave 2: 24 → 38), the I2 frozen-set count in docs (re-derive from `HITL_REQUIRED.size`).
- `manifest.sync.test.ts`, `connector-write-sync.test.ts`, `proposable-actions.sync.test.ts`, the D20 regex (derived — check), the A3 egress/federation coverage all green.
- Group placement: `gitlab_mr_note_create` and `gitlab_issue_*` follow where the existing GitLab and GitHub rows live (`gitlab_mr_merge` is in `vcs-ci.ts`; put MR notes beside it and issue rows in `tickets.ts` beside `github_issue_create`).

### Task 3: Outlook `Mail.ReadWrite` without breaking existing connections
Owner ruling 2026-11-05: add `Mail.ReadWrite` to the Outlook default scopes (`connectors/connector-catalog.ts`). FIRST read how the Microsoft OAuth refresh builds its request (`auth/oauth-registry.ts` / the Microsoft token path — find it): if a refresh sends `scope=` built from the catalog defaults, an existing connection consented only to the old set could get `AADSTS65001`/`invalid_grant` and lose ALL Outlook tools. The change must guarantee that a token refresh requests only what was already granted (the stored granted scopes, or no `scope` parameter if that is how it works today), and that only a fresh `nimbus connector auth outlook` requests `Mail.ReadWrite`. Health/scope-comparison code must not mark an existing connection unhealthy for lacking the new scope (the connector-side `outlookToolShouldRegister` already hides the draft tool when the scope is absent). Tests: a refresh for a connection granted the old scopes sends no new scope; a fresh auth requests `Mail.ReadWrite`; the scope-list pins updated. Docs: existing users re-authorise only to gain draft create; an enterprise tenant may require admin consent for `Mail.ReadWrite` (stated bound). If the refresh path cannot be made safe in this PR, STOP and report.

### Task 4: Docs
The five core docs (CLAUDE.md + GEMINI.md, docs/roadmap.md, docs/architecture.md, docs/README.md, docs/cli-reference.md; say why any is unchanged) + SECURITY-INVARIANTS (I26 counts and lists, I2 frozen-set count), CHANGELOG, cli-reference (Outlook re-auth note), the connector reference listing tools if one exists. `audit:doc-refs`, `audit:status-drift`, `preflight:fast`.

## PR
Title: `feat(gateway): connectors 0.4.0 — classify its new Wave-2 writes`. Not breaking (Outlook users re-authorise only to gain the new draft tool). Auto-merge; resolve threads. This PR must land the same day 0.4.0 publishes.
