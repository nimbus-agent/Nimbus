# nimbus-mcp-servers 0.4.0: Wave-2 Write Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the connector tools Phase 9.7 Wave 2 needs to `@nimbus-dev/connectors` (repo `nimbus-agent/nimbus-mcp-servers`, local `C:\gitrep\nimbus-mcp-servers`), released as 0.4.0: GitHub issue comment, add-labels, add-assignees, state, and a GHES base-URL override; GitLab issue create, issue note, MR note, add-labels, add-assignees, state; Jira transition plus a transitions list; Outlook draft create; Discord post (as the bot); Confluence page append.

**Architecture:** Every write registers through `createWriteToolRegistrar` (`shared/consent-kit.ts`), with one literal tool id per call and a literal `mutates` (the gateway's manifest generator statically scans these; anything else is a scan violation). Action type = tool id with `_` → `.`.

**Spec:** `docs/superpowers/specs/2026-11-04-connector-writes-design.md` § 14 (Nimbus repo, branch `dev/asaf/connector-writes-spec`). Owner rulings 2026-11-05: Outlook gets `Mail.ReadWrite`; GitHub/GitLab label and assignee tools are ADD-ONLY (nothing the model can remove); Discord posts allow user mentions only; GHES gateway wiring is a later PR (connector override ships now).

## Global Constraints

- Work in a worktree of `nimbus-mcp-servers` (`git worktree add <abs path> -b dev/asaf/wave2-write-tools origin/main`); read its `CLAUDE.md`, `docs/architecture.md`, `docs/adding-a-connector.md` first.
- Each new write: literal id, literal `mutates`, `recoverable` (true unless stated), `scopeTargetOf` matching the connector's declared scope kinds; read the credential before the first fetch (the contract test refuses a missing credential by name before any request).
- Update each connector's `*_TOOL_NAMES` (`bun run sync:tool-names`), add a row per write to `scripts/connector-write-scope.test.ts`, gateway-mode request tests (method, URL, body, auth header) and the standalone consent tests the table covers.
- No `any`; Biome; cross-platform; no plaintext credentials; Sonar duplication: share builders instead of copying.
- Gates before every push: `bun run check` (the repo's full gate) and its tests.
- PR titles are conventional `feat(<connector>): …` (release-please bumps 0.3.0 → 0.4.0). Do NOT merge the release-please PR; the owner merges release PRs, and only after the gateway pin-bump PR is ready (0.4.0 on npm turns the gateway's `audit:connector-version-skew` red).
- PR bodies end with the attribution lines; no unbalanced `(`.

## Tasks

### T1: GitHub (`shared/github-rest.ts`, `connectors/github/src/tools.ts`, `connectors/github-actions/src/tools.ts`)
- `ghApiBase()` = `optionalBaseUrl("GITHUB_API_BASE_URL", GH_API)`, read per call; `ghFetch` and `gha_run_log` (today builds its URL from `GH_API` with the Bearer token — must switch, or a GHES PAT goes to api.github.com) use it. Tests: override routes to `https://ghe.example.com/api/v3/...`; trailing slash stripped; gha log goes to the GHES host.
- `github_issue_comment_create {owner, repo, issueNumber int ≥1, body 1..65000}` → POST `/repos/o/r/issues/{n}/comments`; `mutates "github.issue.comment.create"`; scope `repo:owner/repo` (via `registerGithubWriteTool`). Description: also covers PR conversation comments.
- `github_issue_labels_add {owner, repo, issueNumber, labels: string 1..50 [] 1..100}` → POST `/repos/o/r/issues/{n}/labels` `{labels}` (adds; never removes); `mutates "github.issue.labels.add"`.
- `github_issue_assignees_add {owner, repo, issueNumber, assignees: string 1..39 [] 1..10}` → POST `/repos/o/r/issues/{n}/assignees`; `mutates "github.issue.assignees.add"`.
- `github_issue_state_set {owner, repo, issueNumber, state: "open"|"closed"}` → PATCH `/repos/o/r/issues/{n}` `{state}`; `mutates "github.issue.state.set"`.
- Extend `connectors/github/test/write-tools.test.ts` lists.

### T2: GitLab (`connectors/gitlab/src/tools.ts`, via `registerGitlabWriteTool`, scope `repo:projectPath`)
- `gitlab_issue_create {projectPath, title 1..255, description? ≤65000, labels? string 1..255 no commas ≤50, assigneeIds? int ≥1 ≤20}` → POST `/projects/:enc/issues`; `gitlab.issue.create`.
- `gitlab_issue_note_create {projectPath, issueIid int ≥1, body 1..65000}` → POST `.../issues/:iid/notes`; `gitlab.issue.note.create`.
- `gitlab_mr_note_create {projectPath, mergeRequestIid int ≥1, body 1..65000}` → POST `.../merge_requests/:iid/notes`; `gitlab.mr.note.create`.
- `gitlab_issue_labels_add {projectPath, issueIid, labels: string 1..255 no commas [] 1..50}` → PUT `.../issues/:iid` `{add_labels: labels.join(",")}` (add-only); `gitlab.issue.labels.add`.
- `gitlab_issue_assignees_add {projectPath, issueIid, assigneeIds: int ≥1 [] 1..20}` → GET the issue, PUT `assignee_ids` = current ∪ new (never fewer); `gitlab.issue.assignees.add`.
- `gitlab_issue_state_set {projectPath, issueIid, stateEvent: "close"|"reopen"}` → PUT `{state_event}`; `gitlab.issue.state.set`.
- End-to-end test against a fake server via `GITLAB_API_BASE_URL`.

### T3: Jira (`connectors/jira/src/tools.ts`)
- Read `jira_issue_transitions_list {issueKey}` → GET `/rest/api/3/issue/{key}/transitions?expand=transitions.fields`.
- Write `jira_issue_transition {issueKey, transitionId /^\d{1,20}$/}` → POST `.../transitions` `{transition:{id}}` (204; on `!ok` throw quoting Jira's error); `mutates "jira.issue.transition"`, scope `issue:<key>`, `recoverable: true`, `capturePreState` = GET `?fields=status` → `{status}`.

### T4: Outlook (`connectors/outlook/src/tools.ts`, `tool-scope-policy.ts`)
- Extract a shared `graphMessage(data)` builder from `outlook_mail_send` (recipients, contentType, cc, bcc).
- `outlook_draft_create {to headerLine 1..2000, subject headerLine 1..500, body 1..1000000, contentType? text|html, cc?, bcc?}` → POST `/me/messages` (201); `mutates "outlook.draft.create"`, `recoverable: true`, scope `recipient:p.to`; registered through `registerOutlookWriteTool` + `outlookToolShouldRegister`.
- `OUTLOOK_TOOL_MIN_SCOPES.outlook_draft_create = ["Mail.ReadWrite"]` + a scope-policy test.

### T5: Discord (`connectors/discord/src/{tools,server}.ts`, `nimbus.extension.json`, `README.md`)
- Manifest `hitlRequired: ["write"]`; `server.ts` `capabilities: CONSENT_SERVER_CAPABILITIES` and instructions like GitHub's; `registerDiscordTools(server: ConsentServer & {...})`; `DISCORD_TOOL_NAMES`; registrar `createWriteToolRegistrar(server, { connector: "discord", scopeEnv: "NIMBUS_MCP_DISCORD_WRITE_SCOPE", scopeKinds: ["channel"] })`.
- `discord_message_post {channelId /^\d{17,20}$/, content 1..2000}` → POST `/channels/{id}/messages` `{content, allowed_mentions: {parse: ["users"]}}` (owner ruling: user mentions only); `mutates "discord.message.post"`, scope `channel:<id>`; description says it posts as the bot.
- Tests set the connector mode; update `standalone/src/launcher.test.ts` (Discord now `reason: "hardened"`) and `docs/standalone-launcher.md` (57 / 37), and `connector-write-scope.test.ts`.

### T6: Confluence (`connectors/confluence/src/tools.ts`)
- `confluence_page_append {pageId, storageHtml 1..65000}`: GET `/content/{id}?expand=body.storage,version` → PUT version+1 with body = old + new (type and title from the GET); on 409 re-read and retry once; a second 409 throws "page changed concurrently; nothing appended". `mutates "confluence.page.append"`, scope `page:<id>`, `recoverable: true`, `capturePreState` `{versionNumber, bodyLength}`. Never touches `confluence_kb_append`. End-to-end test against a fake server via `CONFLUENCE_BASE_URL`.

### T7: Docs
`docs/configuration.md` (`GITHUB_API_BASE_URL`, Discord `channel:` scope kind), connector READMEs (GitHub GHES, Discord bot + write scope), any count doc the gates name.

## Delivery
One PR per task group or a single PR (builder's call by size), each green on the repo's CI with threads resolved, auto-merge. After all merge, release-please opens `chore(main): release connectors 0.4.0` — leave it for the owner, and say so.
