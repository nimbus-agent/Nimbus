# Connector Writes A1 — One Write Manifest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the three hand-kept write classifications (`WAREHOUSE_BI_WRITES`, `GITOPS_ML_WRITES`, `MIGRATED_WRITE_TOOL_IDS`) with one table of rows (tool id, gateway action type, transport, wave), checked against a manifest generated from the installed connectors package, and derive the D20 static rule from it. No runtime behaviour changes, apart from one new frozen-set type.

**Architecture:** A hand-written row per write lives in `packages/gateway/src/connectors/connector-writes/<group>.ts`. `connector-writes/index.ts` concatenates them. `connector-write-registry.ts` keeps its public surface (`isConnectorWriteToolId`, `connectorWriteByActionType`, `CONNECTOR_WRITES`) but derives it from the rows. A script, `scripts/gen-connector-write-manifest.ts`, runs the existing fail-closed scanner (`connectors/testing/connector-write-registrations.ts`) and writes `connector-writes/manifest.generated.ts`, which lists `{ toolId, connector }` for every registered write. A test regenerates that file in memory and fails on drift. D20's regex is built from the rows instead of being spelled by hand.

**Tech Stack:** Bun, TypeScript strict, `bun:test`, the structure-audit scripts.

**Spec:** `docs/superpowers/specs/2026-11-04-connector-writes-design.md` (branch `dev/asaf/connector-writes-spec`), § 5.1 and § 10 (A1).

## Global Constraints

- Branch from `origin/main`, never from the spec branch. This plan and the spec never land on `main`.
- No behaviour change. Every tool id `isConnectorWriteToolId` refuses today is still refused, bare and `<server>_<tool>`. The 18 `write`-transport rows keep their action type, tool id and service exactly. The only addition is the frozen-set type `google_drive.file.trash`, for the one write the scanner cannot see.
- `HITL_REQUIRED_BACKING` stays a hand-written literal in `engine/executor.ts` (I2). Rows are checked against it; they never feed it.
- The four gate-confined ids (`slack_chat_post`, `teams_chat_post`, `notion_kb_append`, `confluence_kb_append`) are never spelled outside their gates (D17/D19). They get no rows. The generator drops them by importing `CHATOPS_POST_TOOL_IDS` and `TRIBAL_KB_WRITE_TOOL_IDS`, and the registry keeps refusing them through those sets.
- The gateway runtime never imports `@nimbus-dev/connectors` or the scanner. Only the script and the tests do.
- No comparator-less `.sort()` (Sonar S2871). Use `.sort((a, b) => a.localeCompare(b))` or `toSorted` with a comparator.
- No `any`. External data is `unknown`.
- Before every push, run `bun run preflight:fast`, `bun run typecheck:tests`, `bun run audit:invariants` and `bun run audit:doc-refs`.
- Commit trailers: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01JmSjrEwpdoFU8rCxeon9x9`.

## Rulings this plan makes (beyond the spec)

- **R1 — No `mutates` in the manifest.** The scanner can read a literal `mutates` at only 74 of the 91 call sites; forwarders, loops and templates hide the rest. So the manifest records `{ toolId, connector }`, and the row's `actionType` is authoritative (spec: "the gateway's action type wins"). A test still checks every call site whose `mutates` is a plain literal against its row; mismatches today: none.
- **R2 — No input-schema hash in A1.** A schema exists only on a running server (spec § 5.2), so the hash and its drift check move to A5, the first consumer.
- **R3 — `slack_message_post_dm` maps to `slack.message.post`.** That is what the connector declares, and it is in the frozen set. The spec's "no frozen-set type" example was wrong; `gdrive_file_trash` is the only write with no type.
- **R4 — Action types are unique among `write`-transport rows only.** `connectorWriteByActionType` routes by type. `mesh` rows dispatch by `payload.mcpToolId` and may share a type, as `slack_message_post` and `slack_message_post_dm` do.
- **R5 — Waves.** The table below assigns every row a wave. The spec does not place mail send, calendar, files, VCS merges or cloud operations; this plan does, and the Wave 3/4 design rounds may move them. The wave is inert until A5.
- **R6 — No model-offerable flag yet.** It and the preview template arrive with A2 and A5, the PRs that read them.

## Review Focus

1. **A namespaced id a federated peer sends** (`aws_aws_ec2_instance_stop`, `github_actions_gha_run_trigger`) must still be refused. Task 1 pins every row's namespaced form.
2. **`gdrive_file_trash` disappearing when `MIGRATED_WRITE_TOOL_IDS` is deleted.** Task 1 pins it as refused and as a `registeredAs: "read"` row. Task 2 fails once upstream starts registering it as a write, so the overlay can never go stale silently.
3. **A connectors bump that adds a write.** Task 2's row-totality test fails, and its message names the group files.
4. **D20 going quiet on the 70 newly covered ids.** Task 3 red-proves one migrated id (`jira_issue_create`) outside an allowed site.
5. **A gate-confined id leaking into the generated file** (which would break D17/D19). Task 2 asserts the generated text contains none of the four.

---

### Task 1: The row table, and the registry derived from it

**Files:**
- Create: `packages/gateway/src/connectors/connector-writes/types.ts`
- Create the following group files under `packages/gateway/src/connectors/connector-writes/`: `messaging.ts`, `tickets.ts`, `knowledge.ts`, `mail-calendar.ts`, `files.ts`, `vcs-ci.ts`, `incident.ts`, `cloud-infra.ts`, `warehouse-bi.ts`, `gitops-ml.ts`, and `index.ts`
- Modify: `packages/gateway/src/connectors/connector-write-registry.ts`, `packages/gateway/src/connectors/connector-write.ts`, `packages/gateway/src/engine/executor.ts` (frozen set, and the comments at lines ~172 and ~186), `packages/gateway/src/connectors/proposable-actions.ts` (`denied("file", …)`)
- Delete: `connectors/warehouse-write-tools.ts`, `connectors/gitops-ml-write-tools.ts`, `connectors/connector-write-tool-ids.ts`, and the tests `warehouse-write-tools.test.ts` and `gitops-ml-write-tools.test.ts`. Move each assertion they hold that is still meaningful into the new test.
- Test: `packages/gateway/src/connectors/connector-writes/rows.test.ts`.
- Update the callers of the deleted modules (from `git grep`; `ipc/federation-rpc-invoke.test.ts` and `session-tool-resolution.integration.test.ts` import only `CONNECTOR_WRITES`, which stays, so they need no change):
  - `connector-write-registry.test.ts`: drop its `MIGRATED_WRITE_TOOL_IDS` and group-SSoT imports, and assert over `CONNECTOR_WRITE_ROWS` instead.
  - `share/read-tool-registry.test.ts`: replace `WAREHOUSE_BI_WRITE_TOOL_IDS` with `CONNECTOR_WRITES.map((w) => w.toolId)` imported from `../connectors/connector-write-registry.ts`.
  - `connector-write-sync.test.ts`: in the share-replay test, replace `MIGRATED_WRITE_TOOL_IDS` with `CONNECTOR_WRITE_ROWS.map((r) => r.toolId)`, and point the first test's failure message at the group files. This must happen in this task, or Step 4's run fails on the import.

**Interfaces:**
- Produces, in `types.ts`:
  ```ts
  export type ConnectorWriteTransport = "write" | "mesh";
  export type ConnectorWriteWave = 2 | 3 | 4;
  export interface ConnectorWriteRow {
    readonly toolId: string;
    readonly actionType: string;
    readonly transport: ConnectorWriteTransport;
    readonly wave: ConnectorWriteWave;
    /** Set only for a tool that mutates while upstream registers it as a READ (invisible to the scanner). */
    readonly registeredAs?: "read";
  }
  ```
  Also a one-line builder `row(toolId, actionType, transport, wave, registeredAs?)` that returns a frozen row. **Its argument order is the reverse of the deleted `w(actionType, toolId, service)`**: porting `w("snowflake.tag.set", "snowflake_tag_set", "snowflake")` gives `row("snowflake_tag_set", "snowflake.tag.set", "write", 4)`. The 18-row test in Step 1 catches a swap.
- Produces, in `index.ts`: `export const CONNECTOR_WRITE_ROWS: readonly ConnectorWriteRow[]`, the concatenation of the group files in the order listed above.
- `connector-write-registry.ts` keeps its exports and signatures, plus one new export:
  - `CONNECTOR_WRITES: readonly ConnectorWrite[]` is the rows with `transport === "write"`, each mapped to `{ actionType, toolId, service: serviceOf(actionType) }`.
  - `isConnectorWriteToolId(toolId)` keeps today's semantics, over the row ids ∪ the gate-confined sets.
  - `connectorWriteByActionType(actionType)` searches `write` rows only.
  - New: `connectorWriteRowByToolId(toolId: string): ConnectorWriteRow | undefined`.
  - Remove the `MIGRATED_WRITE_TOOL_IDS` re-export.
- `connector-write.ts` keeps `ConnectorWrite`; delete the `w` builder.

**The table.** Every row, by file, as `toolId → actionType (transport, wave)`:

- `messaging.ts`:
  - `slack_message_post → slack.message.post (mesh, 2)`
  - `slack_message_post_dm → slack.message.post (mesh, 2)`
  - `teams_message_post → teams.message.post (mesh, 2)`
  - `teams_message_post_chat → teams.message.postChat (mesh, 2)`
- `tickets.ts`, all `mesh, 2`:
  - `jira_issue_create → jira.issue.create`
  - `jira_issue_update → jira.issue.update`
  - `jira_comment_add → jira.comment.add`
  - `linear_issue_create → linear.issue.create`
  - `linear_issue_update → linear.issue.update`
  - `linear_comment_create → linear.comment.create`
  - `github_issue_create → github.issue.create`
- `knowledge.ts`, all `mesh, 2`:
  - `notion_page_create → notion.page.create`
  - `notion_page_update → notion.page.update`
  - `notion_block_append → notion.block.append`
  - `notion_comment_create → notion.comment.create`
  - `confluence_page_create → confluence.page.create`
  - `confluence_page_update → confluence.page.update`
  - `confluence_comment_add → confluence.comment.add`
  - `obsidian_append_to_daily_note → obsidian.note.append`
- `mail-calendar.ts`, all `mesh`:
  - Wave 2:
    - `gmail_draft_create → gmail.draft.create`
    - `apple_mail_draft_create → apple.mail.draft.create`
    - `outlook_calendar_create → outlook.calendar.create`
    - `apple_calendar_event_create → apple.calendar.event.create`
  - Wave 3:
    - `outlook_calendar_delete → outlook.calendar.delete`
    - `apple_calendar_event_delete → apple.calendar.event.delete`
    - `gmail_draft_send → gmail.draft.send`
    - `gmail_message_send → gmail.message.send`
    - `outlook_mail_send → outlook.mail.send`
    - `fastmail_mail_send → fastmail.mail.send`
    - `imap_mail_send → imap.mail.send`
    - `protonmail_mail_send → protonmail.mail.send`
    - `apple_mail_send → apple.mail.send`
- `files.ts`, all `mesh`:
  - `gdrive_file_create → google_drive.file.create (2)`
  - `gdrive_file_move → google_drive.file.move (3)`
  - `gdrive_file_rename → google_drive.file.rename (3)`
  - `gdrive_file_trash → google_drive.file.trash (3, registeredAs "read")`
  - `onedrive_item_move → onedrive.item.move (3)`
  - `onedrive_item_delete → onedrive.item.delete (4)`
- `vcs-ci.ts`, all `mesh`:
  - Wave 3:
    - `github_pr_merge → github.pr.merge`
    - `github_pr_close → github.pr.close`
    - `github_branch_delete → github.branch.delete`
    - `github_tag_create → github.tag.create`
    - `gitlab_mr_merge → gitlab.mr.merge`
    - `bitbucket_pr_merge → bitbucket.pr.merge`
  - Wave 4:
    - `jenkins_build_trigger → jenkins.build.trigger`
    - `jenkins_build_abort → jenkins.build.abort`
    - `gha_run_trigger → github_actions.run.trigger`
    - `gha_run_cancel → github_actions.run.cancel`
    - `circleci_pipeline_trigger → circleci.pipeline.trigger`
    - `circleci_job_cancel → circleci.job.cancel`
    - `gitlab_pipeline_retry → gitlab.pipeline.retry`
    - `gitlab_pipeline_cancel → gitlab.pipeline.cancel`
- `incident.ts`, all `mesh, 3`:
  - `pd_incident_acknowledge → pagerduty.incident.acknowledge`
  - `pd_incident_resolve → pagerduty.incident.resolve`
  - `pd_incident_escalate → pagerduty.incident.escalate`
- `cloud-infra.ts`, all `mesh, 4`:
  - `aws_ecs_service_update → aws.ecs.service.update`
  - `aws_lambda_invoke → aws.lambda.invoke`
  - `aws_ec2_instance_stop → aws.ec2.instance.stop`
  - `aws_ec2_instance_start → aws.ec2.instance.start`
  - `azure_app_service_restart → azure.app_service.restart`
  - `azure_aks_node_pool_scale → azure.aks.node_pool.scale`
  - `gcp_cloud_run_deploy → gcp.cloud_run.deploy`
  - `gcp_gke_workload_restart → gcp.gke.workload.restart`
  - `k8s_rollout_restart → kubernetes.rollout.restart`
  - `k8s_deployment_scale → kubernetes.deployment.scale`
  - `k8s_pod_delete → kubernetes.pod.delete`
  - `iac_terraform_apply → iac.terraform.apply`
  - `iac_terraform_destroy → iac.terraform.destroy`
  - `iac_cloudformation_deploy → iac.cloudformation.deploy`
  - `iac_pulumi_up → iac.pulumi.up`
- `warehouse-bi.ts`, all `write, 4`: today's 12 `WAREHOUSE_BI_WRITES` rows, with the same action types and tool ids.
- `gitops-ml.ts`, all `write, 4`: today's 6 `GITOPS_ML_WRITES` rows, with the same action types and tool ids.

That makes 88 rows: 70 `mesh` and 18 `write`.

- [ ] **Step 1: Write the failing tests** in `connector-writes/rows.test.ts`:
  - `"88 rows, unique tool ids"`: `CONNECTOR_WRITE_ROWS.length === 88`, and the set of `toolId`s has size 88.
  - `"every row's action type is in the HITL frozen set"`: `CONNECTOR_WRITE_ROWS.filter(r => !HITL_REQUIRED.has(r.actionType))` equals `[]`.
  - `"write-transport rows are exactly today's 18, unchanged"`: `CONNECTOR_WRITES` mapped to `` `${actionType} ${toolId} ${service}` `` and sorted equals the 18 strings spelled out in the test (copy them from today's two SSoT files before deleting them, e.g. `"snowflake.tag.set snowflake_tag_set snowflake"`, `"montecarlo.incident.acknowledge montecarlo_incident_acknowledge montecarlo"`).
  - `"action types are unique among write rows"`.
  - `"every row is refused, bare and namespaced"`: for each row, `isConnectorWriteToolId(r.toolId)` is true, and so is `isConnectorWriteToolId(\`${server}_${r.toolId}\`)`, where `server` is `serviceOf(r.actionType)`. Also assert the two literals `"aws_aws_ec2_instance_stop"` and `"github_actions_gha_run_trigger"` directly, so a loop that builds the key wrongly cannot pass on its own output.
  - `"gate-confined ids stay refused through their gates"`: every id in `CHATOPS_POST_TOOL_IDS` and `TRIBAL_KB_WRITE_TOOL_IDS` is refused, and none of them is a row `toolId`.
  - `"gdrive_file_trash is a read-registered write"`: `connectorWriteRowByToolId("gdrive_file_trash")` deep-equals `{ toolId: "gdrive_file_trash", actionType: "google_drive.file.trash", transport: "mesh", wave: 3, registeredAs: "read" }`, and `HITL_REQUIRED.has("google_drive.file.trash")` is true.
  - `"no behaviour change: every id refused before A1 is refused after"`: a literal list of the 88 ids (today's `MIGRATED_WRITE_TOOL_IDS` plus the 18) all return true.

- [ ] **Step 2: Run, expect FAIL.** Run `bun test packages/gateway/src/connectors/connector-writes`. It fails because the module is missing. Once the rows exist, `"every row's action type is in the HITL frozen set"` and the `gdrive_file_trash` test keep failing until Step 3 adds `google_drive.file.trash` to the executor.

- [ ] **Step 3: Implement** `types.ts`, the group files (one `row(...)` call per row, exactly as in the table), `index.ts`, the new `connector-write-registry.ts` derivation, `"google_drive.file.trash"` added to `HITL_REQUIRED_BACKING` beside `google_drive.file.rename`, and `"google_drive.file.trash"` added to `denied("file", …)` in `proposable-actions.ts`.
  - Keep `LONGEST_WRITE_TOOL_ID` computed over the row ids ∪ the gate sets, and keep the `matchesBareOrNamespacedToolId` call unchanged.
  - Rewrite the executor comments so they point at `connectors/connector-writes/` and `rows.test.ts`.
  - Delete the three old modules, port their tests, and update the callers listed under Files.

- [ ] **Step 4: Run** `bun test packages/gateway/src/connectors packages/gateway/src/engine/executor.test.ts packages/gateway/src/security-invariants.test.ts packages/gateway/src/share packages/gateway/src/ipc/federation-rpc-invoke.test.ts packages/gateway/src/mcp-sink`. Expected: PASS, including `proposable-actions.test.ts`, whose totality test fails if the new type is left unclassified. Then run `bun run typecheck`.

- [ ] **Step 5: Commit.** Message: `refactor(connectors): one row table for every connector write`.

### Task 2: The generated manifest and the sync guard

**Files:**
- Create: `scripts/gen-connector-write-manifest.ts`, and a `gen:connector-write-manifest` entry in the root `package.json` `scripts`
- Create (generated, committed): `packages/gateway/src/connectors/connector-writes/manifest.generated.ts`
- Test: `packages/gateway/src/connectors/connector-writes/manifest.sync.test.ts`

**Interfaces:**
- Consumes `CONNECTOR_WRITE_ROWS` and `connectorWriteRowByToolId` from Task 1, and `installedConnectorsPackageRoot`, `readConnectorPackageSources` and `scanWriteToolRegistrations` from `connectors/testing/connector-write-registrations.ts`.
- Produces, in `manifest.generated.ts`:
  ```ts
  export interface ConnectorWriteRegistration { readonly toolId: string; readonly connector: string }
  export const CONNECTOR_WRITE_MANIFEST: readonly ConnectorWriteRegistration[];
  ```
  `connector` is the package directory id (`r.origin.split("/")[1]`, e.g. `monte-carlo`). Entries are sorted by `toolId` (`localeCompare`), and the four gate-confined ids are dropped.
- Produces, exported from the script: `renderConnectorWriteManifest(scan: WriteToolScan): string`. It is a pure function returning the file's full text: a header comment naming the script and saying "do not edit", then the interface, then the array, formatted the way Biome would leave it, so `bun run lint` passes on the committed file. It throws when `scan.violations` is non-empty.

- [ ] **Step 1: Write the failing tests** in `manifest.sync.test.ts`:
  - `"the committed manifest is what the generator produces from the installed package"`: `readFileSync(manifest.generated.ts)` (with `\r\n` normalised) equals `renderConnectorWriteManifest(scanWriteToolRegistrations(readConnectorPackageSources(installedConnectorsPackageRoot())))`. The message names `bun run gen:connector-write-manifest`.
  - `"no gate-confined id is spelled in the generated file"`: the file text contains none of the ids in `CHATOPS_POST_TOOL_IDS` ∪ `TRIBAL_KB_WRITE_TOOL_IDS` (compare against the imported sets, never against literals).
  - `"every registered write has a row"`: manifest ids missing from the rows equal `[]`. The message reads: "classify it in packages/gateway/src/connectors/connector-writes/<group>.ts".
  - `"every row not marked registeredAs read names a registered write"`: such rows' ids that are not in the manifest equal `[]`.
  - `"every registeredAs-read row is still registered as a read"`: `registeredAs` rows whose id IS in the manifest equal `[]`. The message reads: "upstream now registers it as a write: drop registeredAs".
  - `"a literal mutates agrees with the row"`: for each scan registration that has a row (the four gate-confined ids have none: skip anything in `CHATOPS_POST_TOOL_IDS` or `TRIBAL_KB_WRITE_TOOL_IDS`, and fail on any OTHER registration with no row) whose call text (from `r.span` over `stripComments(file text)`) holds `mutates: "<literal>"` with no `${`, that literal equals the row's `actionType`. Expected mismatches: `[]`.
  - `"the manifest's size is plausible"`: `CONNECTOR_WRITE_MANIFEST.length >= 80`.

- [ ] **Step 2: Run, expect FAIL.** Run `bun test packages/gateway/src/connectors/connector-writes/manifest.sync.test.ts`. It fails because the script and the generated file are missing.

- [ ] **Step 3: Implement** the script. Its `main` runs the scan, writes the file and prints the count. Then run `bun run gen:connector-write-manifest` and commit the output.
  - `connector-write-sync.test.ts` was already updated in Task 1. Leave it as it is.

- [ ] **Step 4: Run** `bun test packages/gateway/src/connectors`. Expected: PASS. Then run `bun run lint` on the generated file (`bunx biome check packages/gateway/src/connectors/connector-writes`).

- [ ] **Step 5: Commit.** Message: `feat(connectors): generate the connector write manifest from the installed package`.

### Task 3: D20 derived from the rows

**Files:**
- Modify: `scripts/structure-audit/check-nimbus-invariants.ts` (`CONNECTOR_WRITE_ALLOWED`, `CONNECTOR_WRITE_RE`)
- Test: `scripts/structure-audit/check-nimbus-invariants.test.ts`, the `D20 — connector write-id confinement` describe

**Interfaces:**
- Consumes `CONNECTOR_WRITE_ROWS` from `packages/gateway/src/connectors/connector-writes/index.ts`. The audit already imports gateway source; import only `index.ts`, never the registry, which pulls in the ChatOps and tribal gates.
- The regex: `new RegExp(String.raw\`\b(?:${ids.join("|")})\b\`)`, where `ids` are the row tool ids, each checked against `/^[a-z0-9_]+$/` before joining. Throw on any that fails, so a malformed id cannot widen the regex.
- The allowed-site check today is exact equality (`CONNECTOR_WRITE_ALLOWED.some((p) => f.relPath === p)`). Change it to `f.relPath === p || (p.endsWith("/") && f.relPath.startsWith(p))`, the same shape D17 uses.
- New allowed sites:
  - `packages/gateway/src/connectors/connector-writes/` (the trailing slash makes it a prefix)
  - `packages/gateway/src/connectors/connector-write-transport.ts`
  - `packages/gateway/src/connectors/connector-write-dispatch.ts`
  - `packages/gateway/src/connectors/proposable-actions.ts` (the act door's routing table spells tool ids)
  - `packages/gateway/src/connectors/connector-code-execution-tool-ids.ts` (it spells the IaC ids for a different classification)

  Before finalising the list, run `audit:invariants` and confirm that no other non-test file is flagged. Any other hit is a finding to report, not a site to add.

- [ ] **Step 1: Write the failing tests:**
  - `"a migrated write id outside the allowed sites is a D20 violation"`: a `FileEntry` at `packages/gateway/src/agents/x.ts` whose contents name `jira_issue_create` yields one `D20-connector-write` violation. This red-proves the newly covered 70.
  - `"proposable-actions.ts may name write ids"`: the same contents at that path yield none.
  - `"a file under connector-writes/ may name write ids"`.
  - Re-point the two existing tests whose `relPath` names a deleted module (`"does NOT flag the gitops-ml SSoT module"` with `gitops-ml-write-tools.ts`, and `"allows the SSoT, connector servers, and transport/dispatch sites"` with `warehouse-write-tools.ts`) at `connectors/connector-writes/gitops-ml.ts` and `connectors/connector-writes/warehouse-bi.ts`. Add one test asserting the deleted path `connectors/warehouse-write-tools.ts` is now flagged.
  - Keep every other existing D20 test. Rename the describe to `D20 — connector write-id confinement (every row in connectors/connector-writes)`.

- [ ] **Step 2: Run, expect FAIL.** Run `bun test scripts/structure-audit/check-nimbus-invariants.test.ts -t D20`. The first new test fails against the old regex.

- [ ] **Step 3: Implement** the derivation, and update the D20 comment block so it describes the derived rule and the five allowed sites.

- [ ] **Step 4: Run** `bun test scripts/structure-audit/check-nimbus-invariants.test.ts` and `bun run audit:invariants`. Expected: PASS, exit 0.

- [ ] **Step 5: Commit.** Message: `feat(audit): derive the D20 write-id rule from the write rows`.

### Task 4: Docs under the triple rule

**Files:**
- Modify: `docs/SECURITY-INVARIANTS.md` (the I26 section and every path to a deleted module), `CLAUDE.md` and `GEMINI.md` (the I26 line: wiring site `connectors/connector-writes/`), `docs/roadmap.md` (Phase 9.7), `docs/CHANGELOG.md` (an Unreleased entry), and any `.claude/commands/nimbus-*.md` that `audit:doc-refs` flags

- [ ] **Step 1:** In SECURITY-INVARIANTS I26:
  - Change the Statement so it covers every connector write, not only warehouse/BI and GitOps/ML.
  - Change "Enforcement" to name `connector-writes/rows.test.ts` and `manifest.sync.test.ts`.
  - Add `gdrive_file_trash` as the `registeredAs: "read"` overlay.
  - Change "How to comply" to "add a row in the group file; run `bun run gen:connector-write-manifest`".
  - Describe D20 as derived from the rows, with the five allowed sites.
- [ ] **Step 2:** In the roadmap's Phase 9.7 Goal, replace "only a handful can write (Looker datagroup/schedule triggers, ArgoCD `app_sync`, Flux, MLflow)" with the fact: 88 write tools in 33 connectors are classified and HITL-gated, the model is offered none, and dispatch through the credential-aware transport covers 18. Tick the Wave 1 row "Generalized connector-write contract", with a pointer to the PR. Leave the other Wave 1 rows unticked.
- [ ] **Step 3:** Add a CHANGELOG Unreleased entry saying one write table and a generated manifest replace three hand-kept lists, D20 now covers every write id, and `google_drive.file.trash` is gated. Never edit an earlier entry. If `audit:doc-refs` flags a deleted path inside an earlier entry, check how the audit treats CHANGELOG history, and follow that precedent.
- [ ] **Step 4: Run** `bun run audit:doc-refs`, `bun run audit:status-drift`, `bun run preflight:fast` and `bun run typecheck:tests`. Expected: all pass.
- [ ] **Step 5: Commit.** Message: `docs: I26 and Phase 9.7 describe the one write table`.

## PR

- Title: `refactor(connectors): one generated manifest and row table for every connector write`. This is not breaking, and it needs no `!`.
- Body:
  - what replaced what;
  - the one new frozen-set type;
  - D20's widened coverage;
  - rulings R1–R6;
  - the test list;
  - the attribution lines;
  - no unbalanced `(`.
- Open with auto-merge (`gh pr merge --squash --auto`), then resolve every review thread.
