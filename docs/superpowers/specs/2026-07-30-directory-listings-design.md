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
| mcpdirectory.com | Could not verify the site exists. Not added on an unverified reference — re-evaluate if a working URL turns up. |
| awesome-selfhosted | Inclusion criteria require self-hostable **server** software. Nimbus is a local CLI + gateway. A PR would be rejected on criteria, not merit. |

## The category — Nimbus is both a client and a server

Nimbus speaks MCP in both directions, and each direction is a separate listable
surface. Both are shipped; neither claim is aspirational.

**As a client** it drives every connector as an MCP server, and hosts arbitrary
third-party servers registered with `nimbus connector add --mcp` (see
`connectors/lazy-mesh/user-mcp.ts` and `user-mcp-store.ts`). The client category is
materially less crowded than the server category.

**As a server**, `nimbus mcp-server --stdio` exposes the local index to editor AIs
through six read-only tools — `searchIndex`, `getConnectorStatus`,
`getRecentIncidents`, `getRecentPullRequests`, `getRecentDeployments`,
`getDoraMetrics` (see `packages/cli/src/mcp/adapter.ts`; the command is registered in
`COMMAND_NAMES`).

> The parked `dev/asafgolombek/phase7-mcp-gateway-server` branch (invariant `I28`
> reserved) is a **different, later** owner-sink surface. Its being unshipped does not
> affect the read-only server above, which ships today.

### Why the Official MCP Registry is blocked

The registry is a **metaregistry**: it stores metadata pointing at an artifact hosted
somewhere else, and `server.json` must name a package on a supported registry. The
allowed set is npm (`registry.npmjs.org`), PyPI, NuGet, Cargo, Docker/OCI
(Docker Hub, ghcr.io, quay.io, `*.pkg.dev`, `*.azurecr.io`, mcr.microsoft.com), and
MCPB (a `.mcpb` binary attached to a GitHub or GitLab release). Publishing also
requires an ownership-verification token inside the published package, checked by a
per-registry validator.

Nimbus ships through Homebrew, Scoop, winget, apt/yum, and direct download. None is a
supported registry type, and the server is a subcommand of an installed gateway rather
than a standalone artifact — so there is nothing to point a `server.json` at.

Reaching the registry would need a deliberate packaging decision, which is engineering
work and not part of this spec:

- **MCPB** — build a `.mcpb` bundle into the release pipeline. Closest fit, since
  releases already exist and MCPB is explicitly for prebuilt binaries.
- **npm launcher** — publish a thin package whose `bin` shells out to
  `nimbus mcp-server --stdio`. Cheapest, but it installs something that fails unless
  the gateway is already installed and running, which is a poor first impression and
  arguably misrepresents what the package is.

Until one is chosen, every registry-fed aggregator (PulseMCP's server directory
included) stays out of reach. The curated lists do not depend on it.

### Server-side listing caveat

Directories that auto-build submissions — Glama, Smithery — expect a standalone,
`npx`-installable server. Nimbus's server is a subcommand of an installed binary and
needs the Gateway running, so those pipelines may fail or score it poorly. Submit to
the curated lists first; treat Glama and Smithery as speculative and do not spend
time debugging their build bots.

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
| PulseMCP | Email `hello@pulsemcp.com` | **Not a form.** `pulsemcp.com/submit` no longer takes direct submissions — it redirects to the Official MCP Registry, which it ingests daily and processes weekly. Since that registry is servers-only, email is the only route for the client surface. |
| `punkpeye/awesome-mcp-clients` | Pull request | Exact category match. Entry format is `### Name` + an HTML `<table>` (GitHub, Website, License, Type, Platforms, Pricing, Programming Languages) + a one-paragraph description + optional screenshots. Add a TOC entry too. |
| mcp.so | Manual — see `mcp.so/clients` | The site is server-first, but a clients section exists. It returns HTTP 403 to automated fetches, so confirm the submission route in a browser before budgeting time for it. |
| `punkpeye/awesome-mcp-servers` | Pull request | The largest directory in the ecosystem by a wide margin (~91k stars) and actively maintained. Submit the **server** surface here. Highest-reach single target on this list. |
| Official MCP Registry (`registry.modelcontextprotocol.io`) | **Blocked** — see below | The canonical registry, and PulseMCP plus other aggregators ingest it. Not currently reachable: it is a metaregistry that only stores metadata pointing at a package. |
| `wong2/awesome-mcp-servers`, `appcypher/awesome-mcp-servers` | Pull request | Server lists; check whether a clients section also exists. |

### Classification: submit as a Client, in one section only

Lists that separate **Clients** (end-user applications) from **Frameworks / SDKs**
(developer libraries) take Nimbus as a **Client**. It ships as an installable
application — a gateway plus a CLI — not as a library you build against. The library
is [`@nimbus-dev/sdk`](https://github.com/nimbus-agent/nimbus-sdk), a separately
published MIT package that is not part of this work.

Do **not** double-list as Client *and* Framework. That is one artifact wearing two
labels; awesome lists reject duplicate entries, and a maintainer reading two entries
for one project sees promotion rather than a contribution. Pick Client — if a
maintainer prefers otherwise, follow their call.

Listing as Client **and** Server is a different matter and is legitimate: they are two
genuinely distinct surfaces (one consumes MCP servers, the other *is* one), and on a
site carrying separate client and server directories both entries are accurate. Keep
the descriptions distinct so each entry stands on its own — the client entry is about
indexing ~80 services, the server entry is about the six read-only tools.

### Before opening any pull request

1. ~~**The README must declare MCP support.**~~ **Done.** It previously mentioned MCP
   only as connector transport, which describes how connectors talk *outward* and left
   a reviewer unable to confirm the submission's central claim. The "Three load-bearing
   words" MCP bullet now states both directions explicitly and names
   `nimbus mcp-server --stdio` and `nimbus connector add --mcp`.
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

```text
Name:       Nimbus
GitHub:     https://github.com/nimbus-agent/Nimbus
Website:    https://nimbus-agent.dev
License:    AGPL-3.0 (gateway/CLI/connectors), MIT (SDK)
Type:       CLI + headless gateway (also a VS Code extension)
Platforms:  Windows, macOS, Linux
Pricing:    Free
Language:   TypeScript
MCP:        Client — Tools (no resources, prompts, sampling, or roots)
```

For a **server**-directory submission, the entry is the `mcp-server` subcommand, not
the gateway:

```text
Server name:  nimbus
Launch:       nimbus mcp-server --stdio
Transport:    stdio
Requires:     the `nimbus` binary on PATH, with the Gateway running (`nimbus start`)
Tools (6):    searchIndex, getConnectorStatus, getRecentIncidents,
              getRecentPullRequests, getRecentDeployments, getDoraMetrics
Access:       read-only
```

State the "Gateway must be running" prerequisite up front. It is the first thing a
directory reviewer trips over, and volunteering it reads better than being caught by it.

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

| Target | Surface | Status | Submission link | Completed |
| --- | --- | --- | --- | --- |
| README MCP statement | — | **done** | commit on `dev/asafgolombek/directory-listings` | 2026-07-30 |
| PulseMCP (email) | client | not started | | |
| modelcontextprotocol/docs `clients.mdx` | client | not started | | |
| `punkpeye/awesome-mcp-servers` | server | **PR open** — Aggregators | <https://github.com/punkpeye/awesome-mcp-servers/pull/11216> | |
| Official MCP Registry | server | **blocked** — needs a packaging decision | | |
| `punkpeye/awesome-mcp-clients` | client | not started | | |
| mcp.so (confirm route first) | client + server | not started | | |
| wong2 / appcypher | server | not started | | |
| Glama / Smithery (speculative) | server | not started | | |
| Tier 2 | client | not started | | |
| Tier 3 | client | not started | | |
| Tier 4 | client | not started | | |
