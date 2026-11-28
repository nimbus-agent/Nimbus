# Phase 7, the remaining cost sources and the flag join (slices 9 to 15): design

Status: owner-approved design conversation (2026-11-28). Owner instruction: Antigravity reviews this design. Parent spec: `2026-11-26-phase7-cost-pack-design.md` (same branch). This document adds slices 9 to 15. Every rule of the parent spec and of slices 1 to 8 still applies unless this document says otherwise.

## 1. Intent

Phase 7 ends when a DevOps lead or director can see product cost and internal CI and dev-environment cost from every source they run, and can set a cost change beside the deploys, pull requests, **flag changes** and owners around it (parent spec, audience ruling 2026-11-26). Slices 1 to 8 shipped FOCUS file import, allocation rules, the briefs, reports and their delivery, the bundled `finops` pack, and four API sources: GitHub billing, OpenAI, Anthropic and GitLab compute minutes. What is left:

- **Two CI sources:** Bitbucket Pipelines and Jenkins.
- **Three clouds' billing, pulled without a manual file download:** AWS, Azure and GCP.
- **The flag half of the cost-to-change join.**

The owner wants all of them designed now, so they can be built in parallel lanes or in order without stopping for more design questions.

**Goals.**
- Each source lands as `cost_line` rows through the bound intake (D24 `cost-line-confined`).
- Every source shows in each cost view's freshness, with its gaps and its unpriced quantity.
- `nimbus cost why` lists the bound flags that changed in the period.

**Non-goals.**
- Revenue (Phase 14).
- Cost in the approval preview (Phase 8).
- Deleting wasted resources (Phase 13).
- A GCP FOCUS export (a roadmap row, waiting for Google's general availability).
- Live verification against real accounts. As in slices 5 to 8, the API shapes are verified from documentation only, and the docs say so.

**Anti-goals.** Any of these makes a slice a failure, even if it works:
- **Spending the owner's money without their choice.** No paid API call happens unless the owner opted in.
- **Silently counting the same cost twice.** This covers two sources for one provider, a project listed under two groups, and a job seen on two pages.
- **Clearing a stored month** because a read was partial, malformed or empty.
- **Sending a credential anywhere but its own service's host.** That means same origin, https only (http only to loopback), and no credential in logs.

## 2. Owner decisions (2026-11-28)

| # | Decision |
| --- | --- |
| D1 | **CI money comes from a configured rate.** Lines always carry the minutes. With no rate, they are stored unpriced (V110) and every view names them. (Ruled for slice 8; it applies to Bitbucket and Jenkins too.) |
| D2 | **Order: CI first.** Bitbucket, Jenkins, then the clouds. |
| D3 | **Clouds: both paths.** Each cloud's own export is the main path, read by the sync. Each cloud's cost API is a fallback, used only when no export is configured. |
| D4 | **Jenkins: a configured rate per agent or label first.** Pricing builds from the cloud machine cost of their agents is a later slice (15), kept in Phase 7. |
| D5 | **Bitbucket: the connector moves to Atlassian API tokens in the same slice.** App passwords stopped working after 2026-07-28. Add `bitbucket.email` and `bitbucket.api_token`, keep reading `bitbucket.username` and `bitbucket.app_password` as a fallback, and update `nimbus connector auth bitbucket` and the docs. |
| D6 | **GCP: the generally available standard or detailed BigQuery billing export now.** The FOCUS export (preview) becomes a roadmap row for when Google makes it generally available. GCP has no cost API, so "fallback" means reading the standard table when no detailed table exists. |
| D7 | **AWS Cost Explorer ($0.01 per request) is opt-in:** `[cost.aws] cost_explorer = true`. The price is stated in the docs. Without it and without an export, AWS shows a stated gap. |

## 3. Builder's calls (stated in the conversation; the owner did not object)

| # | Call | Why |
| --- | --- | --- |
| C1 | **Lanes.** CI: 9, then 10. Cloud: 11a, 11b, 12a, 12b, 13. Flag: 14. Last: 15. One PR per item, each from `origin/main`. The status docs (roadmap, CLAUDE.md, GEMINI.md) are updated in the last PR of each lane; CHANGELOG and cli-reference in every PR. | The lanes share only config, catalog and docs files; merging one after another keeps conflicts small. |
| C2 | **Azure's Query API fallback is on by default.** | It is free and only rate-limited. |
| C3 | **GCP queries always filter on the partition column** (`_PARTITIONTIME` or `usage_start_time`, the builder checks which the table offers) and on the month read. The docs say BigQuery bills the bytes scanned. | It keeps the owner's BigQuery cost small. |
| C4 | **Overlap rule:** when two raw sources cover one provider (a `[cost.focus] dir` import AND a cloud sync) and `[cost] authoritative` does not name one, the views use the cloud sync and list the file import as set aside, with the reason. | The existing rule only sets Vantage aside; two raw sources would be added together. |
| C5 | **Flag join covers all four flag services** (LaunchDarkly, Unleash, Split, Flagsmith). A bound flag is listed when its last change falls in the period, and the brief says only the latest change is known. | The index keeps no flag history (no `item_history` for flags). |
| C6 | **Bitbucket's size multiplier and self-hosted runners are unverified.** The docs state how the sync reads them: `build_seconds_used` taken as billed seconds, and pipelines on self-hosted runners skipped when the API marks them. | The docs check could not confirm either point. |
| C7 | **Each cloud path is reached through the access the gateway already uses.** AWS goes through the AWS CLI (`connectors/_lib/aws-cli.ts`: `aws s3`, `aws ce`); Azure through its existing `az`/token path (`connectors/azure-sync.ts`); GCP through BigQuery REST with the `gcloud` token (`connectors/_lib/gcp-auth.ts`, as `bigquery-sync.ts` does). | No new SDK, and the I1/I15 spawn rules already cover these paths. |

## 4. What every slice shares

- **The sync shape (slices 5, 6 and 8).**
  - Each source is a syncable service with its own id: `bitbucket_billing`, `jenkins_billing`, `aws_billing`, `azure_billing`, `gcp_billing`.
  - It uses a shared-credential grant on its connector, and a cursor in `finops/cost-source-gaps.ts` with its own prefix (never changed once chosen).
  - It runs the month loop from `connectors/cost-month-sync.ts`.
  - It writes only through `replaceCostLinesForMonth`, and is added to `COST_SYNC_SERVICES` (`sync/cost-sync-capabilities.ts`) and to the D24 docs paragraph in the same commit.
  - It is wired into the catalog, the configured check, the boot companion, the removal path and `connectors/finops-syncables.ts`.
- **Data integrity (the slice 5 to 8 lessons, binding for every slice).**
  - A read that is malformed, capped, partial or empty never clears a stored month. It becomes a retry or a `month_gap`.
  - Rows are deduplicated across offset pages by their id.
  - A stored sub-account missing from a fresh listing keeps its lines.
  - Identities are stable ids, never paths or names.
  - A pagination cursor must advance.
  - An unreadable config keeps the cursor whole.
  - Test fakes return a field only when the request asks for it.
- **Transport.**
  - Requests go to the configured origin only (`fetchSameOriginOnly` or the CLI's own endpoint).
  - https only, with http allowed only to loopback.
  - A refused redirect is a stated gap.
  - 429 penalises that service's limiter; a 5xx retries.
- **Pricing (CI sources).** Prices come from `finops/cost-rate-price.ts`.
  - Each line carries a `rate_key` tag; a changed rate re-prices the stored lines through `repriceOwnCostLines`, and the cursor records the rate fingerprint.
  - With no rate, a line is unpriced at cost 0 with `priced` 0, and the freshness row names it with the config key that would price it (`finops/cost-unpriced.ts` `COST_RATE_CONFIG_HINT`).
- **Docs in every PR.** CHANGELOG, cli-reference (a section, config rows and stated bounds), architecture, and the `nimbus-file-map` row. Each new connector auth surface also updates `docs/connectors/*` where one exists.

## 5. The slices

### Slice 9: Bitbucket Pipelines minutes, and the connector on API tokens

- **Connector.**
  - The secrets manifest adds `bitbucket.email` and `bitbucket.api_token`.
  - The connector's sync and fetch read the new pair first and fall back to `username` and `app_password`. Basic auth uses `email:api_token`.
  - `nimbus connector auth bitbucket` asks for the email and the API token.
  - Status names which pair is in use. The old pair shows as deprecated ("Atlassian removed app passwords on 2026-07-28; store an API token").
  - The credential probe tries the new pair.
- **Config.** `[cost.bitbucket] workspaces` (workspace slugs), `rate_per_minute`, `currency`, and `size_rates` keyed by step size (`1x`, `2x`, `4x`, `8x`, `16x`, `24x`, `32x`), which applies when the builder can read a step's size.
- **Source.**
  - Per workspace: list its repositories (`GET /repositories/{workspace}`, paged).
  - Then per repository: list its pipelines (`GET /repositories/{workspace}/{repo}/pipelines`) newest first, down to a lookback before the earliest month (as slice 8's 7 days).
  - Each pipeline's `build_seconds_used` lands on the UTC day of `completed_on`, per repository.
- **Grain.**
  - The billing account is the workspace.
  - The sub-account is the repository's uuid, with its full name as the sub-account name and the `repo`.
  - The SKU is `pipeline_minutes`; the unit is `minute`.
- **Bounds stated in the docs.**
  - There is no workspace-total endpoint.
  - Whether the size multiplier is in `build_seconds_used` is unverified.
  - Self-hosted runner pipelines (C6).
  - Caps on repositories, and on pipelines per repository.

### Slice 10: Jenkins build minutes at a configured agent rate

- **Config.** `[cost.jenkins] rate_per_minute`, `currency`, `agent_rates` keyed by agent name (`builtOn`), and optionally `label_rates`, if the builder finds labels readable from the build JSON.
- **Source.**
  - `GET <base>/api/json?tree=jobs[name,url,jobs[...]]`, walked through folders to a depth cap.
  - Then per job: `builds[number,timestamp,duration,builtOn,result]` newest first, down to the lookback.
  - Folder and multibranch jobs are handled by the walk.
  - `builtOn` empty means the built-in node.
- **Grain.**
  - The billing account is the Jenkins base host.
  - The sub-account is the job's full name.
  - The resource is the agent.
  - The day is the UTC day the build ended (`timestamp` + `duration`).
  - Running builds (no `duration`) are skipped.
- **Pipeline jobs.** `builtOn` is not on `WorkflowRun`. The builder checks what the JSON API offers. If no agent can be read, the build is priced at the default rate with `rate_key` `default`, and the docs say per-agent rates apply only to freestyle and matrix builds.
- **Bounds.**
  - The tree depth and job caps.
  - A deleted build is not counted.
  - Wall-clock minutes, not agent-billed minutes.

### Slice 11a: AWS from a FOCUS Data Export in S3

- **Config.** `[cost.aws] export = "s3://bucket/prefix"`. The export must be FOCUS 1.0, **CSV** format; Parquet is a stated gap.
- **Source.**
  - `aws s3 ls` and `aws s3 cp` through the AWS CLI, with the stored AWS credentials.
  - Per billing period folder, read the newest export's manifest and files.
  - Each file is parsed by the existing `finops/focus-csv.ts`, and each (billing account, period) is replaced the way the file import replaces it.
  - Lines carry `source = "aws_billing"`.
- **Bounds.**
  - The owner creates the export (Billing and Cost Management, Data Exports, FOCUS 1.0, CSV, to their bucket).
  - The S3 storage cost is the owner's.
  - History starts when the export starts.

### Slice 11b: AWS Cost Explorer fallback (opt-in)

- **When it runs.** Only when `[cost.aws] cost_explorer = true` AND no `export` is set.
- **Source.** `aws ce get-cost-and-usage`, `DAILY`, metrics `UnblendedCost`, `AmortizedCost` and `UsageQuantity`, grouped by `SERVICE` and `LINKED_ACCOUNT`. That is the two-group-by limit.
- **Grain and pricing.**
  - The amount goes to `billedCost` (Unblended), with `effectiveCost` as Amortized.
  - A result marked `Estimated` stays pending, like an unfinished month.
  - The request count is logged per run, and the docs state $0.01 per request and the expected count.
- **Bounds.** No region, resource or tag grain (the limit is the API's).

### Slice 12a: Azure from a FOCUS Cost Management export

- **Config.** `[cost.azure] export = { account, container, path }`, a FOCUS "cost and usage details" export.
- **Source.**
  - List and read the export's CSV files through the Azure access the gateway already holds (C7).
  - Parse them with `focus-csv.ts`; lines carry `source = "azure_billing"`.
- **Bounds.**
  - Management-group scope is not supported for FOCUS exports (Microsoft's statement).
  - The owner creates the export.
  - Storage cost is the owner's.

### Slice 12b: Azure Cost Management Query API fallback (on by default, C2)

- **When it runs.** Only when no `export` is set, for the scopes in `[cost.azure] scopes` (subscription or billing-account resource ids; none means nothing).
- **Source.** `POST {scope}/providers/Microsoft.CostManagement/query`, daily granularity, grouped within the API's group-by limit (service name and resource group), paged by `nextLink`.
- **Throttling.**
  - A 429 waits for `x-ms-ratelimit-microsoft.costmanagement-qpu-retry-after`.
  - At most one run a day, as Microsoft advises.
- **Bounds.** The QPU quotas are stated, with aggregated grain only.

### Slice 13: GCP from the BigQuery billing export

- **Config.** `[cost.gcp] export_table = "project.dataset.gcp_billing_export_resource_v1_<ID>"`, or the standard `gcp_billing_export_v1_<ID>`. The detailed table is preferred when both are named.
- **Source.** BigQuery `jobs.query` REST with the `gcloud` token: one query per month read, filtered on the partition column (C3), summing by day, project, service, SKU, region and labels.
  - The netted cost is `cost + SUM(credits.amount)`.
  - `usage.amount` and `usage.unit` give the quantity.
  - `currency` is taken as given.
  - Correction rows that negate earlier rows are absorbed by re-reading the trailing window (current and previous month, as slice 5 does).
- **Bounds.**
  - No history before the export was enabled, apart from Google's one-time backfill of the previous month, on a multi-region dataset only.
  - BigQuery bills the scan.
  - FOCUS export: a later roadmap row (D6).

### Slice 14: flag changes in `nimbus cost why`

- **Config.** `[ci.service.<id>] feature_flags = ["launchdarkly:<project>", "launchdarkly:<project>:<flag>", "unleash:<project>", "unleash:<project>:<flag>", "split:<flag>", "flagsmith:<project>", "flagsmith:<project>:<flag>"]`. It is parsed and validated beside `sentry_projects` and `argocd_apps`; a malformed entry refuses that service's config the way its siblings do.
- **Read.**
  - `agents/_lib/cost-why-query.ts` (outside `finops/`, D48) gains a flag lookup.
  - For each service in the why's context, it reads the bound `feature_flag` items whose `modifiedAt` falls in the context window, capped at 10, newest first, with the truncation count.
- **Output.** `nimbus cost why` text and JSON list each flag with:
  - the service;
  - the time of its last change, and where the source records it, which environments changed;
  - the line "only the latest change of each flag is known".
- **Bounds.** No flag history; a flag changed twice in the period shows once.

### Slice 15: Jenkins agents priced from their cloud machine cost

- **Config.** `[cost.jenkins] agent_cost = { "<agent>" = { provider = "aws", resource = "<instance id or name glob>" } }`.
- **Read.** For each such agent, take that resource's daily cost from the stored cloud lines. Split it across the builds that ran on the agent that day, by minutes; the idle share stays as the machine's own cost, named "idle".
- **No double count.**
  - The machine's cost stays on its cloud line.
  - The Jenkins lines carry the split with `rate_key` `cloud:<agent>`, plus a tag naming the cloud line they mirror.
  - The views count the cloud line OR the Jenkins split for that machine, never both. The builder chooses the mechanism, an allocation-view rule rather than a second stored cost being the expected one, and the review checks it.
- **Bounds.** It works only when the agent maps to a resource the cloud lines carry (a FOCUS export or Cost Explorer has no resource grain: a stated gap).

## 6. Approaches considered

- **Clouds.** The owner chose A+B ("both"):
  - **A. Read the export:** full grain and free, but the owner sets up the export.
  - **B. Call the cost API:** nothing to set up, but aggregated, and paid on AWS.
  - **Both:** the export first, the API as fallback.
- **Jenkins.** The owner chose A, then B:
  - **A. A configured agent rate:** simple, works anywhere.
  - **B. Cloud machine cost:** the real cost, but works only with mappable agents and is complex to keep from double counting.
- **Bitbucket credentials.** The owner chose A:
  - **A. Fix the connector in the slice.**
  - **B. A cost slice only, on the old key names.**
  - **C. A separate connector PR first.**
- **GCP.** The owner chose C:
  - **A. The standard or detailed export.**
  - **B. The FOCUS export (preview).**
  - **C. A now, B later.**
- **Cost Explorer.** The owner chose opt-in, over on-by-default with a cap, and over opt-in with a monthly budget.

## 7. Left to the builder

- Each slice's exact endpoint parameters, page sizes and caps, chosen from the vendor docs and recorded in the plan.
- The cursor prefixes.
- The config validators (bounded lists, same refusals as `[cost.gitlab]`).
- File splits under the 500-line rule.
- The exact Azure and GCP query shapes within the vendor's limits.
- How slice 15 keeps one count per machine (the review checks it).

Each slice's detailed task list is written into the plan (`2026-11-26-phase7-cost-pack.md`) and approved by Antigravity before its code starts, as for slices 1 to 8.
