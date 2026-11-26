# Phase 7 — The Cost Pack (design)

Branch-only working document; deleted before the implementation PRs (specs never land on `main`).
Owner decisions recorded in the conversation of 2026-11-26 are marked **(owner)**; the builder's calls
are marked **(builder)**.

## Intent

Adoption first (OR-ECO-1). One person, a DevOps lead or an engineering director, installs Nimbus and
can see what their organisation spends, on what, and why it moved, from data that stays on their
machine. Two levels **(owner)**:

1. **Product cost** — what it costs to run each product and its parts (the web app's hosting, the
   backend service behind it, its database).
2. **Internal cost** — what the company spends on itself: CI/CD pipelines and the dev and test
   environments.

Every cloud (AWS, Azure, Google Cloud) and the delivery tools teams pay for (GitHub, GitLab,
Bitbucket, Jenkins) **(owner)**. Revenue per product (the CFO view) is a later phase: a new row in
Phase 14, Stripe first, sources pluggable **(owner)**; Phase 7's product mapping is the key it joins on.

## Goals

1. One normalised **cost line** model every source produces (FOCUS-shaped).
2. Sources in the first slice: **FOCUS file import** (all three clouds), **GitHub Actions usage**,
   **OpenAI usage**, **Anthropic usage** **(owner: approach C)**. Later slices add GitLab, Bitbucket,
   Jenkins (agent-machine cost) and the cloud API pulls, one per PR.
3. **Owner-written allocation rules** map each cost line to product, environment and optionally service;
   unmatched lines land in a visible **unassigned** bucket **(owner: customisable, simplest first,
   designed to change)**. Rules can be re-applied to past lines.
4. **Views:** product cost, internal cost (env `ci` and the dev/test environments), and **why it moved**
   (a change set beside the deploys, pull requests and owners of the mapped service around it).
5. **Reports:** a structured report model (JSON is canonical) rendered for the terminal, CSV export,
   and per-channel messages from owner templates **(owner)**; weekly by default, schedule configurable
   **(owner)**; delivered to Slack, Teams and as an email **draft** **(owner)**.
6. **Unattended delivery** through a scheduled workflow plus a standing rule **(owner: option 1)**,
   which needs the I55 extension below **(owner: approved)**.
7. **Demo:** the seeded demo organisation gains cost lines and rules, so the whole flow can be shown
   with no credentials.
8. **FinOps role pack** in the official registry (defaults only; grants nothing, I47).
9. The first row of the phase stays the owner's: releasing the held agent-door launch copy.

## Non-goals (moved out, owner 2026-11-26)

- Cost garbage-collection deletion → Phase 13.
- Data FinOps attribution, further FinOps/sustainability connectors, cost in the Terraform approval →
  Phase 8.
- Excel (.xlsx) output (CSV opens in Excel; a later renderer of the same model) **(owner)**.
- Attachments on chat posts or drafts (the write rows carry text only).
- A desktop page now; the design leaves room for it **(owner)** (one renderer-callable read later).
- Revenue (Phase 14).

## Anti-goals

- A cost line is silently dropped or double-counted. Every imported line is either allocated or in
  `unassigned`; totals reconcile with the source totals the import reports.
- A report leaves the machine without the owner's standing rule, or with content the door refusals
  would refuse (a cloud tag `<!here>` becoming a channel-wide mention).
- A model step in anything unattended (OR-10-8): rendering is deterministic.
- Cost data embedded remotely (existing exclusion stays; new types join it).

## Constraints (from the project)

- Non-negotiable 4: the engine never calls a cloud API directly. API pulls are connectors (the
  connectors repo) spawned sandboxed (I15) like Vantage; the FOCUS file import is local parsing only.
- Static D48: `finops/**` imports no ChatOps, egress, federation, share, llm, engine or agents module,
  and uses no network primitive. Report DELIVERY therefore does not live in `finops/`: it is a
  workflow write step (automation/), and `finops/` only builds the report model and renders text.
- I29: every outbound post is ledgered (the existing post/draft rows already are).
- I53/I55/D44: the post and draft rows are wave 2 (`slack_message_post`, `teams_message_post`,
  `gmail_draft_create`, `outlook_draft_create`); a post to a ChatOps channel, a broadcast mention and
  remote content are refused on the door (`modelWriteRefusal`), and those refusals run on the actual
  input of a standing-approved action (I55 step list).
- Existing cost types: `vantage:cost_allocation`, `opencost:`/`kubecost:cost_allocation`,
  `cost_recommendation` (`finops/cost-item-contract.ts`); `readCostSeries`, anomalies, waste, rollup,
  retention are shipped.

## Approaches (owner picked C)

- **A. Files first** — FOCUS exports only. Simplest, offline; staleness and one-time cloud setup.
- **B. APIs first** — a connector per source. Fresh; 8+ connectors, billing-scoped credentials, AWS Cost
  Explorer per-request fees.
- **C. One cost-line model, sources added one at a time (chosen)** — FOCUS file import + GitHub Actions
  + OpenAI + Anthropic first; the rest per slice. A new source is a reader (built in or an extension).

## Design

### 1. The cost line (normalised model)

A new item type `cost_line` (per source service, e.g. `focus:cost_line`, `github_actions:cost_line`,
`openai:cost_line`, `anthropic:cost_line`), daily granularity, metadata (all FOCUS-named where FOCUS
has a column):

- `chargePeriodStartMs`, `chargePeriodEndMs` (UTC day), `billedCost`, `effectiveCost` (nullable),
  `billingCurrency`, `provider` (`aws|azure|gcp|github|openai|anthropic|…`), `serviceName`,
  `serviceCategory` (nullable), `regionId` (nullable), `resourceId` (nullable), `resourceName`
  (nullable), `subAccountId` (account / subscription / project), `subAccountName` (nullable),
  `tags` (string map, flattened, capped), `chargeCategory` (`usage|purchase|tax|credit|adjustment`),
  `skuId`/`usageUnit`/`consumedQuantity` (nullable), and Nimbus-side `repo`, `workflow`, `runner`
  (CI sources only), `model` (AI sources only), `finalized` (provisional for the last 3 days, as today),
  `importId` (which import or sync produced it).
- Aggregation key: one row per (source, day, subAccount, service, resource-or-sku, tags-hash); the
  builder sets the exact grouping so rows stay bounded, with the cap and the `__other__` fold that
  `cost-rollup.ts` already applies.
- Never embedded (joins `embedding-exclusions.ts`); pruned by the existing `[finops] retain_days`.
- Existing Vantage/OpenCost/Kubecost `cost_allocation` rows are adapted into the same view layer
  (read-side adapter), not rewritten.

### 2. Sources (first slice)

- **FOCUS file import** `nimbus cost import <path|dir> [--provider aws|azure|gcp] [--dry-run]`
  (CLI-only IPC `cost.import`, owner kinds, LAN-forbidden): CSV first; Parquet only if a vetted,
  licence-clean reader exists (builder checks; otherwise CSV only and the docs say so). Idempotent per
  file hash; reports per-file totals; a watched folder (`[cost.focus] dir`) re-imports new files on a
  schedule. No network, no credential. The parser is a reader behind a `CostSource` interface.
- **GitHub Actions usage** — through the existing GitHub credential, a read tool in the connectors repo
  (the billing usage endpoint; builder verifies the endpoint, scope and shape and records it as
  documentation-verified only), synced daily. Lines carry `repo`, `workflow`, `runner` (hosted OS/size).
- **OpenAI usage/costs** and **Anthropic usage/cost report** — new read-only connectors with the
  organisation admin key each vendor requires (builder verifies endpoints; vendors' admin keys are
  owner-supplied, Vault only).
- `CostSource` interface: `{ id, kind: "file"|"connector", readLines(window) → CostLine[] }`; built-in
  readers register in one table; an extension can register a reader later (design note only now).

### 3. Allocation rules

`[[cost.rule]]` in `nimbus.toml` (layered config; a role pack may supply defaults), ordered, first
match wins:

- `match`: any of `source`, `provider`, `sub_account` (glob), `service` (glob), `region`, `resource`
  (glob), `tag = { key = "glob" }`, `repo` (glob), `workflow` (glob); all given keys must match.
- `set`: `product`, `env`, `service` (a `[ci.service.<id>]` id when it should join deploys and PRs);
  values are literals or a single placeholder from the line (`{tag.<key>}`, `{repo}`, `{sub_account}`),
  validated against `^[A-Za-z0-9._:/@+-]{1,64}$` after substitution, else the line goes `unassigned`
  with the reason.
- Rule matchers are a small registry (tag, account, name, source); new matcher kinds (a service-catalog
  lookup, an ownership lookup) are added there later.
- Allocation is computed at read time from the stored lines and the current rules (so changing rules
  re-applies to the past instantly); a `nimbus cost rules check` lists unmatched share and top
  unassigned keys.

### 4. Views and briefs (CLI first)

- `nimbus cost products [--period 30d] [--json|--csv]` — cost per product, with parts (service,
  provider) and env split.
- `nimbus cost internal [--period 30d] [--json|--csv]` — env `ci` and dev/test envs (env names
  configurable, `[cost] internal_envs`, default `ci, dev, test, staging`).
- `nimbus cost why <product|service> [--period 14d] [--json]` — the change versus the previous period,
  the lines that moved it, and, for a mapped `[ci.service.<id>]` service, the deploys, pull requests and
  owners in the window (index-only, deterministic, no model; an `--synthesize` variant is NOT in this
  phase).
- `nimbus cost report <name> [--json|--csv|--text]` — renders a configured report now (section 5).
- IPC: `cost.products`, `cost.internal`, `cost.why`, `cost.report.render` (reads; `cli`/`ui` kinds;
  the `cost` namespace stays LAN-forbidden; none added to the Tauri allowlist now — the desktop page is
  a later, separate change that adds `cost.report.render` and the view reads by name).
- Every output shows the unassigned share and the source freshness; "no data" and "zero cost" are
  different statements.

### 5. Reports and templates

```toml
[[cost.report]]
name = "s3-weekly"
scope = { service = "s3" }            # any rule-output dimension: product, env, service, provider
period = "week"                        # week (Monday-based, report timezone) | month | 7d | 30d
schedule = "0 8 * * MON"               # optional; cron as workflows; default weekly Monday 08:00
tz = "Europe/Berlin"                   # optional; default the gateway zone

[cost.report.channel.slack]
to = "C0123ABC"
format = "text"                        # per channel (owner): text | markdown | html (email) | csv-inline
template = "Summary of cost of S3 storage for the week starting Monday {week_start}: {total} ({change}). Top: {top_movers}"

[cost.report.channel.email]
to = ["cfo@example.com"]
provider = "gmail"                     # gmail | outlook — becomes a DRAFT (owner)
format = "html"
template_file = "cost-templates/s3-weekly.html"   # under <configDir>/, read through one handle, capped
```

- Placeholders (closed set): `{report_name}`, `{period_start}`, `{period_end}`, `{week_start}`,
  `{total}`, `{currency}`, `{change}`, `{change_pct}`, `{top_movers}`, `{breakdown}`, `{unassigned}`,
  `{unassigned_pct}`, `{freshness}`, `{command}` (the exact `nimbus cost report <name>` line). No loops,
  no expressions, no file includes; an unknown placeholder refuses the report at load.
- Per-channel escaping of every substituted value: HTML-escape for `html`; for Slack/Teams the
  mention and formatting characters are neutralised (`<`, `>`, `&`, `@`, `*`, `_`, `~`, `` ` ``);
  the template's own literal text is the owner's.
- The rendered body must pass the door refusals (no ChatOps channel, no broadcast mention, no remote
  content); a template that would load remote content (an `<img src=http…>`) is refused at load.
- Size caps per channel (builder: the Slack/Teams/draft row limits); `{breakdown}` truncates with a
  stated count, never silently.

### 6. Unattended delivery and the I55 extension (owner-approved)

- A report with a `schedule` and channels is delivered by a **saved workflow** the owner creates with
  `nimbus cost report schedule <name>` (or by hand): one deterministic `report` step that renders, then
  one `write` step per channel (`slack_message_post`, `teams_message_post`, `gmail_draft_create` /
  `outlook_draft_create`) whose destination is a constant from the config and whose body field's value
  source is the new **`report`** source.
- **I55 extension (text + wiring + test in one commit):** a third allowed value source beside
  `constant` and `query`: `{ report: <step index> }`, the body of a declared `report` step of the same
  workflow, rendered by the gateway from the owner's template and the local index, with no model and
  no tool output. `accountedStep` and `scopeStep` accept it; the rule's scope names the report step and
  the template's content hash (a changed template or report definition makes the rule not match until
  re-approved). The shared door refusals still run on the actual rendered input. Static D44 gains a
  clause pinning that only `automation/workflow-report-step.ts` produces a `report` value.
- The owner approves the step once with the existing `nimbus approve add --workflow <name> --step <n>`
  (human answer, CLI only). Without a rule each scheduled post blocks and notifies, as today (SA4).
- The guardrail in the roadmap changes from "cost data does not leave" to "cost data leaves only in a
  report the owner approved as a standing rule, and every post is in the ledger".

### 7. Demo and role pack

- Demo corpus: FOCUS lines for the seeded org (three products, CI, dev envs, one seeded spike matched
  to a seeded deploy), rules, and one report; `nimbus --demo cost why checkout` shows the join with no
  network.
- FinOps role pack (`finops` 1.0.0, official registry): default rules skeleton, `internal_envs`, a
  weekly report definition with no channels; grants nothing (I47).

### 8. Slices (one PR each, in order)

1. Cost-line model + FOCUS CSV import + allocation rules + `cost products|internal` + demo lines.
2. `cost why` (the change join) + `cost rules check`.
3. Reports: model, renderers (text/markdown/html/csv), templates, `cost report`.
4. Delivery: the workflow `report` step, the I55/D44 extension, `cost report schedule`.
5. GitHub Actions usage (connectors repo tool + gateway sync).
6. OpenAI and Anthropic usage (connectors repo + gateway sync).
7. FinOps role pack; roadmap/doc close-out; the Phase 14 revenue row.
8. Later slices (each its own PR, still Phase 7): GitLab, Bitbucket, Jenkins agent cost, cloud API pulls.

## Acceptance (replacing the phase's current criteria)

- On the demo corpus, `nimbus cost why checkout` names the seeded deploy, its pull request and the
  owning service for the seeded spike, with no network call.
- A FOCUS CSV export imports idempotently; totals equal the file's totals; every line is allocated or
  in `unassigned`.
- A scheduled report posts to a Slack channel under a standing rule with no prompt, the post is in the
  audit log and the egress ledger, and a cloud tag containing `<!here>` is rendered inert.
- Without a standing rule the same scheduled run blocks and notifies; an email channel always produces
  a draft, never a sent mail.
- The cost views add no egress row.

## Left to the builder

- Exact aggregation grouping and caps; the Parquet decision; vendor endpoint verification (recorded as
  documentation-verified); channel size caps; the exact placeholder formatting (currency, percent).
