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
| Glama | Server-oriented. Its pipeline builds, runs, and introspects each submission; a client has nothing for it to introspect. |
| Smithery | Server-oriented for the same reason. Publishing is `smithery mcp publish` driven by a `smithery.yaml`, which describes how to *run a server*. Nimbus is not one. |
| mcpdirectory.com | Could not verify the site exists. Not added on an unverified reference — re-evaluate if a working URL turns up. |
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
| mcp.so | Manual — see `mcp.so/clients` | The site is server-first, but a clients section exists. It returns HTTP 403 to automated fetches, so confirm the submission route in a browser before budgeting time for it. |
| `wong2/awesome-mcp-servers`, `appcypher/awesome-mcp-servers` | Pull request | Check for a clients/frameworks section before opening; skip if server-only. |

### Classification: submit as a Client, in one section only

Lists that separate **Clients** (end-user applications) from **Frameworks / SDKs**
(developer libraries) take Nimbus as a **Client**. It ships as an installable
application — a gateway plus a CLI — not as a library you build against. The library
is [`@nimbus-dev/sdk`](https://github.com/nimbus-agent/nimbus-sdk), a separately
published MIT package that is not part of this work.

Do **not** double-list under both sections. Awesome lists routinely reject duplicate
entries, and a maintainer reading two entries for one project sees promotion rather
than a contribution. Pick Client; if a maintainer prefers otherwise, follow their call.

### Before opening any pull request

1. **The README must declare MCP client support.** Today it mentions MCP only as the
   connector transport ("every connector speaks the Model Context Protocol"), which
   describes how connectors talk *outward* and never states that Nimbus is an MCP
   client. A reviewer checking the repo cannot confirm the claim in the submission.
   Add a short, search-friendly statement naming the supported capability — Tools.
2. **Read that list's own contribution rules.** Do not assume `awesome-lint` applies:
   it only governs lists that follow the awesome manifest, and
   `punkpeye/awesome-mcp-clients` uses HTML tables that would fail it outright. Check
   the repository's `CONTRIBUTING` file and its CI configuration, and match the
   formatting of neighbouring entries — sort order, trailing slashes, punctuation.

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

### The "alternative to" field

AlternativeTo and similar sites surface entries by what they replace, so the field is
worth filling — but the comparison set decides whether the listing reads as accurate.

**Do not list coding assistants** (Cursor, Aider, OpenHands, Devin, Copilot). Two
reasons, and both are disqualifying on their own. It is inaccurate: Nimbus does not
write code — it indexes and answers over your tools, and its ICP is on-call and
platform work. And it violates the positioning rule in
[`launch-messaging.md`](../../launch-messaging.md), which flags framing Nimbus against
coding assistants as the anti-pattern that reduces it to an accessory.

The honest comparison is **AI search and context over your work tools**, where the
local-first, no-account, no-relay architecture is the actual differentiator. Confirm
each comparable still fits at submission time rather than pasting this list:

```text
Alternative to: Glean, Onyx — AI search over work tools, but local-first,
                with no account, no cloud index, and no relay server
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

One row per target. No owner column — this is a single-maintainer project, and the
column would be the same name on every row.

| Target | Status | Submission link | Completed |
| --- | --- | --- | --- |
| README MCP-client statement (blocks the PRs below) | not started | | |
| PulseMCP | not started | | |
| modelcontextprotocol/docs | not started | | |
| punkpeye/awesome-mcp-clients | not started | | |
| mcp.so (confirm route first) | not started | | |
| wong2 / appcypher | not started | | |
| Tier 2 | not started | | |
| Tier 3 | not started | | |
| Tier 4 | not started | | |
