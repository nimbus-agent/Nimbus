<div align="center">

# ☁️ Nimbus

## On-Call Intelligence for DevOps, SecDevOps, and Platform Engineering Teams

*Cross-service incident context in under 100 ms. Consent-gated automation. Your credentials never leave the machine.*

[![CI](https://github.com/nimbus-agent/Nimbus/actions/workflows/ci.yml/badge.svg)](https://github.com/nimbus-agent/Nimbus/actions/workflows/ci.yml)
[![Docs: nimbus-agent.dev](https://img.shields.io/badge/docs-nimbus--agent.dev-blueviolet)](https://nimbus-agent.dev)
[![Built with Bun](https://img.shields.io/badge/runtime-Bun_1.2+-black?logo=bun)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/language-TypeScript_7.x-3178C6?logo=typescript)](https://typescriptlang.org)
[![MCP](https://img.shields.io/badge/protocol-MCP-purple)](https://modelcontextprotocol.io)
![Platforms](https://img.shields.io/badge/platforms-Windows_%7C_macOS_%7C_Linux-blue)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](../LICENSE)
[![Release](https://img.shields.io/github/v/release/nimbus-agent/Nimbus?label=release&color=brightgreen)](https://github.com/nimbus-agent/Nimbus/releases/latest)
[![Discussions](https://img.shields.io/badge/community-GitHub%20Discussions-238636.svg)](https://github.com/nimbus-agent/Nimbus/discussions)

<!-- HERO DEMO PULLED 2026-08-25 — do not re-add without a real capture.
     The cast was rendered from a fake-gateway recording and depicted output the
     product does not produce: a "| Lane | Evidence |" table with a fabricated PR
     #214, ticket AUTH-88 and incident INC-31. That string appears nowhere in
     production source — only in scripts/cast-driver/fixtures/zero-config/events.json.
     The real `nimbus why` emits "# Why" -> "## Authorship" -> "## Gaps", and the
     recorded command sequence (init --no-sync -> connector sync -> why) fails on a
     real machine with "Gateway is not running".
     Restore only from output captured against a REAL gateway. -->

[**Install**](#quick-start) · [**Docs**](https://nimbus-agent.dev) · [**Architecture**](./architecture.md) · [**Roadmap**](./roadmap.md)

</div>

---

## Start here

```bash
nimbus init            # index the repo you're standing in — no account, no API key
nimbus why src/auth.ts:42
```

Who wrote this line, when, and in which commit — answered from your local git history, with no LLM configured, no API key, and no cloud account. Connect GitHub and a ticket tracker (Jira or Linear) and an incident tool, and the same command extends its answer with the pull request that carried the change, the ticket that asked for it, and the incident it touched.

That is the whole first run. Much of what follows is what becomes available once you connect the tools you already use.

---

Nimbus is an open-source, local-first AI agent built for engineers who run systems in production. A headless **Nimbus Gateway** runs on your machine, maintains a private SQLite index across your entire developer toolchain — source control, CI/CD, cloud infrastructure, monitoring, and incident management — and executes multi-step tasks on your behalf. Every write, send, or delete requires your explicit approval before it runs.

**Your credentials never leave your machine. There is no Nimbus server.**

Every architectural decision in Nimbus is evaluated against one question:

> **Does this return control to the user, or does it erode it?**

The non-negotiables in [Contributing](#contributing) follow from that question — they are load-bearing constraints, not aspirational values.

## Three load-bearing words

- **local** — the SQLite index, the Vault, and the audit log all live on your machine. The cloud is a connector, not the source of truth. Telemetry is opt-in and off by default (`[telemetry] enabled = false`).
- **consent-gated** — every destructive or outbound action is intercepted by a human-in-the-loop gate *before* it runs. It lives in the executor, not the prompt, so it cannot be jailbroken away.
- **MCP** — Nimbus speaks the [Model Context Protocol](https://modelcontextprotocol.io/) in both directions. As an **MCP client** it drives every connector as an MCP server, and hosts any third-party server you register with `nimbus connector add --mcp`. As an **MCP server**, it exposes your local index *and* its built-in agents to any MCP client through 21 read-only tools — 9 index tools plus 12 agent tools (`explainWhy`, `findExpert`, `assessImpact`, `getCatchup`, …). Install it with `npx -y @nimbus-dev/mcp`, or run `nimbus mcp-server --stdio` directly from a checkout. The engine never calls a cloud API directly.

---

## What It Does

```bash
# Incident response — answered from the local index, no API calls, under 100ms
nimbus ask "The payment-service alert just fired — what changed in the last 2 hours?"

# Line-level provenance — commit authorship from local git, no credentials or LLM needed.
# Connect GitHub, a ticket tracker and an incident tool to extend it with the PR, ticket, and incident.
nimbus why src/auth.ts:42

# Release readiness — cross-service without tab-switching
nimbus ask "Which of my open PRs have failing CI and are blocking the release branch?"

# SecDevOps — correlate security signals with your codebase
nimbus ask "Which repos have critical Dependabot alerts with open PRs touching the affected packages?"

# Data lineage — answered from the local index, no warehouse query
nimbus ask "The Q1 revenue dashboard shows zeroes — which upstream model broke?"

# Blast radius — answered from the relationship graph before you push
nimbus ask "what services depend on src/billing/retry.ts, and which dashboards or pipelines would feel a change to it?"

# Prove what left the machine — the append-only, BLAKE3-chained egress ledger
nimbus prove --since 24h

# Consent-gated automation — full plan preview before anything executes
nimbus run ./incident-response.yml
```

**Example session:**

```text
$ nimbus ask "The payment-service alert just fired — what changed?"

🔍 PagerDuty: P1 — Error rate 4.2% — fired 8 minutes ago
🔍 Last deploy: payment-service v2.14.1 — 23 minutes ago
🔍 GitHub diff v2.14.0 → v2.14.1: 3 files — src/billing/retry.ts most significant
   PR #312 "Increase retry backoff" — merged by @elena 41 minutes ago

⚠  CONSENT REQUIRED — Post incident summary to #incidents?
   Post? [y/n]: y  ✅ Posted.

Suggested next step: rollback to v2.14.0?
⚠  CONSENT REQUIRED — Trigger Jenkins rollback job.
   Rollback? [y/n]: n  Aborted. No changes made.
```

**SecDevOps example:**

```text
$ nimbus ask "Critical CVE dropped for lodash — what's our exposure?"

🔍 Scanning local index: 47 repos indexed, 12 have lodash as a direct dependency
🔍 Active PRs touching lodash: 3 open PRs across payment-service, auth-gateway, api-proxy
🔍 Sentry: 2 production errors last 24h in lodash code paths (payment-service)
🔍 Jira: No active tickets for this CVE yet

Suggested next step: Create Jira tickets for affected repos?
⚠  CONSENT REQUIRED — Create 3 Jira tickets and assign to component owners.
   Proceed? [y/n]: y  ✅ Created PLAT-1847, PLAT-1848, PLAT-1849.
```

**Data lineage example:**

```text
$ nimbus ask "The Q1 revenue dashboard shows zeroes — which upstream model broke?"

🔍 Tableau: dashboard "Q1 Revenue" — last refresh failed 12 minutes ago
🔍 Upstream Looker view: revenue_daily → dbt model revenue_daily_agg
🔍 dbt Cloud: revenue_daily_agg — last run failed 14 minutes ago
🔍 Airflow: DAG daily_revenue_etl — task load_fact_orders failed with SQL error
🔍 GitHub PR #842 "Rename order_amount → gross_amount" — merged by @priya 28 minutes ago
   No downstream dbt model updated to match the rename.

Suggested next step: Revert PR #842 and rerun the DAG?
⚠  CONSENT REQUIRED — Revert PR #842 and trigger Airflow DAG rerun.
   Proceed? [y/n]: n  Aborted. No changes made.
```

More worked examples: [`examples.md`](./examples.md).

---

## Who It's For

Nimbus is built for engineers and operators who run systems in production. If your on-call rotation spans five monitoring tools and three cloud consoles, Nimbus is the intelligence layer that collapses that context into a single query.

| Role | What Nimbus gives you |
|---|---|
| **On-call / SRE** | Instant incident context — last deploy, triggering commit, CI result, Slack thread — in one query, without seven browser tabs |
| **Platform Engineer** | Drift detection, multi-cloud infra state, deployment correlation, CI/CD and build pipeline monitoring (Bitrise), consent-gated IaC apply and rollback |
| **Security Engineer** | Alert-to-commit tracing, CVE-to-PR correlation, vulnerability and code analysis insights (Snyk, Semgrep, SonarQube/SonarCloud), full audit log for every agent action, compliance posture queries |
| **Senior Developer** | Cross-repo PR intelligence, release readiness checks, pipeline context, local-only credential storage; OpenAPI / AsyncAPI spec indexing for "which services expose this endpoint?" queries |
| **Team Lead / Engineering Manager** | Cross-service activity digest, changelog generation, expert routing, blast radius analysis — without asking anyone |
| **Analytics Engineer / Data Scientist** | Cross-stack lineage from dashboard to dbt model to warehouse table to orchestration DAG — one local query instead of five consoles; metadata-only ingestion keeps row data on the warehouse |

This is not a tool for everyone. There is no managed cloud service, no Nimbus account, and no relay server. If that's what you need, look elsewhere.

More detail on each role, including analytics and data roles: [Who Nimbus is for](./audiences.md).

---

## Why Engineers Choose Nimbus

### Fast — Most Queries Never Hit the Network

Nimbus maintains a local SQLite metadata index. Searching across 50,000 indexed items across five services takes under 100 ms — faster than opening a new browser tab.

| Operation | Nimbus (local index) | Typical SaaS |
|---|---|---|
| Search across all services | ~20–80 ms | 1,500–4,000 ms |
| List recent files from 3 services | ~5 ms | 3× API round trips |
| Semantic recall (embeddings) | ~50–200 ms | Remote embed + search |
| Gateway cold start | ~80 ms | Always-on cloud |

*Measured on a mid-range laptop; 50k item index across 5 connected services.*

### Secure by Architecture

- **Credentials** are stored in your OS-native keystore (Windows DPAPI, macOS Keychain, Linux Secret Service). There is no code path that writes them to disk, logs, or IPC responses.
- **The HITL consent gate** is implemented in the executor, not the prompt. A model that generates a plan to skip confirmation produces a plan that simply does not execute.
- **Extensions** run in sandboxed child processes. They receive only credentials for their declared service and cannot enumerate Vault keys or access other connectors.
- **Prompt injection** is mitigated by injecting file content and API responses as typed `<tool_output>` data blocks, never as instructions.
- **Every authorized outbound action is ledgered.** An append-only, BLAKE3-chained egress ledger records what left the machine, and `nimbus prove` reports it. The structural rules behind all of this are enumerated in [`SECURITY-INVARIANTS.md`](./SECURITY-INVARIANTS.md); each of the thirty-two LIVE invariants — `I1`–`I27` and `I29`–`I33` — has a production wiring site *and* an enforcement test. `I28` is a reserved number with neither.

### True Cross-Platform

Windows, macOS, and Linux are equally supported. Every PR runs a full gate on Ubuntu (typecheck, lint, build, tests). Pushes to `main` run the full three-platform matrix in parallel. Platform-specific code (IPC, secrets, autostart, notifications) lives behind a typed `PlatformServices` abstraction — business logic never knows which OS it's on.

### Extensible

Third-party connectors ship as npm packages. Install in one command; the agent gains a new capability immediately. A local Extension Marketplace lives in the Tauri desktop app — code-complete in Phase 4 and shipping as the separate `desktop-v0.1.0` tag in Phase 13.

---

## Quick Start

### 1. Install

No admin on macOS and Windows; the Linux `.deb` uses `sudo`.

<details open>
<summary><b>macOS</b></summary>

```bash
# The keychain must be UNLOCKED. Nimbus never shows an authorization dialog (a
# background service could not answer one), so on a locked keychain it fails
# immediately and tells you what to run. Over SSH or in CI, give it its own
# keychain:  security create-keychain -p "" nimbus.keychain
#            security default-keychain -s nimbus.keychain
#            security unlock-keychain  -p "" nimbus.keychain

curl -fsSL https://github.com/nimbus-agent/Nimbus/releases/latest/download/install.sh | sh -s -- --yes
# then open a new shell:
nimbus --version
```

The installer picks Apple silicon or Intel from `uname -m`, verifies the release
signature before it installs anything, and copies the binaries to `~/.local/bin`.

Rather read the script before running it? Download the archive and run the copy
inside it — same installer, no pipe:

```bash
# Apple silicon — for Intel, swap arm64 → x64.
curl -fsSL https://github.com/nimbus-agent/Nimbus/releases/latest/download/nimbus-headless-macos-arm64.tar.gz -o /tmp/nimbus.tar.gz
mkdir -p /tmp/nimbus && tar -xzf /tmp/nimbus.tar.gz -C /tmp/nimbus
less /tmp/nimbus/install.sh
/tmp/nimbus/install.sh
```

</details>

<details>
<summary><b>Linux</b></summary>

```bash
# Credentials live in the OS keystore, and the Gateway will not start without it:
sudo apt install libsecret-tools   # Debian/Ubuntu
# sudo dnf install libsecret       # Fedora/RHEL

curl -fsSL https://github.com/nimbus-agent/Nimbus/releases/latest/download/nimbus_amd64.deb -o /tmp/nimbus.deb
# apt, not `dpkg -i` — the package depends on bubblewrap and libcap2-bin,
# and dpkg will not install those for you.
sudo apt install /tmp/nimbus.deb
nimbus --version
```

Prefer no `sudo`? Two options, neither of which resolves the dependencies for
you — the `.deb` above is the only path that does:

```bash
# x86-64 only; there is no published Linux arm64 build.
curl -fsSL https://github.com/nimbus-agent/Nimbus/releases/latest/download/install.sh | sh -s -- --yes
# then open a new shell:
nimbus --version
```

This installs to `~/.local/bin` and updates your shell `PATH`. It **warns** if
`bubblewrap` is missing rather than installing it — and the Gateway will not
start without it (`sudo apt install bubblewrap`). The
[AppImage](https://nimbus-agent.dev/user-guide/install/#appimage-linux-alternative)
is the other no-`sudo` route: a portable single file.

**Headless box** — server, container, SSH session or WSL? `libsecret` also needs
a D-Bus session and an unlocked keyring, which those machines usually lack. Run
`nimbus doctor`; it names which piece is missing. Full recipe:
[Headless Linux](https://nimbus-agent.dev/user-guide/install/#headless-linux-no-desktop-session).

</details>

<details>
<summary><b>Windows (PowerShell, no admin)</b></summary>

```powershell
$url = "https://github.com/nimbus-agent/Nimbus/releases/latest/download/install.ps1"
& ([scriptblock]::Create((irm $url))) -Yes
# then open a new PowerShell window:
nimbus --version
```

Works on stock Windows PowerShell 5.1 as well as PowerShell 7. It is spelled
`& ([scriptblock]::Create(...))` rather than `irm ... | iex` because `iex`
cannot pass `-Yes` to the script.

Rather read the script before running it? Download the archive and run the copy
inside it — same installer, no pipe:

```powershell
$url = "https://github.com/nimbus-agent/Nimbus/releases/latest/download/nimbus-headless-windows-x64.zip"
Invoke-WebRequest -Uri $url -OutFile "$env:TEMP\nimbus.zip"
Expand-Archive -Path "$env:TEMP\nimbus.zip" -DestinationPath "$env:TEMP\nimbus" -Force
notepad "$env:TEMP\nimbus\install.ps1"
& "$env:TEMP\nimbus\install.ps1"
```

</details>

**Package managers** (recommended — auto-updating):

| Platform | Command |
| --- | --- |
| macOS / Linux (Homebrew) | `brew install nimbus-agent/tap/nimbus` |
| Windows (Scoop) | `nimbus` bucket — see [`install.md`](./install.md#package-managers-recommended--auto-updating) |
| Windows (winget) | `winget install NimbusAgent.Nimbus` |
| Debian / Ubuntu (apt) | signed repo — see [`install.md`](./install.md#linux-repositories-apt--yum) |
| Fedora / RHEL (dnf) | signed repo — see [`install.md`](./install.md#linux-repositories-apt--yum) |

Package-manager and native-installer builds disable the self-updater (the package owns updates); the portable archives keep it on. The full install matrix — native `.msi` / `.pkg` / `.rpm` installers, the GPG-signed apt/yum repositories, AppImage, portable tarballs, and download verification — lives in **[`install.md`](./install.md)**.

**Verifying what you downloaded.** Every release artefact is covered by a GPG-signed SHA-256 manifest (`SHA256SUMS.asc`, key `5A20457CCD8B53FFAA945240886ADA6B487CAB6E`) — that manifest is the cross-platform integrity proof. Linux artefacts and the AppImage additionally ship an individual `.asc` sidecar; the macOS and Windows archives do not, so verify those against the manifest. The gateway and CLI binaries also carry GitHub build-provenance attestations. When it downloads a release, the installer runs the manifest check for you: it verifies `SHA256SUMS.asc` against a fingerprint pinned inside the script itself, refuses to install on a mismatched, expired or revoked key, then checks the downloaded archive against the manifest. If `gpg` is missing, or the signature file cannot be fetched, it installs on the checksum alone and says so — `SIGNATURE NOT CHECKED` — rather than letting a checksum pass read as a signature pass. To verify by hand, see [`verify-release-integrity.md`](./verify-release-integrity.md); the fingerprint is published at [`release/SIGNING-KEY.asc`](./release/SIGNING-KEY.asc) and in the [Security Policy](./SECURITY.md).

### 2. Index a repo you already have

No account, no token, no API key:

```bash
cd ~/code/your-project
nimbus init
```

`nimbus init` adds the repo to `nimbus.toml` with code indexing on, starts the gateway, and indexes it. It appends to your config — it never rewrites it, so your comments and existing settings survive (and it keeps a `nimbus.toml.bak`).

### 3. Trace a line's provenance

Who wrote it and when, answered from your local git history. Connect GitHub, a ticket tracker (Jira or Linear), and an incident tool, and the same command extends its answer with the pull request that carried the change, the ticket that asked for it, and the incident it responded to:

```bash
nimbus why src/auth.ts:42
```

`nimbus init` prints a real `file:line` from your own repo to try first. Authorship — who wrote it, when, from your local git history — works with no credentials and no LLM configured; the PR, ticket, and incident need those tools connected.

### Optional: add an LLM

Indexing, `nimbus why`, and the agent briefs all work with **no LLM configured** — briefs render deterministically. An LLM buys you two things: `nimbus ask` (natural-language queries), and prose synthesis that rewrites those briefs into more readable narrative (`[agents] synthesis`, default `"local"`).

It does **not** have to be a cloud one. Point Nimbus at a local model and nothing — not even prompts — leaves the machine:

```toml
# ~/.config/nimbus/nimbus.toml
[llm]
prefer_local = true
local_model  = "llama3.1"     # served by Ollama on http://127.0.0.1:11434
```

See [Local & air-gapped LLM setup](https://nimbus-agent.dev/user-guide/first-run-setup/).

### Optional: connect a cloud service

To correlate across GitHub, Jira, PagerDuty, Slack and ~90 others, add a connector. The fastest path is a token-based one like GitHub:

```bash
nimbus connector auth github --token <your_PAT>
nimbus connector sync github
nimbus ask "what PRs did I open in the last 7 days?"
```

OAuth services — Google Drive, Gmail, Slack, … — use `nimbus connector auth <service>`, which opens your browser. See [Connect a service](https://nimbus-agent.dev/user-guide/connect-service/).

---

## How It Works

```text
~90 cloud services ─▶ first-party MCP connectors ─▶ local SQLite index (+ embeddings)
                                                          │
                              your question ─▶ engine ─▶ HITL consent gate ─▶ action
                                                          │
                                       CLI · VS Code · web clipper · (desktop, coming)
```

A headless **Bun Gateway** maintains the private index and runs the agent; clients talk to it only over local JSON-RPC IPC. Credentials live in the OS keystore (DPAPI / Keychain / libsecret) — never in logs, config, or IPC. Full design: [`architecture.md`](./architecture.md).

---

## Connectors

Every tool your on-call rotation depends on, unified in one local index. Cross-service queries are answered without an API call — the data is already there.

**90+ first-party MCP connectors** across Google, Microsoft, GitHub/GitLab/Bitbucket, Slack, Jira, Linear, Notion and Confluence, plus observability, CI/CD, security & quality, feature flags, GitOps, data & BI, deploy, finance, and support tools. The authoritative roster is `CONNECTOR_VAULT_SECRET_KEYS` in `packages/gateway/src/connectors/connector-secrets-manifest.ts`; the browsable version is in the [connector docs](https://nimbus-agent.dev/connectors/).

Highlights by wave:

- **Phase 1–2** — Local Filesystem, Google Drive, Gmail, Google Photos, OneDrive, Outlook, Microsoft Teams, GitHub, GitLab, Bitbucket, Slack, Linear, Jira, Notion, Confluence, Discord (opt-in).
- **Phase 3** — Jenkins, GitHub Actions, CircleCI, GitLab CI, AWS, Azure, GCP, Kubernetes, Terraform/Pulumi/CloudFormation, Datadog, Grafana, Sentry, PagerDuty, New Relic.
- **Phase 5** — Obsidian, the OpenAPI / AsyncAPI spec indexer, Snyk, Bitrise, SonarQube/SonarCloud, Semgrep, Wiz, LaunchDarkly, Flagsmith, ArgoCD, Flux, dbt Cloud, Metabase, Superset, Databricks, MLflow, Vercel, Netlify, Stripe, Mercury, Readwise, Raindrop, Intercom, Zendesk, Lever, Greenhouse, Pipedrive, Stack Overflow, Zoom — plus Tiers 1–5: Zotero, OWASP Dependency-Track, Ramp, Airflow, Prefect, Dagster; HubSpot, Miro, Canva, Figma, Salesforce, Google Meet (3-legged OAuth); BigQuery, Athena, CloudWatch Logs, GCP Cloud Logging, Kibana/Elasticsearch, SageMaker, Vertex AI, Great Expectations (**no-row-data**: schema and metadata only, enforced by a contract test); generic IMAP, Fastmail (JMAP), ProtonMail Bridge (headers, a capped preview, attachment metadata only); local DB schema indexing, Storybook, and local data-file profiling (Parquet / CSV / JSONL / JSON schema only).
- **Phase 6** — Snowflake, Tableau, Looker, Power BI, Monte Carlo and Bigeye, with a cross-warehouse lineage graph, team-shared credentials and HITL-gated writes; then Mendeley, Workday, Apple Mail / iCloud Calendar, and HITL-gated ArgoCD / Flux / MLflow writes.

See the [roadmap](./roadmap.md) for depth and remaining gaps per connector.

---

## Where the Project Is

Nimbus uses phases, not calendar dates. A phase completes when its acceptance criteria pass. **Phases 1–6 are ✅ complete.** From Phase 7 on, the build order follows the **Sequencing Spine overlay (S1 → S5)** rather than the phase numbers.

| Phase | Theme | Status |
|---|---|---|
| 1 | Foundation | ✅ Complete |
| 2 | The Bridge (15 connectors) | ✅ Complete |
| 3 | Intelligence (semantic search, CI/CD, cloud) | ✅ Complete |
| 3.5 | Observability & Developer Experience | ✅ Complete |
| 4 | Presence (local LLM, multi-agent, voice, VS Code extension, TUI; desktop UI code-complete) | ✅ Complete |
| 5 | The Extended Surface | ✅ Complete |
| 6 | Team (federation, Team Vault, SSO/SCIM, ChatOps, Share) | ✅ Complete |
| S1 | Local Brain — egress ledger, implicit knowledge, the built-in agent set | ✅ Complete |
| **S2** | **Local Compute Fleet — sandboxed code execution, local computer-use, agent fleets** | **◐ Current build slot** |
| S3–S5 | Sequencing Spine overlay — see the roadmap | Planned |
| 13 | Desktop Distribution (*ships `desktop-v0.1.0`* Tauri signed installers + auto-update) | Planned |

**S1 (Local Brain) shipped and closed** on 2026-08-20 — the always-on egress ledger and `nimbus prove` (invariant `I29`), the research-briefs HTTP surface, the full-body store that made briefs answerable at all, zero-config onboarding, and the fourteen built-in read-only agents: `expert`, `impact`, `catchup`, `ghost`, `conflicts`, `huddle`, `janitor`, `preflight`, `why`, `glossary`, `decisions`, `ownership`, `pre-mortem` and `negotiate`. The Wave 6 answer-quality set followed and closed it out: agent brief synthesis (`[agents] synthesis`, invariant `I31`), `nimbus ask --devil`, the `[persona]` `tone`/`voice` vocabulary, `nimbus stats` for bucketed time series over the index, and first-class negation queries.

**Now building (S2 — Local Compute Fleet)**, opened 2026-08-21 with nothing shipped in it yet: sandboxed code execution, a HITL-gated local computer-use loop where screenshots never leave the machine, runtime tool generation, multimodal I/O, overnight sub-agent fleets on compute you already own, and bring-your-own-frontier-model routing with local fallback. S1 made the local index answerable; S2 makes local compute usable.

The dated delivery log is [`CHANGELOG.md`](./CHANGELOG.md) — it is the single source for what landed when. [`roadmap.md`](./roadmap.md) carries the acceptance criteria, sequencing, and per-phase summaries. Command-level detail for everything above is in [`cli-reference.md`](./cli-reference.md).

---

## Prerequisites (source build)

The published installers above bundle everything; these apply only if you build from source.

### Required on every platform

- **[Bun v1.2+](https://bun.sh/docs/installation)** — runtime, package manager, test runner. Verify with `bun --version`.
- **Git** — for cloning the repo and the build's git-info embedding.
- **A C++ build toolchain** — needed for the rare native dep that has no prebuilt binary for your platform.
  - Windows: [Microsoft Visual C++ Redistributable](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist) and Visual Studio Build Tools (Desktop development with C++ workload).
  - macOS: `xcode-select --install`.
  - Linux: `build-essential` (Debian/Ubuntu) or `Development Tools` (Fedora/Arch).

### Required only for the Tauri 2.0 desktop UI (`packages/ui`)

The headless Gateway and CLI build without these. Skip if you only want `nimbus` in the terminal.

- **[Rust toolchain](https://www.rust-lang.org/tools/install)** — install via `rustup`; Tauri needs `cargo` and a stable `rustc` (≥ 1.78 recommended).
- **Platform WebView dependencies:**
  - **Windows 10+** — WebView2 Runtime (preinstalled on Windows 11; install [Evergreen Bootstrapper](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) on older Windows 10 builds).
  - **macOS 13+** — Xcode Command Line Tools.
  - **Linux (Ubuntu/Debian)** — `sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev`.
  - Other distros: see the [Tauri prerequisites guide](https://tauri.app/start/prerequisites/).

### Required at runtime on Linux only

- **`libsecret`** — backs the Vault on Linux (Windows uses DPAPI; macOS uses Keychain — both built-in).
  - Debian/Ubuntu: `sudo apt install libsecret-1-0 libsecret-tools` (the `-tools` package provides `secret-tool`, which `nimbus doctor` checks for).
  - Fedora/Arch: `sudo dnf install libsecret` / `sudo pacman -S libsecret`.
  - You also need a running Secret Service implementation — `gnome-keyring`, KWallet (kwallet5/6), or `keepassxc` with Secret Service enabled. On a headless Linux server, use `gnome-keyring-daemon --unlock` in your session script.

### Native dependencies installed by `bun install`

The Gateway's local embedder uses **`@xenova/transformers`**, which depends on **`sharp`** and a platform binary such as **`@img/sharp-win32-x64`**. These are pulled in automatically by `bun install` — you do not install them system-wide. If Sharp fails to download or build, remove `node_modules` and re-run `bun install` with install scripts enabled.

Gateway binaries built with `bun build --compile` bundle JavaScript into a single file, and Sharp's native `.node` file may not load inside that layout on some platforms. If `nimbus-gateway` exits with a Sharp error, run the Gateway **from source** with `bun` after `bun install` (for example `cd packages/gateway && bun run dev`). Linux `.deb` / tarball artifacts from CI are normal compiled binaries — end users do not run `npm install sharp`; if a packaged binary ever fails the same way, the fix is in build/packaging, not an extra OS package on the user's machine.

### Optional — only needed if you enable the corresponding feature

| Feature | Requirement | How to install |
|---|---|---|
| **Local LLM (Ollama)** | [Ollama](https://ollama.com/download) running on `localhost:11434`, plus at least one pulled model (e.g. `ollama pull llama3.2`) | Default endpoint: `http://127.0.0.1:11434`. Set the local model with `nimbus config set llm.local_model <model>` and prefer it with `nimbus config set llm.prefer_local true`. |
| **Local LLM (llama.cpp)** | A `llama-server` HTTP endpoint reachable from the Gateway | Default endpoint: `http://127.0.0.1:8080`; override with `nimbus config set llm.llamacpp_server_path http://127.0.0.1:8080`. The key stores the HTTP base URL, not the binary path. |
| **Cloud LLM (Anthropic)** | Anthropic API key | Export `ANTHROPIC_API_KEY=…` in the Gateway's environment, then `nimbus config set llm.remote_model claude-sonnet-4-6` (provider is inferred from the model id; `claude-*` → Anthropic). |
| **Cloud LLM (OpenAI)** | OpenAI API key | Export `OPENAI_API_KEY=…`, then `nimbus config set llm.remote_model gpt-4o` (provider is inferred; `gpt-*` / `o1-*` / `o3-*` / `o4-*` → OpenAI). |
| **Voice — STT (push-to-talk hotkey / wake-word loop)** | `whisper-cli` (whisper.cpp) on PATH, plus `ffmpeg` for audio capture | Build whisper.cpp from source or install via `brew install whisper-cpp`; `ffmpeg` via your distro/`brew`. Set `voice.whisper_path` if not on PATH. |
| **Voice — TTS** | macOS: `say` (built-in). Windows: PowerShell SAPI (built-in). Linux: `espeak-ng` (preferred) or `spd-say` | `sudo apt install espeak-ng` / `brew install espeak-ng`. |
| **Wake-word loop** | Same as STT, plus a microphone configured at the OS level | Verify with `nimbus doctor` — voice section appears when `[voice].enabled = true`. |
| **GPU acceleration for embeddings or LLM** | Provider-specific (CUDA, ROCm, Metal). Nimbus serializes GPU access via `GpuArbiter` | Configure your provider's GPU support; Nimbus does not require any extra config. |

Once installed, run **`nimbus doctor`** — it checks every prerequisite above and prints actionable remediation for anything missing.

### Build from source

```bash
git clone https://github.com/nimbus-agent/Nimbus.git
cd Nimbus
bun install          # NOT "bun run install" — that looks for a script and fails
                     # Installs sharp + platform @img/sharp-* for embeddings (via @xenova/transformers)
bun run build
```

Built CLI location:

| OS | Path |
|---|---|
| Windows | `packages\cli\dist\nimbus.exe` |
| macOS / Linux | `./packages/cli/dist/nimbus` |

Add `packages/cli/dist` to your `PATH` or call with a full path.

---

## First-Run Configuration

The first time the Gateway starts it creates a default `nimbus.toml` in the platform config directory and an empty SQLite index in the data directory:

| Platform | Config (`nimbus.toml`) | Data (`index.db`, `audit.db`, `backups/`, `logs/`) |
|---|---|---|
| Windows | `%APPDATA%\Nimbus\nimbus.toml` | `%LOCALAPPDATA%\Nimbus\data` |
| macOS | `~/Library/Application Support/Nimbus/nimbus.toml` | `~/Library/Application Support/Nimbus` |
| Linux | `~/.config/nimbus/nimbus.toml` | `~/.local/share/nimbus` |

`NIMBUS_CONFIG_DIR` moves the config directory only — it deliberately does not move the data directory, and there is no data-directory override (on Linux the data root follows `XDG_DATA_HOME`). Most TOML keys also have a corresponding `NIMBUS_`-prefixed env var override that wins over the file (e.g. `NIMBUS_AGENT_MODEL`, `NIMBUS_CLASSIFIER_MODEL`, `NIMBUS_TELEMETRY_ENABLED`) — see [`cli-reference.md`](./cli-reference.md#environment-variables).

`nimbus ask` needs an LLM; indexing, `nimbus why` and the deterministic briefs do not. Remote model ids are inferred: `claude-*` → Anthropic, `gpt-*` / `o1-*` / `o3-*` / `o4-*` → OpenAI. Local model ids are passed to Ollama or llama.cpp through `[llm].local_model`.

```bash
# Cloud (default — fastest path to a working install).
# Defaults are claude-sonnet-4-6 (agent) + claude-haiku-4-5-20251001 (classifier);
# only set these if you want to override.
export ANTHROPIC_API_KEY=sk-ant-…
nimbus config set llm.remote_model      claude-sonnet-4-6
nimbus config set llm.classifier_model  claude-haiku-4-5-20251001

# OR fully local (no network calls; requires Ollama running)
ollama pull llama3.2
nimbus config set llm.local_model llama3.2
nimbus config set llm.prefer_local true
```

See [`cli-reference.md`](./cli-reference.md#configuration-file) for the full `nimbus.toml` schema.

---

## Everyday Use

### Start the Gateway

```bash
nimbus start     # Start Gateway as a background process
nimbus status    # Verify it's running; check connector health
nimbus doctor    # Re-run any time something seems off — checks Bun, Vault, Gateway, index, voice, …
```

### Authenticate services

```bash
# Cloud storage & communication
nimbus connector auth google       # OAuth PKCE — opens browser
nimbus connector auth microsoft

# Developer services
nimbus connector auth github       # PAT — stored in OS keystore
nimbus connector auth gitlab
nimbus connector auth linear
nimbus connector auth jira
nimbus connector auth slack

nimbus connector list              # All connectors + sync status
nimbus connector sync github       # Manually trigger a sync cycle
```

### Query

```bash
nimbus ask "Find all PDFs I received by email last month that I haven't opened"
nimbus ask "Which of my open PRs mention payment-service?" --devil   # argue against the plan
nimbus search "quarterly review" --service google_drive --type pdf --limit 20
```

### Built-in agent briefs

Read-only, no HITL, and they render deterministically with no LLM configured:

```bash
nimbus why src/auth.ts:42                 # line provenance across six lanes
nimbus expert payment-service             # who has the most context
nimbus impact src/billing/retry.ts        # reverse-dependency blast radius
nimbus catchup --since 7d                 # personalized retrospective digest
nimbus owners src/billing/                # ownership graph
nimbus glossary                           # mined domain terminology
nimbus decisions                          # implicit ADRs
nimbus pre-mortem                         # comparable-history risk brief
nimbus negotiate --person <id> --since 90d  # cited contribution brief
```

### Metrics and proof

```bash
nimbus metrics dora --service payment-service     # four DORA metrics, one window
nimbus stats mttr --service payment-service --window 90d --bucket 1w --json
nimbus prove --since 24h                          # what left the machine
nimbus egress verify                              # BLAKE3 chain integrity
```

### Observe and debug

> **First debugging step:** run `nimbus doctor`. It checks your Bun version, vault availability, Gateway connectivity, index health, and connector states — and prints actionable remediation for anything it finds.

```bash
# Structured index queries
nimbus query --service github --type pr --since 7d --json
nimbus query --sql "SELECT title FROM items WHERE pinned = 1" --pretty

# Diagnostics and slow queries
nimbus diag
nimbus diag slow-queries --limit 10

# Connector health history
nimbus connector history github

# Re-ingest a connector at a specified depth (prunes existing body/embeddings; writes audit entry)
nimbus connector reindex github --depth metadata_only

# Database integrity
nimbus db verify
nimbus db repair          # --yes to skip confirmation
nimbus db snapshot
```

### Configure

```bash
nimbus config list
nimbus config get sync.intervalSeconds
nimbus config set sync.intervalSeconds 300
nimbus config validate

nimbus profile create work
nimbus profile switch work        # takes effect on the next Gateway start
nimbus profile list
```

### Run a script

```bash
nimbus run ./weekly-cleanup.yml
```

```yaml
# weekly-cleanup.yml
name: weekly-cleanup
steps:
  - Find all PDF files in Google Drive not opened in 90 days
  - Summarize them by project folder
  - Move the ones from the Zurich project to /Archive/2025
  - Send me an email with the summary
```

Before executing, Nimbus shows a full plan preview identifying every step that will require consent:

```text
Script: weekly-cleanup (4 steps)

  Step 1  Find PDFs not opened in 90 days       READ — no approval needed
  Step 2  Summarize by project folder            READ — no approval needed
  Step 3  Move 12 files to /Archive/2025         ⚠ REQUIRES APPROVAL
  Step 4  Send summary email                     ⚠ REQUIRES APPROVAL

Proceed? [y/n]:
```

### Install a community extension

```bash
nimbus extension install @community/nimbus-notion
nimbus extension list
```

The complete command reference — every subcommand, flag, exit code, and the full `nimbus.toml` schema — is [`cli-reference.md`](./cli-reference.md).

---

## Tech Stack

| Layer | Technology |
|---|---|
| **Runtime** | [Bun v1.2+](https://bun.sh) — native TypeScript, fast startup, built-in SQLite |
| **Language** | TypeScript 7.x strict mode |
| **Agent Framework** | [Mastra](https://mastra.ai) — structured agents, tool registration, workflow orchestration |
| **Integration Protocol** | [Model Context Protocol](https://modelcontextprotocol.io) — all connectors speak MCP; Engine never calls cloud APIs directly |
| **Local Database** | `bun:sqlite` + [sqlite-vec](https://github.com/asg017/sqlite-vec) — metadata index + vector search |
| **Secrets — Windows** | Windows DPAPI |
| **Secrets — macOS** | Keychain Services |
| **Secrets — Linux** | Secret Service API via `libsecret` |
| **IPC** | JSON-RPC 2.0 over Domain Socket / Named Pipe — local-only, no TCP surface |
| **CLI** | Bun + [@clack/prompts](https://github.com/natemoo-re/clack) |
| **Desktop UI** | [Tauri 2.0](https://tauri.app) + React 19 (~5MB native shell) |
| **LLM** | Local Ollama / llama.cpp via the Nimbus router, or Anthropic/OpenAI via the Mastra agent path |
| **Embeddings** | `@xenova/transformers` (local, no API key) / OpenAI (opt-in) |
| **Extension SDK** | `@nimbus-dev/sdk` (MIT-licensed npm package) |
| **Client Library** | `@nimbus-dev/client` (MIT-licensed npm package) — typed IPC wrapper; `MockClient` for scripts and extensions |
| **Testing — Gateway/CLI** | `bun test` |
| **Testing — UI** | Vitest + `@testing-library/react` |
| **Testing — E2E Desktop** | Playwright + Tauri WebDriver |
| **CI** | GitHub Actions — PR: Ubuntu `pr-quality`; Push: full 3-platform matrix |
| **Release** | `bun build --compile` — single signed binary per platform |

---

## Cross-Platform Support

| | Windows 10+ | macOS 13+ | Ubuntu 22.04+ † |
|---|---|---|---|
| **Gateway IPC** | Named Pipe | Unix Socket | Unix Socket |
| **Secrets** | DPAPI | Keychain | libsecret |
| **Autostart** | Registry | LaunchAgents | systemd user |
| **Notifications** | Win32 Toast | NSUserNotification | libnotify/D-Bus |
| **Config dir** | `%APPDATA%\Nimbus` | `~/Library/…/Nimbus` | `~/.config/nimbus` |
| **Desktop UI** | WebView2 | WKWebView | WebKitGTK |
| **CI runner** | `windows-2025` | `macos-15` | `ubuntu-24.04` |
| **Release** | `.zip` + `.msi` (currently unsigned) † | `.tar.gz` + `.pkg` (currently unsigned) † | `.deb` / `.rpm` + AppImage + GPG-signed apt/yum repo |

† **Ubuntu 22.04 is supported for source builds only.** Pre-built Linux binaries are compiled on Ubuntu 24.04 and require **glibc ≥ 2.39** at runtime (Ubuntu 24.04+, Fedora 40+, Debian 13+, Arch / other current rolling releases). Ubuntu 22.04 LTS, Debian 12, and RHEL 9 (and derivatives) will fail with `GLIBC_2.39 not found`. See [SECURITY.md](./SECURITY.md#linux-runtime-support--glibc-floor) for the canonical supported-distro list and rationale.

† **macOS and Windows installers currently ship unsigned** (signing not yet landed). Cross-platform integrity is provided by the GPG-signed `SHA256SUMS.asc` manifest. macOS Gatekeeper and Windows SmartScreen will prompt on first run; this is expected. Apple Developer notarization and Windows Authenticode signing are deferred to a later point release — see [signing-keys.md](./release/signing-keys.md#v010-signing-cut-line).

---

## Security

- **No plaintext credentials** — OAuth tokens live in the OS keystore. There is no code path that writes them elsewhere.
- **Structural HITL gate** — every delete, send, and move is blocked at the executor by a compile-time constant set. The agent cannot reason around a function that doesn't exist.
- **Extension isolation** — third-party extensions run as sandboxed child processes (bwrap + seccomp on Linux, `sandbox-exec` on macOS, AppContainer on Windows), receive only their declared service's credentials, and cannot reach the Vault or other connectors. Publisher manifests are Ed25519-verified at install and on every Gateway startup.
- **Full audit log** — every action, including every HITL decision, is recorded in a local BLAKE3-chained SQLite table before the action executes; `nimbus audit verify` proves the chain.
- **Egress ledger** — every authorized outbound action is appended to an append-only, BLAKE3-chained ledger before dispatch, and a failed append aborts the action. `nimbus prove` reports what left the machine.
- **Thirty-two enumerated invariants** — `I1`–`I27` and `I29`–`I33`, each with a production wiring site, a section in [`SECURITY-INVARIANTS.md`](./SECURITY-INVARIANTS.md), and an enforcement test. `I28` is a reserved number, deliberately skipped: it has no wiring, no section and no test, so it is not one of the thirty-two. A static audit runs before the test suite; the runtime tests stay authoritative.
- **Internal security audit (B1, 2026-04-25)** — 8 trust surfaces reviewed; 78 unique findings filed (0 Critical); all High and Medium items closed pre-`v0.1.0`. One Low item (`S6-F1`) closed in `v0.1.0`, and the two Tauri-specific Low items (`S4-F6`, `S4-F8`) are deferred to Phase 13 (`desktop-v0.1.0`); see [SECURITY.md](./SECURITY.md#security-audits) for the full record. A formal third-party penetration test is scheduled for Phase 12.

> **Note:** Nimbus's guarantees hold at the process boundary. It is not a firewall, antivirus, or VPN application; endpoint protection (AV/EDR), network security (VPN/Firewall), and OS-level hardening are your responsibility. See [SECURITY.md](./SECURITY.md) for the full boundary definition.

Found a vulnerability? See [`SECURITY.md`](./SECURITY.md) and the [security model & disclosure policy](https://github.com/nimbus-agent/nimbus-security).

---

## Extensions

Two different things live under the same command family, and picking the wrong one costs an afternoon.

**Writing a connector** — something that indexes a service into your local index. Use
[`create-nimbus-connector`](https://github.com/nimbus-agent/create-nimbus-connector). Describe the
service in a JSON spec and it emits the whole package: `src/server.ts`, the manifest, the
tsconfig, the package.json, a README and `test/sandbox.test.ts` — plus `src/search-filter.ts` when
the spec declares a search tool.

```bash
bunx create-nimbus-connector --spec ./my-service.spec.json --standalone
cd my-service && bun run typecheck && bun test
```

**Writing a generic extension** — anything that is not a connector. `nimbus scaffold extension`
emits a four-file shell for that case; it does not produce a connector, and a package it
generates is invisible to the connector gates because it has no `src/server.ts`.

```bash
nimbus scaffold extension my-extension   # always created at ./my-extension/ in the cwd
cd my-extension                          # the scaffold does NOT change your working directory
nimbus extension install .               # Test locally
npm publish --access public              # Publish to the community
```

The Gateway handles OAuth, credential storage, sync scheduling, and HITL enforcement either way.
You write the service API integration.

Extensions declare permissions in `nimbus.extension.json`. Write and delete tools must declare `hitlRequired` — the Gateway enforces HITL automatically for those tool calls regardless of how the extension implements them.

---

## Testing

Five-layer pyramid:

1. **Unit (`bun test`)** — Engine logic, Vault contracts, HITL invariants, manifest validation. Co-located with source. Runs in milliseconds.
2. **Integration (`bun test` + real SQLite)** — connector sync, index queries, extension loading and isolation. Each test gets a fresh temp dir + fresh DB.
3. **E2E CLI (`bun test` + Gateway subprocess)** — full CLI command flows against a real Gateway backed by mock MCP servers.
4. **UI Components (Vitest + Testing Library)** — React components in the Tauri WebView. Vitest is used here because `bun test` does not support jsdom.
5. **E2E Desktop (Playwright + Tauri WebDriver)** — full desktop flows on all three platforms. Runs on push to `main` and release tags.

Run `bun run preflight` for full CI parity before opening a PR (`bun run preflight:fast` for the cheap static gates). Security scans: `bun audit`, `trivy`, and CodeQL on every PR; Dependabot for dependency updates; SonarCloud as a blocking quality gate. HIGH/CRITICAL findings block merges. See [`testing.md`](./testing.md).

---

## Project Structure

```text
nimbus/
├── packages/
│   ├── gateway/              # Core headless Gateway (Bun)
│   │   └── src/
│   │       ├── platform/     # PAL: win32, darwin, linux implementations
│   │       ├── engine/       # Mastra agent, router, planner, HITL executor, persona
│   │       ├── agents/       # The fourteen built-in read-only brief agents
│   │       ├── vault/        # DPAPI, Keychain, libsecret
│   │       ├── db/           # verify, repair, snapshot, health, metrics, latency ring buffer
│   │       ├── index/        # SQLite schema + migrations, item store, body/depth
│   │       ├── connectors/   # Connector registry, lazy mesh, health model
│   │       ├── sync/         # Delta sync scheduler, connectivity probe, targeted fetch
│   │       ├── egress/       # Append-only BLAKE3 egress ledger (I29) + `nimbus prove`
│   │       ├── glossary/     # Implicit-knowledge terminology extraction
│   │       ├── decisions/    # Implicit ADR extraction
│   │       ├── ownership/    # Ownership graph
│   │       ├── premortem/    # Comparable-history risk themes
│   │       ├── metrics/      # DORA calculators + bucketed time series (`nimbus stats`)
│   │       ├── federation/   # Phase 6 Team: query gate, namespaces, RBAC, pairing
│   │       ├── identity/     # OIDC device-code SSO, SCIM provisioning
│   │       ├── teamvault/    # Team-shared credentials + quorum HITL
│   │       ├── share/        # Signed, redacted outbound shares (I27)
│   │       ├── clips/        # Web-clipper surface + pairing window (I30)
│   │       ├── chatops/      # Reply dispatcher (I23)
│   │       ├── policy/       # Signed org policy, monotonic-stricter resolution (I22)
│   │       ├── extensions/   # Extension registry, manifest validator, sandbox
│   │       ├── telemetry/    # Opt-in aggregate telemetry collector
│   │       ├── config/       # Config loader, profiles, env-var overrides, persona
│   │       ├── llm/          # Ollama + llama.cpp providers, router, registry, GPU arbiter
│   │       ├── voice/        # STT (whisper-cli), TTS (NativeTtsProvider), wake-word
│   │       └── ipc/          # JSON-RPC 2.0 server, HTTP API, Prometheus endpoint
│   ├── cli/                  # nimbus CLI (+ Ink TUI)
│   │   └── src/commands/     # ask, search, query, why, prove, stats, glossary, decisions,
│   │                         # config, profile, diag, doctor, db, connector, extension, …
│   ├── ui/                   # Tauri 2.0 desktop app (Phase 4; release vehicle in Phase 13)
│   ├── docs/                 # Astro Starlight documentation site
│   ├── admin-console/        # Static admin console served at /admin/*
│   └── github-actions/       # First-party GitHub Actions (not workspace members)
├── docs/
│   ├── README.md             # this file — the repository landing page
│   ├── architecture.md       # subsystem design, IPC catalogue, schema reference
│   ├── SECURITY.md           # security model + vulnerability reporting
│   ├── SECURITY-INVARIANTS.md# I1–I34 rationale + anti-patterns
│   ├── roadmap.md            # acceptance-criteria-driven roadmap
│   ├── CHANGELOG.md          # dated delivery log (canonical)
│   ├── cli-reference.md      # full CLI + nimbus.toml reference
│   ├── CONTRIBUTING.md       # contributor workflow and constraints
│   ├── CODE_OF_CONDUCT.md    # community standards
│   ├── release/              # release runbooks + manual smoke checklist
│   ├── templates/            # copy-paste CI (e.g. extension authors)
│   └── contributors/         # author walkthroughs
├── .github/
│   └── workflows/            # ci.yml, security.yml, codeql.yml, release.yml, …
├── bunfig.toml
└── package.json              # Bun workspace root
```

Several surfaces live in their own repos and release independently of the Gateway — see the [Ecosystem](#ecosystem) table below.

---

## Ecosystem

Nimbus is a gateway plus a set of surfaces that talk to it. All of these are separate, independently released repositories:

| Repo | What it is |
|---|---|
| [nimbus-sdk](https://github.com/nimbus-agent/nimbus-sdk) | The extension-authoring contract (npm, MIT) — what a connector is written against |
| [nimbus-client](https://github.com/nimbus-agent/nimbus-client) | Typed IPC wrapper (npm, MIT) — how a client talks to the gateway; consumed by `packages/cli` and the VS Code extension |
| [nimbus-mcp](https://github.com/nimbus-agent/nimbus-mcp) | `@nimbus-dev/mcp` (npm, MIT) — the launcher that exposes your local index and agents to any MCP client; listed in the official MCP Registry as `io.github.nimbus-agent/nimbus` |
| [create-nimbus-connector](https://github.com/nimbus-agent/create-nimbus-connector) | Scaffolding generator for a new connector |
| [nimbus-vscode](https://github.com/nimbus-agent/nimbus-vscode) | VS Code / Open VSX extension |
| [nimbus-web-clipper](https://github.com/nimbus-agent/nimbus-web-clipper) | Chrome + Firefox MV3 web clipper; the gateway-side surface stays in this repo |
| [nimbus-raycast](https://github.com/nimbus-agent/nimbus-raycast) | Raycast extension — quick-ask over the local gateway |
| [awesome-nimbus](https://github.com/nimbus-agent/awesome-nimbus) | Curated connectors, recipes, extensions and resources |

The SDK and client are **MIT**, not AGPL — building on Nimbus does not pull the core's license into your project.

---

## Contributing

Architecture is stabilizing; not all interfaces are frozen.

1. Read [`architecture.md`](./architecture.md) — understand the subsystems and their contracts.
2. Review the **non-negotiables** below — they are not aspirational values; PRs that violate them will not be merged.
3. Check issues tagged `good first issue`.
4. Open a discussion before large PRs.

**Adding a connector is the easiest way in.** Run [`create-nimbus-connector`](https://github.com/nimbus-agent/create-nimbus-connector) from the repository root — `bunx create-nimbus-connector --spec ./your-service.spec.json` — and it emits the whole connector package: the server, the manifest, the tsconfig, the package.json and a test. See [Contributing](./CONTRIBUTING.md#adding-a-new-mcp-connector).

For workflow, verification commands, and PR expectations, see [`CONTRIBUTING.md`](./CONTRIBUTING.md). Community standards are in [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md).

**Non-negotiables** — PRs violating these will not be merged:

- Local-first: no credentials or user data leaving the machine without explicit user action
- HITL is structural: consent gate in the executor, not the prompt
- No plaintext credentials: Vault only
- Platform equality: all three platforms, always
- MCP as connector standard: Engine never calls cloud APIs directly
- No `any`: use `unknown` for external data; TypeScript strict mode
- License integrity: contributions to core packages must be AGPL-3.0 compatible

**Community:**

- 💬 [GitHub Discussions](https://github.com/nimbus-agent/Nimbus/discussions) — questions, ideas, show-and-tell.
- 🧩 [awesome-nimbus](https://github.com/nimbus-agent/awesome-nimbus) — connectors, recipes, extensions.

---

## Pricing

| Tier | For | Status |
|---|---|---|
| **Open Source** | Individual engineers — AGPL-3.0, full feature set for single-user deployments | Available now |
| **Team** | Shared index namespaces, Team Vault, multi-user HITL, LAN federation — Phase 6 | ✅ Complete |
| **Enterprise** | SSO/SCIM, compliance tooling, audit log shipping, Helm/Docker, SLA support — Phase 12 | Planned |

The Extension SDK (`@nimbus-dev/sdk`) is MIT-licensed — extension authors have no copyleft obligation.

Commercial license for embedding Nimbus in a product without AGPL obligations, or for organizations that need Team/Enterprise features before those phases ship: contact the maintainers.

---

## License

Dual-licensed by design.

**Core (Gateway, CLI, MCP connectors):** AGPL-3.0 — see [LICENSE](../LICENSE). Anyone running Nimbus as a network service must publish their modifications under the same terms. This is intentional: the AGPL protects users by preventing vendors from stripping the privacy guarantees and offering a hosted "Nimbus Cloud."

**Extension SDK (`@nimbus-dev/sdk`) and client library (`@nimbus-dev/client`):** MIT — so extensions and integrations stay unencumbered.

---

<div align="center">

**[Architecture](./architecture.md) · [Roadmap](./roadmap.md) · [CLI Reference](./cli-reference.md) · [Changelog](./CHANGELOG.md) · [Security](./SECURITY.md) · [Releases](https://github.com/nimbus-agent/Nimbus/releases)**

</div>
