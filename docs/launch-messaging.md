# Nimbus — Launch messaging (reusable copy)

> Positioning copy for the marketplace, READMEs, and any future launch channel.
> This is a reference sheet, **not** a launch action. The honesty guardrails below
> are load-bearing.

## One-liner

Private, local-first agent for on-call & platform engineers — grounded in your
own index, with a verifiable record of what it did off your machine.

## The three pillars

- **Banner — the `why` lens** (*habit*): hover any line for who/PR/ticket/incident/blast-radius. Built on the gateway and reachable through the client; the in-editor hover is next (**not yet shipped — never advertise it as present**).
- **Moat — egress receipts** (*defensibility*): a signed, hash-chained record of every action the agent dispatches off-device. No cloud assistant can offer it.
- **Multiplier — LM tools** (*value per install*): `nimbus_search` / `nimbus_ask` registered as VS Code language-model tools.

## ICP vs generic (say the first, not the others)

- ✅ *"Hover any line: who wrote it, what ticket, what incident, and what breaks if you change it."*
- ✅ *"Verifiable proof of what your agent did off your machine."*
- ⚠️ *"Give Copilot your private context"* — positions Nimbus as an accessory; avoid.

## Honesty guardrails (do NOT claim)

- The egress ledger records the agent's **dispatched actions** (the `I29` executor chokepoint) — **not** raw network traffic. Never say *"everything that left your machine"* or *"every byte."* It is not a firewall / host DLP and does not see the OS, other local processes, or an unsandboxed third-party MCP server.
- Never describe the `why` hover UI, or any unbuilt surface, as shipped.
- Egress = "authorized actions the agent took," never "raw-syscall / whole-machine capture."
