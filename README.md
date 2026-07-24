<div align="center">

# Nimbus

**Cross-service incident context in under 100 ms. Consent-gated automation. Your credentials never leave the machine.**

A local-first, HITL-gated AI agent over your dev tools — it builds a private index of your work across 80+ services and answers questions and runs multi-step workflows entirely on your machine.

[![CI](https://github.com/nimbus-agent/Nimbus/actions/workflows/ci.yml/badge.svg)](https://github.com/nimbus-agent/Nimbus/actions/workflows/ci.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](./LICENSE)
[![Docs](https://img.shields.io/badge/docs-nimbus--agent.dev-1f6feb.svg)](https://nimbus-agent.dev)
[![Discussions](https://img.shields.io/badge/community-GitHub%20Discussions-238636.svg)](https://github.com/nimbus-agent/Nimbus/discussions)

[**Install**](#quickstart) · [**Docs**](https://nimbus-agent.dev) · [**Watch the 90-second cast**](https://asciinema.org/a/MnH4zEtmLxgfOGoy) · [**Architecture**](https://nimbus-agent.dev/architecture-overview/)

</div>

---

> [!NOTE]
> Nimbus is a **headless Gateway + CLI** (plus a VS Code extension and a browser web clipper). It runs on your machine and talks to ~80 cloud services through first-party MCP connectors. Nothing about your data — the index, your credentials, the audit log — leaves your box.

## What it does

Three things, in one query:

- **Incident response** — PagerDuty alert → deploy → commit → author, correlated locally.
- **CVE / code exposure** — indexed code search across every connected repo, with **no fan-out network calls**.
- **Data lineage** — Tableau → Looker → dbt → Airflow → the renamed column.

## Three load-bearing words

- **local** — the SQLite index, the Vault, and the audit log all live on your machine. The cloud is a connector, not the source of truth.
- **consent-gated** — every destructive or outbound action is intercepted by a human-in-the-loop gate *before* it runs. It lives in the executor, not the prompt, so it can't be jailbroken away.
- **MCP** — every connector speaks the [Model Context Protocol](https://modelcontextprotocol.io/). The engine never calls a cloud API directly.

## Quickstart

**1. Install** (per-user, no admin/sudo required):

<details open>
<summary><b>macOS / Linux</b></summary>

```bash
curl -fsSL https://github.com/nimbus-agent/Nimbus/releases/latest/download/install.sh -o /tmp/nimbus-install.sh
# inspect it first if you like:  less /tmp/nimbus-install.sh
bash /tmp/nimbus-install.sh
nimbus --version
```

</details>

<details>
<summary><b>Windows (PowerShell, no admin)</b></summary>

```powershell
irm https://github.com/nimbus-agent/Nimbus/releases/latest/download/install.ps1 | Invoke-Expression
# open a new PowerShell window:
nimbus --version
```

</details>

Every release artefact is GPG-signed (key `5A20457CCD8B53FFAA945240886ADA6B487CAB6E`) with a SHA-256 manifest and build-provenance attestations — see [Verify your download](https://nimbus-agent.dev/user-guide/verify-your-download/). Homebrew and Scoop taps are also available (see the [install guide](https://nimbus-agent.dev/user-guide/install/)).

**2. Connect a service** — the fastest path is a token-based connector like GitHub:

```bash
nimbus connector auth github --token <your_PAT>
nimbus connector sync github
```

(OAuth services — Google Drive, Gmail, Slack, … — use `nimbus connector add <service>`, which opens your browser. See [Connect a service](https://nimbus-agent.dev/user-guide/connect-service/).)

**3. Ask:**

```bash
nimbus ask "what PRs did I open in the last 7 days?"
```

Or trace any line's provenance — who wrote it, the PR, the ticket, the incident it responded to, and what breaks downstream:

```bash
nimbus why src/auth.ts:42
```

### Run it fully offline

Nimbus needs an LLM, but it does **not** require a cloud one. Point it at a local model and nothing — not even prompts — leaves the machine:

```toml
# ~/.config/nimbus/nimbus.toml
[llm]
prefer_local = true
local_model  = "llama3.1"     # served by Ollama on http://127.0.0.1:11434
```

See [Local & air-gapped LLM setup](https://nimbus-agent.dev/user-guide/first-run-setup/).

## How it works

```text
80+ cloud services ─▶ first-party MCP connectors ─▶ local SQLite index (+ embeddings)
                                                          │
                              your question ─▶ engine ─▶ HITL consent gate ─▶ action
                                                          │
                                       CLI · VS Code · web clipper · (desktop, coming)
```

A headless **Bun Gateway** maintains the private index and runs the agent; clients talk to it only over local JSON-RPC IPC. Credentials live in the OS keystore (DPAPI / Keychain / libsecret) — never in logs, config, or IPC. Full design: [Architecture](https://nimbus-agent.dev/architecture-overview/).

## Connectors

80+ first-party MCP connectors across Google, Microsoft, GitHub/GitLab, Slack, Jira, Notion, plus observability, CI/CD, security/quality, feature-flags, GitOps, data/BI, deploy, finance, and support tools. Browse the full roster in the [connector docs](https://nimbus-agent.dev/connectors/); building your own is covered in [CONTRIBUTING](./docs/CONTRIBUTING.md).

## Security & trust

- **Human-in-the-loop** consent on every outbound/destructive action (structural, not a prompt).
- **No plaintext credentials** — OS Vault only.
- **Signed, reproducible releases** — GPG manifests, SBOM (CycloneDX), build-provenance attestations.
- **Audited** — see the [security model & disclosure policy](https://github.com/nimbus-agent/nimbus-security).

Found a vulnerability? See [SECURITY.md](./.github/SECURITY.md).

## Community & contributing

- 💬 **[GitHub Discussions](https://github.com/nimbus-agent/Nimbus/discussions)** — questions, ideas, show-and-tell.
- 🧩 **[awesome-nimbus](https://github.com/nimbus-agent/awesome-nimbus)** — connectors, recipes, extensions.
- 🛠️ **[CONTRIBUTING.md](./docs/CONTRIBUTING.md)** — good-first-issues, workflow, and the contributor walkthrough. PRs welcome.

## License

Dual-licensed by design: **AGPL-3.0** for the gateway, CLI, and MCP connectors; **MIT** for the separately-published [`@nimbus-dev/sdk`](https://github.com/nimbus-agent/nimbus-sdk) and [`@nimbus-dev/client`](https://github.com/nimbus-agent/nimbus-client) npm packages so extensions and integrations stay unencumbered.
