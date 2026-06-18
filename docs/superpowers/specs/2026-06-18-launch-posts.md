# Nimbus — Launch Posts & Channel Playbook

**Date:** 2026-06-18
**Status:** Draft copy — ready to queue once Phase 0 (README + demo path + community home) is done.

> **Rules of the road.** (1) Lead with the **CLI** — desktop is deferred; don't market it. (2) Never cross-post identical text; each community gets its own framing. (3) Be present in comments for ~8 hours on launch day. (4) Be honest about what's GA vs. roadmap. (5) Replace every `‹…›` placeholder (repo URL, GIF link, your handle) before posting.

---

## 1. Show HN

**Title:**
`Show HN: Nimbus – a local-first, HITL-gated AI agent over your dev tools`

**Body:**
> Nimbus is a headless agent that builds a private SQLite index of your work across ~80 services (GitHub, Slack, Jira, PagerDuty, Datadog, Tableau, …) and answers questions / runs multi-step workflows — entirely on your machine. The index, your credentials (in the OS keystore), and the audit log never leave the box; the cloud is just a connector.
>
> Two things I cared about building it:
>
> - **Human-in-the-loop is structural.** Every outbound/destructive action hits a consent gate in the executor, not the prompt — so a jailbroken prompt can't bypass it.
> - **MCP-native.** Every connector speaks the Model Context Protocol; the engine never calls a cloud API directly. Next up: exposing your whole private index *as* an MCP server you attach to Claude Desktop/Cursor.
>
> It needs an LLM but not a cloud one — point it at Ollama and nothing, not even prompts, leaves the machine. Bun + TypeScript, AGPL-3.0 (MIT SDK). 90-sec cast: ‹asciinema link›. Repo: ‹repo URL›.
>
> Happy to answer anything about the local-first architecture, the HITL gate, or the connector model.

*Tip: submit ~8–10am ET on a weekday; reply fast and substantively.*

---

## 2. Product Hunt

**Tagline (≤60 chars):** `Local-first AI agent over your dev tools — your data stays put`
**Topics:** Developer Tools, Artificial Intelligence, Privacy, Open Source
**Description:**
> Nimbus indexes your work across 80+ tools into a private, on-machine SQLite index and answers questions / runs workflows locally. Human-in-the-loop consent on every action. Credentials never leave your machine. MCP-native. Runs fully offline with Ollama. AGPL-3.0.

**Maker's first comment:** the Show HN body, lightly warmed up ("Hey PH 👋 — I built Nimbus because…").
*Needs the GIF + 2–3 screenshots. Schedule 12:01am PT.*

---

## 3. Reddit — r/devops

**Title:** `I built a local-first, on-call AI agent: PagerDuty→deploy→commit→author correlated in <100ms, no data leaving the box`
**Body:**
> Spent the last while building Nimbus — a headless agent for the on-call/platform workflow. It keeps a local index across your stack (PagerDuty, Datadog/Grafana, GitHub/GitLab, deploys, Slack, Jira) so you can ask things like "what changed before this incident?" and get the deploy → commit → author chain correlated locally in well under a second, with no fan-out API calls at query time.
>
> It also does DORA metrics, blast-radius/impact analysis on a file or PR, and HITL-gated actions (ack a PagerDuty incident, post to Slack) where *you* approve before anything fires. Runs offline with Ollama. AGPL.
>
> CLI-first today. Would love feedback from people who actually carry a pager — what would make this useful in your rotation? Repo + 90s cast: ‹links›.

*Read r/devops self-promo rules; engage, don't drop-and-go.*

---

## 4. Reddit — r/selfhosted

**Title:** `Nimbus: a self-hosted AI agent that indexes your accounts locally — credentials and data never leave your machine`
**Body:**
> If you've wanted a ChatGPT-style assistant over your *own* tools without shipping your data to a SaaS, that's the whole point of Nimbus. It runs as a local gateway, stores everything in a SQLite index on your box, keeps secrets in your OS keychain, and can run the LLM locally via Ollama — so it works fully offline / air-gapped.
>
> 80+ connectors (Google, GitHub, Slack, Jira, Notion, observability, …), every action gated by a human-in-the-loop confirmation, signed releases (GPG + SBOM + provenance), AGPL-3.0. Per-user install, no admin.
>
> Setup + verify-your-download docs: ‹link›. Feedback welcome on what you'd want to self-host next.

---

## 5. Reddit — r/LocalLLaMA

**Title:** `Point your local model at your whole work life: Nimbus indexes 80+ tools locally and runs the agent on Ollama`
**Body:**
> Nimbus is a local-first agent that builds a private index of your data across ~80 services and runs the whole agent loop on a local model (Ollama / llama.cpp) — prompts and data never leave the machine. It's MCP-native, and the near-term plan is to expose your private index *as* an MCP server so you can attach it to any MCP client.
>
> Curious what this community thinks about the retrieval + local-model split, and which local models work best for multi-step tool use. AGPL, Bun/TS. ‹links›.

---

## 6. Lobsters

**Title:** `Nimbus: local-first, HITL-gated AI agent over your dev tools`
**Tags:** `ai`, `privacy`, `devops`
*(Short, technical, no marketing tone — link + one paragraph from the Show HN body. Only post if you have an account in good standing.)*

---

## 7. X / Mastodon / Bluesky thread

1/ I built Nimbus: a local-first AI agent over ~80 of your dev tools. The index, your credentials, the audit log — all on your machine. The cloud is just a connector. 🧵 ‹cast/GIF›

2/ Why local-first? A cloud assistant *is* the egress — it can only promise it won't leak your data. Nimbus structurally can't: there's no server. Run the LLM on Ollama and nothing, not even prompts, leaves the box.

3/ Human-in-the-loop is structural. Every outbound/destructive action hits a consent gate in the executor — not the prompt — so a jailbroken prompt can't bypass it.

4/ It's MCP-native: every connector speaks the Model Context Protocol. Next: expose your whole private index *as* an MCP server you plug into Claude Desktop / Cursor.

5/ Bun + TypeScript, AGPL-3.0. Install is one line, per-user, no admin. Repo + docs: ‹links›. Tell me what tool you'd want it to index next 👇

---

## 8. dev.to / blog (long-form)

**Working title:** `Why I built a local-first AI agent (and why "the cloud is just a connector" matters)`
**Outline:**

- The problem: cloud assistants need your data on their servers; for work tools that's a non-starter.
- The thesis: local-first + MCP + structural HITL.
- Walkthrough: install → connect GitHub → ask → an incident-correlation example (embed the cast).
- The hard part: making consent un-bypassable (the executor-level gate, briefly).
- Running fully offline with Ollama.
- What's next (MCP server, proactive watch daemon) + how to contribute.
**Opening line:**

> Every "AI assistant for your tools" asks the same thing first: connect your accounts to *our* servers. I wanted the opposite — so I built one where the data, the credentials, and the agent all stay on your machine.

---

## 9. Listings & directories (submit launch week)

- [ ] MCP server directories / awesome-mcp lists.
- [ ] `awesome-selfhosted`, `awesome-devops` (PRs).
- [ ] Update your own `awesome-nimbus` with the launch post + cast.
- [ ] Submit to relevant newsletters (e.g. local-first, DevOps weeklies).

## Sequencing

Soft-launch venues first (r/selfhosted, MCP Discords) to shake out friction → then the coordinated big day (Show HN + PH + the tailored Reddit set + the X thread + the blog) once Phase 0 is green.
