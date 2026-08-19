# Nimbus — Launch messaging (reusable copy)

> Positioning copy for the marketplace, READMEs, and any future launch channel.
> This is a reference sheet, **not** a launch action. The honesty guardrails below
> are load-bearing.

## One-liner

Private, local-first agent for on-call & platform engineers — grounded in your
own index, with a verifiable record of what it did off your machine.

## The one thing (lead with this)

> `nimbus why src/auth.ts:42` — who wrote this line, when, and in what commit, from your local git history. No LLM, no API key, no cloud account. Connect and sync GitHub, a ticket tracker and an incident tool, and the same command adds the pull request, the ticket, and the incident.

Every post, listing and landing page leads with this and nothing else. The connector count, the agents and the egress ledger are depth — they belong on the second screen, once someone has a reason to keep reading. The pillars below describe what makes people *stay*; this line is what makes them *start*.

**Why this one:** the local-git result's only prerequisites are a git repo and a running Gateway — no LLM, no API key, no cloud account. It is the only capability that is simultaneously unique and provable in under a minute, and it is the only path verified end-to-end on a machine the author does not own. The connector-backed lanes (pull request, ticket, incident) need a configured connector *and* a completed index sync before they populate — that "no LLM, no API key, no cloud account" claim describes the local-git result only, not the connector-backed one.

## The three pillars

- **Banner — the `why` lens** (*habit*): hover any line for who/PR/ticket/incident/blast-radius. Built on the gateway and reachable through the client; the in-editor hover is next (**not yet shipped — never advertise it as present**).
- **Moat — egress receipts** (*defensibility*): a signed, hash-chained record of every action the agent dispatches off-device. No cloud assistant can offer it.
- **Multiplier — LM tools** (*value per install*): `nimbus_search` / `nimbus_ask` registered as VS Code language-model tools.

## ICP vs generic (say the first, not the others)

- ✅ *"`nimbus why src/auth.ts:42` — who wrote this line, when, and in what commit, from your local git history. Connect and sync GitHub, a ticket tracker and an incident tool, and the same command adds the pull request, the ticket, and the incident."*
- ✅ *"Verifiable proof of what your agent did off your machine."*
- ⚠️ *"Give Copilot your private context"* — positions Nimbus as an accessory; avoid.

## Honesty guardrails (do NOT claim)

- The egress ledger records the agent's **dispatched actions** (the `I29` executor chokepoint) — **not** raw network traffic. Never say *"everything that left your machine"* or *"every byte."* It is not a firewall / host DLP and does not see the OS, other local processes, or an unsandboxed third-party MCP server.
- Never describe the `why` hover UI, or any unbuilt surface, as shipped.
- Egress = "authorized actions the agent took," never "raw-syscall / whole-machine capture."

## Pre-empt: the telemetry question

Nimbus ships an **opt-in, aggregate-only** telemetry collector that defaults to
`[telemetry] enabled = false`. `docs/cli-reference.md` documents a default
endpoint (`https://telemetry.nimbus-agent.dev/v1/collect`), so a reader who
greps for URLs will find one and may assume it is live.

State the position first, in these words:

> Telemetry is opt-in and off by default. Nothing is sent unless you set
> `[telemetry] enabled = true`. `nimbus telemetry show` prints exactly what
> would be sent; `nimbus telemetry disable` writes a local marker that stops
> the flush scheduler outright.

Do **not** say "Nimbus has no telemetry" — the collector exists, and being
caught in an absolute that is technically false costs more than the nuance.
