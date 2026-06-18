# Nimbus — Launch & Community Plan

**Date:** 2026-06-18
**Status:** Plan — pending execution
**Goal:** Drive adoption (triers), awareness (stars), ecosystem (contributors), and design partners — via a sustained writing + social effort with tailored, per-audience messaging.

## Governing principle: fix-then-fire

You get one first impression per channel. A launch-readiness audit (2026-06-18) found the **code and messaging are launch-ready; the public surfaces are not.** Three gaps would waste the launch and must close first (Phase 0). Do **not** fire the big multi-channel push until they're done.

**Honest inconsistency to resolve first:** the docs describe a Tauri **desktop** onboarding wizard, but desktop is deferred to Phase 13 (per CLAUDE.md / `v0.1.0` GA = Gateway + CLI + VS Code). **Lead all launch messaging with the CLI** (it's GA and the asciinema cast already shows it). Align or caveat the docs' "launch the desktop app" step before posting.

## Readiness snapshot (from the 2026-06-18 audit)

| Area | Status |
|---|---|
| Positioning / messaging | **READY** — tight, differentiated, local-first + HITL front-and-center |
| Docs site (`nimbus-agent.dev`, 52 pages) | **READY** |
| Release / credibility (CHANGELOG, signing, SBOM, audit, roadmap) | **STRONG** |
| Onboarding / first-run | **NEEDS WORK** — no zero-config try-it path; local-LLM path not one-step |
| Demo assets | **PARTIAL** — great asciinema cast; no root-README visual; UI screenshots are TODO |
| Community surfaces | **NEEDS WORK** — no root README (now drafted); no real-time chat home |

## Phase 0 — Close the surface gaps (the gate, ~1 week)

**Blockers (before any public post):**

1. **Root `README.md`** — drafted in this branch. Review/merge it. (Keystone: every channel links here.)
2. **A genuine 2-minute try-it path** — see the companion spec `2026-06-18-demo-mode-design.md`. Ship `nimbus demo` (sample-data, zero accounts) and/or a one-step "fully local with Ollama" quickstart so the first run matches the local-first pitch.
3. **Community home** — stand up a Discord (or formally adopt GitHub Discussions as the sync point) and link it from README + docs. Seed channels + first posts so it isn't empty on day one.

**High-priority (before the big HN/Reddit push, parallelizable):**
4. Prominent local-LLM (Ollama) "works fully offline" callout in install docs.
5. A few real screenshots/GIFs of the **shipped** surface (CLI/TUI); convert the cast to an embeddable GIF for the README.
6. Badges visible on README (done in draft).

## Phase 1 — Soft launch / seed (week 1–2)

Feedback-first, low-volume. **Target: 10–20 real users, 1+ external contributor, a friction list.**

- Post to 2–3 high-tolerance niche venues: r/selfhosted, MCP/agent Discords, local-first communities, Lobsters (if invited). Frame as "built this, want feedback," not a megaphone.
- Fix onboarding friction in real time as people hit it.
- Pull 3–5 early adopters into the community home; convert 1–2 to contributors via good-first-issues (CONTRIBUTING + templates are already strong).

## Phase 2 — The big launch moment (week 3–4)

Coordinated, one launch day, everything pre-written. Multiple **tailored** posts (never identical cross-posts). Per-audience angles + the channel playbook live in `2026-06-18-launch-posts.md`.

**Audience angles (hook changes, product doesn't):**

- **DevOps / SRE / platform** — "<100ms cross-service incident context, on your machine; no data leaves the box."
- **Local-first / privacy** — "an AI agent over 80 tools whose credentials never leave the machine; AGPL, audited."
- **AI-agent / MCP builders** — "MCP-native today; soon your whole private index *as* an MCP server you plug into Claude Desktop/Cursor" (tease the S3 work).
- **Broad dev / OSS** — "Show HN: local-first, HITL-gated agent over your dev tools (Bun/TS, AGPL)."

**Channels:** Show HN, Product Hunt, sub-tailored Reddit (r/devops, r/sre, r/selfhosted, r/LocalLLaMA), Lobsters, X/Mastodon/Bluesky thread, a dev.to/blog long-form, MCP directories, awesome-* lists.

**Launch-day checklist:** README live · demo path tested on a clean machine · community home staffed · posts queued · you free to reply for ~8 hours.

## Phase 3 — Sustained community engine (ongoing)

A spike without cadence is wasted.

- **Content rhythm** (your strength): biweekly post tied to a real beat — new connector, recipe, changelog highlight, "how Nimbus does X locally." Each → 1 blog + 1 social thread.
- **Build-in-public:** ship the MCP-server work in the open; publish specs + rigorous reviews — the transparency is itself marketing to devs.
- **Ecosystem flywheel:** feature community connectors/recipes; push `create-nimbus-connector` + `nimbus-recipes`.
- **Response SLA:** fast replies on Discussions/Discord/issues for the first 90 days — that's what converts triers to advocates.

## Metrics (mapped to the "all goals" answer)

- **Awareness:** GitHub stars, post upvotes/reach, docs traffic.
- **Users:** installs / `nimbus demo` runs / first-query events (privacy-respecting, opt-in telemetry only).
- **Contributors:** new connectors + recipes, first-time PRs, Discussions activity.
- **Design partners:** inbound from teams; conversations toward the commercial tiers (Cloud relay, GitHub App).

## Companion artifacts (this branch)

- `README.md` (root) — the keystone.
- `docs/superpowers/specs/2026-06-18-demo-mode-design.md` — the 2-minute try-it path.
- `docs/superpowers/specs/2026-06-18-launch-posts.md` — tailored per-channel posts + playbook.
