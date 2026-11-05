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
- Classify each in `ACTION_PROPOSABILITY`: `denied("unroutable", …)` until the B PR that templates it makes it proposable (the § 5.1 precedent) — EXCEPT none; keep all denied in B-X.
- Update the count pins: `rows.test.ts` (88 → 102; leave `REFUSED_BEFORE_A1` at 88), `security-invariants.test.ts` (the I26/I29/I53 row counts), the A3 per-write coverage (now 102 + 4), any wave-count test (wave 2: 24 → 38), the I2 frozen-set count in docs.
- `manifest.sync.test.ts`, `connector-write-sync.test.ts`, `proposable-actions.sync.test.ts`, the D20 regex (derived — check), the A3 egress/federation coverage all green.
- `proposable-service-configured`: Discord's configured check must use `enabled === "1"` and the bot token (verify; adjust if it would say configured wrongly).

### Task 3: Outlook `Mail.ReadWrite`
Add `Mail.ReadWrite` to the Outlook default scopes in `connectors/connector-catalog.ts` (owner ruling 2026-11-05); find and update the tests that pin the scope list; note in docs that existing Outlook users must re-authorise (`nimbus connector auth outlook`) to get draft create.

### Task 4: Docs
Five core docs (owner rule) + SECURITY-INVARIANTS (I26 counts and lists, I2 frozen-set count), CHANGELOG, cli-reference (Outlook re-auth note), the connector reference listing tools if one exists. `audit:doc-refs`, `audit:status-drift`, `preflight:fast`.

## PR
Title: `feat(gateway): connectors 0.4.0 — classify its new Wave-2 writes`. Not breaking (Outlook users re-authorise only to gain the new draft tool). Auto-merge; resolve threads. This PR must land the same day 0.4.0 publishes.
