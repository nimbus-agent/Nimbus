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
- `ghApiBase()` = `optionalBaseUrl("GITHUB_API_BASE_URL", GH_API)`, read per call; `ghFetch` uses it. `ghQueryPath` must keep returning a path RELATIVE to the base (parse against a fixed dummy origin, not the base, so a GHES base with `/api/v3` is never doubled — mirror the GitLab helper in `connectors/gitlab/src/tools.ts` ~:43).
- `gha_run_log` (today `${GH_API}…/logs` with `Authorization` and `redirect: "follow"`): build from `ghApiBase()`, fetch with `redirect: "manual"`, and on a 3xx fetch the `Location` URL with NO `Authorization` header (the log redirect goes to third-party storage; the token must never follow it). Tests: override routes to `https://ghe.example.com/api/v3/repos/...` (no doubled prefix, incl. a `ghQueryPath` tool); trailing slash stripped; the gha log request goes to the GHES host and the redirected request carries no `Authorization`.
- `github_issue_comment_create {owner, repo, issueNumber int ≥1, body 1..65000}` → POST `/repos/o/r/issues/{n}/comments`; `mutates "github.issue.comment.create"`; scope `repo:owner/repo` (via `registerGithubWriteTool`). Description: also covers PR conversation comments.
- `github_issue_labels_add {owner, repo, issueNumber, labels: string 1..50 [] 1..100}` → POST `/repos/o/r/issues/{n}/labels` `{labels}` (adds; never removes); `mutates "github.issue.labels.add"`.
- `github_issue_assignees_add {owner, repo, issueNumber, assignees: string 1..39 [] 1..10}` → POST `/repos/o/r/issues/{n}/assignees` body `{assignees}`; `mutates "github.issue.assignees.add"`.
- `github_issue_state_set {owner, repo, issueNumber, state: "open"|"closed"}` → PATCH `/repos/o/r/issues/{n}` `{state}`; `mutates "github.issue.state.set"`.
- Add each GitHub write to `WRITES.github` in `scripts/connector-write-scope.test.ts` (there is no `connectors/github/test/write-tools.test.ts`; find the GitHub request-test file that exists and extend it).
- Every new tool gets a one-sentence model-facing description stating what it changes and that it cannot remove anything (for the add-only tools).

### T2: GitLab (`connectors/gitlab/src/tools.ts`, via `registerGitlabWriteTool`, scope `repo:projectPath`)
- `gitlab_issue_create {projectPath, title 1..255, description? ≤65000, labels?: z.array(z.string().min(1).max(255) with no commas).max(50), assigneeIds?: z.array(z.number().int().min(1)).max(20)}` → POST `/projects/:enc/issues` `{title, description, labels: labels?.join(","), assignee_ids}`; `gitlab.issue.create`.
- `gitlab_issue_note_create {projectPath, issueIid int ≥1, body 1..65000}` → POST `.../issues/:iid/notes`; `gitlab.issue.note.create`.
- `gitlab_mr_note_create {projectPath, mergeRequestIid int ≥1, body 1..65000}` → POST `.../merge_requests/:iid/notes`; `gitlab.mr.note.create`.
- `gitlab_issue_labels_add {projectPath, issueIid, labels: string 1..255 no commas [] 1..50}` → PUT `.../issues/:iid` `{add_labels: labels.join(",")}` (add-only); `gitlab.issue.labels.add`.
- `gitlab_issue_assignees_add {projectPath, issueIid, assigneeIds: int ≥1 [] 1..20}` → PUT `.../issues/:iid` `{add_assignee_ids: assigneeIds}` (GitLab's atomic server-side add — one request, never removes, fits `registerGitlabWriteTool`'s single fetch; a GET-then-PUT would clobber a concurrent change); `gitlab.issue.assignees.add`.
- `gitlab_issue_state_set {projectPath, issueIid, stateEvent: "close"|"reopen"}` → PUT `{state_event}`; `gitlab.issue.state.set`.
- End-to-end test against a fake server via `GITLAB_API_BASE_URL`.

### T3: Jira (`connectors/jira/src/tools.ts`)
- Read `jira_issue_transitions_list {issueKey}` → GET `/rest/api/3/issue/{key}/transitions?expand=transitions.fields`.
- Write `jira_issue_transition {issueKey, transitionId /^\d{1,20}$/}` via the connector's existing `registerWriteTool` (there is no `registerJiraWriteTool`) → POST `.../transitions` `{transition:{id}}` (204; on `!ok` throw quoting Jira's error); returns `{ ok: true, issueKey, transitionId }`; `mutates "jira.issue.transition"`, scope `issue:<key>`, `recoverable: false` (workflows are often one-way) with `capturePreState` = GET `?fields=status` → `{ status: json.fields?.status?.name ?? json.fields?.status?.id }`.

### T4: Outlook (`connectors/outlook/src/tools.ts`, `tool-scope-policy.ts`)
- Extract a shared `graphMessage(data)` builder returning the ROOT Graph message resource `{subject, body:{contentType, content}, toRecipients, ccRecipients?, bccRecipients?}` from `outlook_mail_send`'s inline code (it has `to, subject, body, contentType, cc` today — `bcc` is new and optional). `outlook_mail_send` keeps sending `{message: graphMessage(data), saveToSentItems: true}` to `/me/sendMail` (behaviour unchanged, its tests unedited).
- `outlook_draft_create {to headerLine 1..2000, subject headerLine 1..500, body 1..1000000, contentType? text|html, cc?, bcc?}` → POST `/me/messages` with `graphMessage(data)` as the body itself (201); returns the created draft's `{ id, webLink }`; `mutates "outlook.draft.create"`, `recoverable: true`, scope `recipient:p.to`; registered through the connector's write registrar + `outlookToolShouldRegister`.
- Add `outlook_draft_create: ["Mail.ReadWrite"]` to the static `OUTLOOK_TOOL_MIN_SCOPES` declaration in `tool-scope-policy.ts` (it is a non-exported readonly literal). Tests MUST be negative too: `outlookToolAllowed("outlook_draft_create", ["Mail.Send"])` and `(["Mail.Read"])` are false, `(["Mail.ReadWrite"])` true.

### T5: Discord (`connectors/discord/src/{tools,server}.ts`, `nimbus.extension.json`, `README.md`)
- Manifest `hitlRequired: ["write"]`; `server.ts` `capabilities: CONSENT_SERVER_CAPABILITIES` and instructions like GitHub's; `registerDiscordTools(server: ConsentServer & {...})`; `DISCORD_TOOL_NAMES`; registrar `createWriteToolRegistrar(server, { connector: "discord", scopeEnv: "NIMBUS_MCP_DISCORD_WRITE_SCOPE", scopeKinds: ["channel"] })`.
- `discord_message_post {channelId /^\d{17,20}$/, content 1..2000}` → POST `/channels/{id}/messages` with `Content-Type: application/json` (the existing `discordFetch` sets none) and body `{content, allowed_mentions: {parse: ["users"]}}` (owner ruling: user mentions only); returns `{ id, channelId }`; `mutates "discord.message.post"`, scope `channel:<id>`; description says it posts as the bot. `DISCORD_TOOL_NAMES` lists the four existing reads plus the new write.
- Tests set the connector mode; update `standalone/src/launcher.test.ts` (the "discord over-declared" block: Discord now `reason: "hardened"`, and the eligibility count test), `docs/standalone-launcher.md` (57 / 37), and add `discord` to `WRITES` in `scripts/connector-write-scope.test.ts` (its `registersWrites` check fails otherwise).

### T6: Confluence (`connectors/confluence/src/tools.ts`)
- `confluence_page_append {pageId, storageHtml 1..65000}`: the retry loop lives in the HANDLER (the connector's fetch helper returns `{ok, status, text}` without throwing): GET `/content/{id}?expand=body.storage,version` → `oldHtml = body?.storage?.value ?? ""` → PUT version+1 with `oldHtml + storageHtml` (type and title from the GET); on a 409 re-read and retry once; only the final attempt's response goes through the success/error formatter; a second 409 throws "page changed concurrently; nothing appended". Returns `{ ok: true, pageId, version }`. `mutates "confluence.page.append"`, scope `page:<id>`, `recoverable: true` (Confluence keeps page history), NO `capturePreState` (a pre-state taken before a retry would describe a version that was not the one changed). Never touches `confluence_kb_append`. Tests: GET then PUT; version bump; concatenation; empty body; 409 then success; 409 twice → throw with exactly one PUT per attempt; missing credentials send nothing. End-to-end test against a fake server via `CONFLUENCE_BASE_URL`.

### T7: Docs
`docs/configuration.md` (`GITHUB_API_BASE_URL`, Discord `channel:` scope kind), connector READMEs (GitHub GHES, Discord bot + write scope), any count doc the gates name.

## Delivery
One PR per task group or a single PR (builder's call by size), each green on the repo's CI with threads resolved, auto-merge. After all merge, release-please opens `chore(main): release connectors 0.4.0` — leave it for the owner, and say so.
