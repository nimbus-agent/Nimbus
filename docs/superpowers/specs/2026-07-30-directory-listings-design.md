# Directory listings — discovery surfaces for Nimbus

> Goal: get Nimbus in front of engineers who are already looking for what it is.
> Scope is **listings only** — self-serve directories and community lists with no
> gatekeeper judging project popularity. Vendor partnerships, credits programs, and
> sponsorship are deliberately out of scope here and tracked separately.

## Already covered — do not redo

Distribution is not the gap. These channels exist and are documented in
[`docs/install.md`](../../install.md):

- Homebrew tap, Scoop bucket, winget
- Signed apt / yum repositories
- MSI / PKG / DEB / RPM / AppImage + portable archives
- GitHub repository topics (20, ICP-aligned) and description

## Out of scope, with reasons

Recording these so they are not re-litigated:

| Target | Why not |
| --- | --- |
| The ~80 MCP connectors, listed individually | Not publishable as standalone servers: unpublished on npm, and no `bin` / `main` / `exports` / `files` in their `package.json`. They load via `nimbus.extension.json` inside the gateway. Adding entry points and publishing ~80 packages multiplies the maintenance surface and routes users to the connectors rather than to Nimbus. |
| Nimbus as an MCP **server** | That surface is parked on `dev/asafgolombek/phase7-mcp-gateway-server` (invariant `I28` reserved). Not shipped — listing it would violate the "never advertise an unbuilt surface" rule in [`launch-messaging.md`](../../launch-messaging.md). |
| Glama, mcp.so | Server-oriented. Glama's pipeline builds, runs, and introspects each submission; a client has nothing for it to introspect. |
| awesome-selfhosted | Inclusion criteria require self-hostable **server** software. Nimbus is a local CLI + gateway. A PR would be rejected on criteria, not merit. |

## The category

Nimbus lists as an MCP **client** — an application that consumes MCP servers. That
category is materially less crowded than the server category, and every major MCP
directory maintains a client list alongside its server list.

### Feature-support matrix row (verified, do not inflate)

The lazy mesh calls `listTools()` only — see
`packages/gateway/src/connectors/lazy-mesh/{mesh,tool-map}.ts`. It does not consume
resources, prompts, sampling, or MCP roots.

| Resources | Prompts | Tools | Sampling | Roots |
| --- | --- | --- | --- | --- |
| ❌ | ❌ | ✅ | ❌ | ❌ |

This is the same support level as Cursor, Goose, and Witsy. If the mesh later
consumes another capability, update every listing — a stale ✅ is worse than a ❌.

## Tier 1 — MCP ecosystem

Highest-intent audience. Ordered by yield per hour.

| Target | Mechanism | Notes |
| --- | --- | --- |
| `modelcontextprotocol/docs` → `clients.mdx` | Pull request | Official list. Add one matrix row **and** a link-reference definition at the bottom of the file. No popularity bar: "if you've added MCP support to your application, we encourage you to submit a pull request." |
| PulseMCP | Form at `pulsemcp.com/submit` | Accepts both servers and clients. Requires only a URL. No stated eligibility bar. Lowest-effort item on this list. |
| `punkpeye/awesome-mcp-clients` | Pull request | Exact category match. Entry format is `### Name` + an HTML `<table>` (GitHub, Website, License, Type, Platforms, Pricing, Programming Languages) + a one-paragraph description + optional screenshots. Add a TOC entry too. |
| `wong2/awesome-mcp-servers`, `appcypher/awesome-mcp-servers` | Pull request | Check for a clients/frameworks section before opening; skip if server-only. |

## Tier 2 — local-first / privacy AI

The pitch is Ollama support and credentials that never leave the machine.

- `awesome-local-ai`
- `awesome-ai-agents`
- LocalLLaMA-adjacent community lists

## Tier 3 — ICP directories

Smaller traffic, but it is the audience in [`audiences.md`](../../audiences.md).

- `awesome-sre`
- `awesome-devops`
- `awesome-sysadmin`

## Tier 4 — general

Cheap, low yield. Product Hunt is a one-shot **launch**, not a listing — hold it.

- AlternativeTo
- OpenAlternative
- Console.dev

## Reusable submission block

```
Name:       Nimbus
GitHub:     https://github.com/nimbus-agent/Nimbus
Website:    https://nimbus-agent.dev
License:    AGPL-3.0 (gateway/CLI/connectors), MIT (SDK)
Type:       CLI + headless gateway (also a VS Code extension)
Platforms:  Windows, macOS, Linux
Pricing:    Free
Language:   TypeScript
MCP:        Tools
```

Description (one paragraph):

> Nimbus is a local-first AI agent for on-call and platform engineers. It builds a
> private SQLite index over ~80 developer and infrastructure services (GitHub, Jira,
> Slack, PagerDuty, Google, and more) through MCP connectors, and every outbound
> action passes a human-in-the-loop consent gate. Credentials live in the OS keystore
> and never leave the machine; pointing it at a local Ollama model keeps prompts local
> as well.

## Honesty guardrails

These carry over from [`launch-messaging.md`](../../launch-messaging.md) and are
load-bearing in every listing:

- Do not describe the `why` hover UI, or any unbuilt surface, as shipped.
- The egress ledger records the agent's **dispatched actions**, never "everything that
  left your machine." It is not a firewall or host DLP.
- Do not claim "no telemetry." The collector exists and is opt-in, defaulting to
  `[telemetry] enabled = false`.
- Do not claim MCP capabilities beyond Tools (see the matrix above).

## Adjacent, not part of this work

- `.github/FUNDING.yml` does not exist. Adding it is unrelated to listings but is a
  prerequisite for any later sponsorship path.

## Tracking

| Target | Status | Link |
| --- | --- | --- |
| modelcontextprotocol/docs | not started | |
| PulseMCP | not started | |
| punkpeye/awesome-mcp-clients | not started | |
| wong2 / appcypher | not started | |
| Tier 2 | not started | |
| Tier 3 | not started | |
| Tier 4 | not started | |
