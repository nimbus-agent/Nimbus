# Ecosystem Stage 3 — Distribution — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the shipped capability discoverable and legible to the incident-response ICP — re-cut the VS Code marketplace listing, add pointer `ROADMAP.md` files to the client repos, and write an honestly-scoped trust story — as copy/metadata only, delivered as PRs (no publish, no posting).

**Architecture:** Docs/metadata across five repos. One PR each: `nimbus-vscode` (A marketplace re-cut + C1 trust section + its `ROADMAP.md`), `nimbus-client` / `nimbus-sdk` / `nimbus-web-clipper` (each a `ROADMAP.md`), and `nimbus-agent/Nimbus` (C2 `docs/launch-messaging.md` + the ecosystem-roadmap Stage 3 update + this spec/plan). No code, no behavior change.

**Tech Stack:** Markdown + a VS Code extension `package.json`. Repos: `C:/gitrep/nimbus-vscode`, `C:/gitrep/nimbus-client`, `C:/gitrep/nimbus-sdk`, `C:/gitrep/nimbus-web-clipper`, and the Nimbus worktree `C:/gitrep/Nimbus/.claude/worktrees/ecosystem-stage3` (branch `dev/asafgolombek/ecosystem-stage3-distribution`, already created).

## Global Constraints

- **Copy only — no publish, no posting.** No `vsce publish`, no marketplace release, no launch post. Deliver PRs.
- **Honesty scope on egress (load-bearing).** The egress ledger records **every outbound action the agent dispatches** through its executor chokepoint (one hash-chained `egress_ledger` row before dispatch, invariant I29). It is **NOT** a network firewall/DLP and does **not** capture raw sockets/HTTP made outside the agent framework (OS, other local processes, a user-added unsandboxed MCP server). The honest phrasing is *"a signed, verifiable record of what the agent did off your machine"* — **never** *"everything that left your machine."* This wording is mandatory everywhere egress is mentioned (description, README, launch doc).
- **No unbuilt feature described as shipped.** The `why` lens is teased **last, under an explicit not-yet-shipped heading**, never in the feature list.
- **No pinned versions in `ROADMAP.md`.** Describe the role + link the Releases page; a hardcoded `0.x.y` drifts on the next publish.
- **`description` ≤ ~200 chars** (marketplace cards truncate ~150–200).
- **Branch hygiene:** each repo gets its own `dev/asafgolombek/stage3-*` branch; never commit on `main`. The Nimbus worktree branch already exists.

---

## File structure

- `nimbus-vscode/package.json` — `displayName`, `description`, `categories`, `keywords` (A).
- `nimbus-vscode/README.md` — lead rewrite (A) + "Why Nimbus" trust section (C1) + "On the roadmap" `why`-lens tease (B link).
- `nimbus-vscode/ROADMAP.md` — new (B).
- `nimbus-client/ROADMAP.md`, `nimbus-sdk/ROADMAP.md`, `nimbus-web-clipper/ROADMAP.md` — new (B).
- `Nimbus/docs/launch-messaging.md` — new (C2).
- `Nimbus/docs/ecosystem-roadmap.md` — Stage 3 status update.

---

## PR 1 — `nimbus-vscode` (A + C1 + B-vscode)

Work in `C:/gitrep/nimbus-vscode`. First: `cd C:/gitrep/nimbus-vscode && git switch main && git pull --ff-only && git switch -c dev/asafgolombek/stage3-marketplace-recut && git rev-parse --abbrev-ref HEAD`.

### Task 1: `package.json` marketplace re-cut

**Files:** Modify `package.json` (lines ~3–4, ~25–35).

- [ ] **Step 1: Edit the four fields.**
  - `displayName` (line 3): `"Nimbus Agent"` → `"Nimbus — On-Call & Incident Agent"`
  - `description` (line 4) → (≤200 chars, honesty-scoped):
    `"Private, local-first agent for on-call & platform engineers — /incident, /deploys, /owns, /blast grounded in your own index, with a signed, verifiable record of every action it takes off-device."`
  - `categories` (lines 25–28): `["AI", "Other"]` → `["AI", "Chat"]`.
  - `keywords` (lines 29–36): keep `ai, agent, local-first, nimbus, privacy, mcp`; **add** `on-call, incident-response, sre, platform-engineering, observability, dora, deploy, egress, audit`.

- [ ] **Step 2: Validate categories + package.** `cd C:/gitrep/nimbus-vscode && bun run package` (`bunx vsce package --no-dependencies`). Expected: PASS. **`vsce` fails on an unknown category** — if it rejects `"Chat"`, set `categories` to `["AI"]` and re-run (the ICP terms are in keywords regardless). Also confirm no "description too long" warning; trim if warned.

- [ ] **Step 3: Green check.** `bun run typecheck && bun run lint && bun run test`. Expected: PASS (metadata only, no code touched).

- [ ] **Step 4: Commit.**
```bash
git add package.json
git commit -m "feat(marketplace): re-cut listing for the on-call/incident ICP"
```

### Task 2: README lead rewrite + "Why Nimbus" trust section + roadmap tease

**Files:** Modify `README.md`.

**Interfaces produced:** the reordered README — differentiators first, general features below, trust section, roadmap tease last.

- [ ] **Step 1: Rewrite the top of `README.md`.** Replace the current hero line (`# Nimbus for VS Code` + "Local-first AI agent for the editor…") with this structure, keeping all existing feature bullets but **moved below** the new lead:

```markdown
# Nimbus — On-Call & Incident Agent for VS Code

A **private, local-first** agent for on-call and platform engineers. It answers
from *your own* indexed context — incidents, deploys, ownership, code — and keeps
a verifiable record of what it does off your machine. All running locally; your
data never leaves the box except through actions you can see and prove.

## Built for incident response & platform work

Structured, grounded answers via the built-in Chat participant — not generic prompts:

- **`/incident`** — what's going on right now: a catch-up brief across the services you own.
- **`/deploys <service>`** — DORA metrics (deploy frequency, lead time, change-fail rate, MTTR).
- **`/owns <file|service|topic>`** — who owns it, from your indexed history.
- **`/blast <file|PR>`** — blast radius: what a change touches downstream.

Each degrades honestly — an empty brief tells you *why* (missing connector, no data), never a confident guess.

## A verifiable record of what the agent does off your machine

Nimbus keeps a **signed, hash-chained egress ledger** of **every outbound action
the agent dispatches** — one row, appended before the action leaves. Inspect it,
verify the chain, and export a signed proof for any time window, all locally. A
claim no cloud assistant can make, because completeness *for the agent's actions*
can only be established at the point of departure, under your control.

**Scope, stated plainly:** this records the agent's *dispatched actions*, not raw
network traffic. It is not a firewall or host DLP and does not capture sockets or
HTTP made outside the agent (the OS, other processes, or an unsandboxed
third-party MCP server). It is a provable record of *what the agent did* — not a
claim about every byte that left the machine.
```

- [ ] **Step 2: Keep the existing feature list**, reordered below the sections above, under a heading like `## Everything else it does` (Ask, Search, `@nimbus` chat participant with `/explain` `/fix` `/test` as a *secondary* "also works as a general assistant" note, Quick Ask, Find related, dev-workflow trio, sidebar, audit/egress ledgers, troubleshooter, walkthrough). Do not delete or alter their accuracy.

- [ ] **Step 3: Add the roadmap tease LAST**, under an explicit not-yet-shipped heading:

```markdown
## On the roadmap (not yet shipped)

- **The `why` lens** — hover any line to see who wrote it, the PR, the ticket, the
  incident it responded to, and what breaks if you change it. Built on the gateway
  and reachable through the client today ([`agents.why`/`agents.whyPeek`](https://github.com/nimbus-agent/Nimbus/blob/main/docs/ecosystem-roadmap.md)); the in-editor hover is the next slice.

See the [Nimbus Ecosystem Roadmap](https://github.com/nimbus-agent/Nimbus/blob/main/docs/ecosystem-roadmap.md) for the full plan.
```

- [ ] **Step 4: Verify links + render.** `bunx markdownlint-cli2 README.md` if the repo has it (else skip); if lychee is installed, `~/.cargo/bin/lychee --offline README.md`. Expected: clean. Eyeball that no shipped-feature description now overclaims and the `why` lens is only under "not yet shipped".

- [ ] **Step 5: Commit.**
```bash
git add README.md
git commit -m "docs(readme): lead with the ICP + ops commands + egress receipts; tease the why lens as upcoming"
```

### Task 3: `nimbus-vscode/ROADMAP.md`

**Files:** Create `ROADMAP.md`.

- [ ] **Step 1: Create `ROADMAP.md`:**
```markdown
# nimbus-vscode — Roadmap

The Nimbus VS Code / Open VSX extension — the editor surface of the local-first
Nimbus agent.

The product roadmap lives in the gateway repo:
**[Nimbus Ecosystem Roadmap](https://github.com/nimbus-agent/Nimbus/blob/main/docs/ecosystem-roadmap.md)**
— it owns the cross-surface plan (client surfaces / delivery).

## This repo's slice

- **Role:** the VS Code / Open VSX extension; consumes the published `@nimbus-dev/client`.
- **Released:** on the VS Code Marketplace + Open VSX (`nimbus-agent.nimbus-vscode`); see [Releases](https://github.com/nimbus-agent/nimbus-vscode/releases) for the current version.
- **Next here:** the `why`-lens hover UI (Stage 4) — the client methods already ship.
```

- [ ] **Step 2: Commit + open the PR.**
```bash
git add ROADMAP.md
git commit -m "docs: add ROADMAP pointer to the ecosystem roadmap + local slice"
git push -u origin dev/asafgolombek/stage3-marketplace-recut
gh pr create --base main --title "Stage 3: marketplace re-cut + ROADMAP + why-lens tease" --body "Re-cuts the listing for the on-call/incident ICP (displayName/description/categories/keywords), leads the README with the ops slash-commands + the honestly-scoped egress ledger, teases the why lens as upcoming (not shipped), and adds a ROADMAP pointer. Copy/metadata only — no publish."
```

---

## PR 2 — `nimbus-client/ROADMAP.md`

Work in `C:/gitrep/nimbus-client`. `git switch main && git pull --ff-only && git switch -c dev/asafgolombek/stage3-roadmap`.

### Task 4: `nimbus-client/ROADMAP.md`

- [ ] **Step 1: Create `ROADMAP.md`:**
```markdown
# nimbus-client — Roadmap

`@nimbus-dev/client` — the typed JSON-RPC IPC wrapper every Nimbus client
consumes to talk to the local gateway.

The product roadmap lives in the gateway repo:
**[Nimbus Ecosystem Roadmap](https://github.com/nimbus-agent/Nimbus/blob/main/docs/ecosystem-roadmap.md)**
— it owns the cross-surface plan (client surfaces / delivery).

## This repo's slice

- **Role:** the single typed seam over the gateway's JSON-RPC surface; the `packages/cli` and the VS Code extension consume it.
- **Released:** on npm as `@nimbus-dev/client`; see [Releases](https://github.com/nimbus-agent/nimbus-client/releases) for the current version.
- **Next here:** track the gateway's method surface as new namespaces land.
```

- [ ] **Step 2: Commit + PR.**
```bash
git add ROADMAP.md
git commit -m "docs: add ROADMAP pointer to the ecosystem roadmap + local slice"
git push -u origin dev/asafgolombek/stage3-roadmap
gh pr create --base main --title "docs: add ROADMAP (Stage 3 cross-link)" --body "Adds a ROADMAP.md pointing at the public Nimbus ecosystem roadmap plus this repo's local slice. No version pins (Stage 3)."
```

---

## PR 3 — `nimbus-sdk/ROADMAP.md`

Work in `C:/gitrep/nimbus-sdk`. `git switch main && git pull --ff-only && git switch -c dev/asafgolombek/stage3-roadmap`.

### Task 5: `nimbus-sdk/ROADMAP.md`

- [ ] **Step 1: Create `ROADMAP.md`:**
```markdown
# nimbus-sdk — Roadmap

`@nimbus-dev/sdk` — the MIT extension-authoring contract: the shared item/brief
types and guards that the gateway, CLI, and `@nimbus-dev/client` all speak.

The product roadmap lives in the gateway repo:
**[Nimbus Ecosystem Roadmap](https://github.com/nimbus-agent/Nimbus/blob/main/docs/ecosystem-roadmap.md)**
— it owns the cross-surface plan (client surfaces / delivery).

## This repo's slice

- **Role:** the one source of truth for the narrow-waist types (`NimbusItem`, the agent briefs + guards); first-party MCP connectors and clients consume it.
- **Released:** on npm as `@nimbus-dev/sdk` (published dep-free); see [Releases](https://github.com/nimbus-agent/nimbus-sdk/releases) for the current version.
- **Next here:** promote new shared types as agents/surfaces graduate to the waist.
```

- [ ] **Step 2: Commit + PR** (same shape as Task 4, `--title "docs: add ROADMAP (Stage 3 cross-link)"`).

---

## PR 4 — `nimbus-web-clipper/ROADMAP.md`

Work in `C:/gitrep/nimbus-web-clipper`. `git switch main && git pull --ff-only && git switch -c dev/asafgolombek/stage3-roadmap`.

### Task 6: `nimbus-web-clipper/ROADMAP.md`

- [ ] **Step 1: Create `ROADMAP.md`:**
```markdown
# nimbus-web-clipper — Roadmap

The Nimbus Web Clipper — a Chrome + Firefox MV3 extension that clips pages into
your local Nimbus index.

The product roadmap lives in the gateway repo:
**[Nimbus Ecosystem Roadmap](https://github.com/nimbus-agent/Nimbus/blob/main/docs/ecosystem-roadmap.md)**
— it owns the cross-surface plan (client surfaces / delivery).

## This repo's slice

- **Role:** the browser capture surface; posts to the gateway's web-clip HTTP endpoint (`POST /v1/clips`) behind the owner-opened pairing window (invariant I30).
- **Released:** as a Chrome/Firefox MV3 extension; see [Releases](https://github.com/nimbus-agent/nimbus-web-clipper/releases) for the current version.
- **Next here:** tracked with the gateway's clip surface.
```

- [ ] **Step 2: Commit + PR** (same shape as Task 4).

---

## PR 5 — `nimbus-agent/Nimbus` (C2 + roadmap update)

Work in the existing worktree `C:/gitrep/Nimbus/.claude/worktrees/ecosystem-stage3` (branch `dev/asafgolombek/ecosystem-stage3-distribution`). Confirm the branch first.

### Task 7: `docs/launch-messaging.md`

**Files:** Create `docs/launch-messaging.md`.

- [ ] **Step 1: Create `docs/launch-messaging.md`** — a reusable messaging sheet (copy, not a launch):
```markdown
# Nimbus — Launch messaging (reusable copy)

> Positioning copy for the marketplace, READMEs, and any future launch channel.
> This is a reference sheet, **not** a launch action. Honesty guardrails below are
> load-bearing.

## One-liner

Private, local-first agent for on-call & platform engineers — grounded in your
own index, with a verifiable record of what it did off your machine.

## The three pillars

- **Banner — the `why` lens** (*habit*): hover any line for who/PR/ticket/incident/blast-radius. Built + reachable through the client; the in-editor hover is next (not yet shipped — never advertise it as present).
- **Moat — egress receipts** (*defensibility*): a signed, hash-chained record of every action the agent dispatches off-device. No cloud assistant can offer it.
- **Multiplier — LM tools** (*value per install*): `nimbus_search` / `nimbus_ask` registered as VS Code language-model tools.

## ICP vs generic (say the first, not the others)

- ✅ *"Hover any line: who wrote it, what ticket, what incident, and what breaks if you change it."*
- ✅ *"Verifiable proof of what your agent did off your machine."*
- ⚠️ *"Give Copilot your private context"* — positions Nimbus as an accessory; avoid.

## Honesty guardrails (do NOT claim)

- The egress ledger records the agent's **dispatched actions** (I29 executor chokepoint) — **not** raw network traffic. Never say *"everything that left your machine."* It is not a firewall/DLP and does not see the OS, other processes, or an unsandboxed third-party MCP server.
- Never describe the `why` hover UI, or any unbuilt surface, as shipped.
- Egress = "authorized actions," never "raw-syscall / whole-machine capture."
```

- [ ] **Step 2: Commit.**
```bash
git add docs/launch-messaging.md
git commit -m "docs: launch-messaging sheet (three pillars + honesty guardrails)"
```

### Task 8: ecosystem-roadmap Stage 3 status update

**Files:** Modify `docs/ecosystem-roadmap.md` (the Stage 3 section).

- [ ] **Step 1: Update the Stage 3 section** to record A/B/C done and the demo GIF as the one deferred item. Add a dated status note under `## Stage 3 — Distribution` (keep the four original bullets; annotate each): marketplace re-cut ✅ (nimbus-vscode listing re-cut for the ICP), cross-link ✅ (`ROADMAP.md` in vscode/client/sdk/web-clipper), launch trust-story ✅ (`docs/launch-messaging.md` + the "Why Nimbus" README section), **demo GIF ⏳ deferred — gated on the `why`-lens hover UI (Stage 4)**. Keep edits factual and scoped; don't touch other stages.

- [ ] **Step 2: Doc gates.** `bun run audit:doc-refs && bun run lint:markdown` (markdown gate is outside preflight — run it explicitly; the launch-messaging doc + roadmap edits must lint clean). If lychee is set up, run it over the changed docs and match CI's link total.

- [ ] **Step 3: Commit + PR.**
```bash
git add docs/ecosystem-roadmap.md
git commit -m "docs(roadmap): Stage 3 distribution done (marketplace/cross-links/launch copy); demo GIF deferred to Stage 4"
git push -u origin dev/asafgolombek/ecosystem-stage3-distribution
gh pr create --base main --title "docs: ecosystem Stage 3 — distribution (launch messaging + roadmap)" --body "Stage 3 copy that lives in this repo: docs/launch-messaging.md and the Stage 3 status update (marketplace re-cut + cross-link ROADMAPs + launch trust-story done; demo GIF deferred to the Stage 4 hover UI). Carries the Stage 3 spec + plan + review. Companion PRs: nimbus-vscode / -client / -sdk / -web-clipper."
```

---

## Final verification (before pushing each PR)

- [ ] `nimbus-vscode`: `bun run package` succeeds (categories valid, description not over-length); `typecheck`/`lint`/`test` green; README has no shipped-claim for the `why` lens (it's only under "On the roadmap").
- [ ] Every `ROADMAP.md` deep link (`/blob/main/docs/ecosystem-roadmap.md`) resolves against the public repo; no pinned versions anywhere.
- [ ] Egress wording audit: grep the vscode README + `launch-messaging.md` for "everything that left" / "every byte" / "firewall" — the honest scoping ("what the agent did off your machine", "dispatched actions") must be the only framing.
- [ ] Nimbus PR: `audit:doc-refs` + `lint:markdown` clean.
- [ ] No `vsce publish`, no release, no posting anywhere.

## Self-review notes

- **Spec coverage:** A (Task 1–2), B (Tasks 3–6), C1 (Task 2 README section), C2 (Task 7), roadmap update (Task 8), GIF deferral recorded (Task 8). All spec sections covered.
- **Honesty scope** is repeated as a Global Constraint and enforced in the description (Task 1), the README trust section (Task 2), the launch sheet guardrails (Task 7), and the final grep audit.
- **No version pins** in any `ROADMAP.md` (Tasks 3–6) per the review fix.
