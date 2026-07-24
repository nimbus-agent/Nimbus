# Ecosystem Stage 3 — Distribution

> Design spec. Roadmap: [`docs/ecosystem-roadmap.md`](../../ecosystem-roadmap.md) § Stage 3.
> Spans repos: `nimbus-vscode` (A, C), `nimbus-{vscode,client,sdk,web-clipper}` (B),
> `nimbus-agent/Nimbus` (C's launch doc + this spec).

## Problem

Stages 0–2 built and re-cut the capability; the `why` lens is now reachable
through `@nimbus-dev/client` 0.12.0 (step 2). But **capability without discovery
is what the 3-install number measures** (roadmap § Stage 3). The VS Code listing
— the one public discovery surface — is generically positioned: `displayName`
"Nimbus Agent", `description` "Local-first AI agent for the editor", `categories`
`[AI, Other]`, keywords `ai/agent/local-first/privacy/mcp`. **None of the ICP's
words (on-call, incident response, SRE, platform engineering, observability,
deploy) appear anywhere**, and the differentiators that actually shipped — the
ops slash-commands (`/incident`, `/deploys`, `/owns`, `/blast`; Stage 2b) and
egress receipts (the moat; Stage 2c) — are buried below generic "Ask/Search".
The client repos have no `ROADMAP.md`, so a visitor can't see how the pieces fit.

## Goal

Make what's built **discoverable and legible** to the incident-response ICP,
leading with what exists and is differentiated (ops commands + verifiable
egress), with the `why` lens as a tease. Three deliverables (A/B/C below).

**Non-goals:**

- **The demo GIF** (roadmap Stage 3 bullet 2) is gated on the `nimbus-vscode`
  hover UI, which is unbuilt (Stage 4). Deferred, not in this pass.
- **No publishing or posting.** This writes copy and metadata; releasing the
  extension and any launch posting stay the owner's actions.
- No behavior/feature changes to any extension or package.

## A — Marketplace re-cut (`nimbus-vscode`)

Reposition the listing for the ICP; lead with the shipped differentiators. Blend
of "reposition the name" + "lead with the moat".

**`package.json` fields:**

- `displayName`: `"Nimbus — On-Call & Incident Agent"` (was "Nimbus Agent").
- `description` (**≤200 chars** — marketplace search cards + listing previews truncate ~150–200 chars, so the full line must read whole before the cut; the earlier 231-char draft truncated mid-sentence): `"Private, local-first agent for on-call & platform engineers — /incident, /deploys, /owns, /blast grounded in your own index, with a signed, verifiable record of every action it takes off-device."` (~192 chars). Note "record of every **action it takes**" — not "everything that leaves your machine" — is the honesty-scoped wording (see C); do not widen it back to a network-level claim.
- `categories`: `["AI", "Chat"]` — VS Code categories are a **fixed enum** and the ICP vocabulary can't live here; "Chat" is valid because the extension ships a chat participant. **`vsce`/packaging fails on an unrecognized category** — the plan MUST verify both against the current marketplace category list at authoring time; if "Chat" is not accepted, fall back to `["AI"]` (the ICP terms live in keywords regardless). Drop "Other".
- `keywords`: keep `ai, agent, local-first, nimbus, privacy, mcp`; **add** `on-call, incident-response, sre, platform-engineering, observability, dora, deploy, egress, audit`.

**`README.md` lead rewrite** (the marketplace listing body — the first screen is what converts): restructure the top so it opens with **who it's for + the differentiators**, not "generic AI agent":

1. A one-line hero in the ICP's voice (mirror the new `description`).
2. A short **"Built for incident response & platform work"** intro naming the ops slash-commands (`/incident` → catchup, `/deploys` → DORA, `/owns` → expert, `/blast` → impact) as the lead capability.
3. **"A verifiable record of what left your machine"** — the egress receipts / audit ledger, framed as the moat (a claim no cloud assistant can make), scoped honestly (see C).
4. THEN the existing general features (Ask, Search, chat participant, dev-workflow trio, walkthrough) — kept, reordered below the differentiators, not deleted.
5. The **`why` lens tease goes LAST, under an explicit `## On the roadmap` (or "Coming soon") heading** — clearly marked as **not yet shipped**, one line (author/PR/ticket/incident per line) linking the ecosystem-roadmap. It must NOT appear in the shipped-feature list: a user installing this version seeing "why lens" among the features and not finding it earns a 1-star "advertised a feature that isn't there" review.

Keep every shipped-feature description accurate — **no unbuilt feature described as present**. The Copilot-vocabulary trap (`/explain` `/fix` `/test`) stays as a secondary "also works like a general assistant" line, not the lead.

## B — Cross-link the client ROADMAPs

Create a short `ROADMAP.md` at the root of **four** repos: `nimbus-vscode`,
`nimbus-client`, `nimbus-sdk`, `nimbus-web-clipper` (exclude `nimbus-trio` — a
working copy of vscode, not a distinct surface). Each is a **pointer + local
slice**, per the roadmap's own prescription. Template:

```markdown
# <repo> — Roadmap

<repo> is <one line: its role in the Nimbus narrow waist>.

The product roadmap lives in the gateway repo:
**[Nimbus Ecosystem Roadmap](https://github.com/nimbus-agent/Nimbus/blob/main/docs/ecosystem-roadmap.md)**
— it owns the cross-surface plan (client surfaces / delivery).

## This repo's slice

- **Role:** <e.g. the typed IPC wrapper every client consumes / the VS Code surface / …>
- **Released:** <where, NO pinned version — e.g. "on npm (`@nimbus-dev/client`); see [Releases](../../releases) for the current version"> — a hardcoded `0.x.y` here drifts the moment the package publishes again; point at the releases page instead.
- **Next here:** <the repo-local next step, e.g. "the `why` hover UI (Stage 4)">
```

**No pinned versions in these files** (they update rarely; a hardcoded minor/patch
goes stale immediately) — describe the role + link the releases page. The
ecosystem-roadmap deep link uses `/blob/main/` deliberately: it must track the
*living* roadmap, and `main` is the confirmed, stable default branch of the
public `nimbus-agent/Nimbus` repo. A commit-SHA permalink would pin a stale
snapshot; relative links are impossible across repos. If the default branch is
ever renamed, GitHub auto-redirects `/blob/main/` and the links here are updated
in the same change.

## C — Launch trust-story copy

Two artifacts, **copy only** (nothing posted):

1. **A "Why Nimbus" section in the `nimbus-vscode` README** — the honest trust
   story: Nimbus keeps a **verifiable, signed record of every outbound action the
   agent takes** (the egress ledger), a claim structurally impossible for a cloud
   assistant (completeness *for the agent's actions* can only be established at
   the point of departure, under the user's control). **The boundary is stated
   explicitly and must not be softened into a whole-machine claim:**
   - **What it records:** every action the agent *dispatches* through its
     executor chokepoint — one appended, hash-chained `egress_ledger` row per
     gated action *before* it leaves (invariant I29). That is the exact, provable
     scope.
   - **What it is NOT:** a network firewall or host DLP. It does **not** monitor
     raw TCP/UDP sockets or HTTP made *outside* the agent framework — e.g. by the
     OS, other local processes, or a user-added **unsandboxed** MCP server. (Nimbus
     first-party connectors run sandboxed (I15), but the ledger's claim is about
     *the agent's dispatched actions*, not every byte on the wire.)

   The honest one-liner is *"a signed, verifiable record of what the agent did
   off your machine"* — never *"everything that left your machine."* This is the
   differentiator that "sells to the buyer and earns procurement's signature,"
   and it only holds if the scope is stated, not blurred.
2. **`docs/launch-messaging.md`** in the Nimbus repo — a reusable messaging
   sheet: the one-liner, the three-pillar frame (banner = `why` lens; moat =
   egress receipts; multiplier = LM tools), the ICP-vs-generic positioning
   contrast (from the roadmap's "Put an SRE in front of a listing" section), and
   the honesty guardrails (what NOT to claim). For reuse across marketplace,
   README, and any future launch channel — not a launch action itself.

## Testing / verification

- **A:** `nimbus-vscode` still packages — `bunx vsce package` (or the repo's
  package script) succeeds and warns of nothing new; `bun run` typecheck/lint/
  test stay green (metadata + README only, no code touched). Marketplace
  `description` within length; `categories` are valid enum values.
- **B/C:** every new/changed doc passes the repos' link checks (lychee where
  present); the ecosystem-roadmap deep link resolves (public repo). Markdown
  lints clean where a gate exists.
- Each repo's change is its own PR; nothing is published/released here.

## Definition of done

- `nimbus-vscode` listing (package.json + README lead) re-cut for the ICP,
  leading with ops commands + egress receipts, `why` lens teased; extension
  still packages, tests green.
- `ROADMAP.md` present in vscode/client/sdk/web-clipper, each pointing to the
  ecosystem-roadmap + its local slice.
- "Why Nimbus" trust section in the vscode README + `docs/launch-messaging.md`
  in the Nimbus repo, both honestly scoped to authorized-actions.
- The ecosystem-roadmap Stage 3 section updated to record A/B/C done and the GIF
  as the one deferred item (gated on the Stage 4 hover UI).
- All changes as PRs; no marketplace publish, no posting.
