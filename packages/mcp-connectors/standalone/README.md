# nimbus-mcp

## What this is

Runs a Nimbus first-party connector as a **standalone MCP server**, for any MCP client — Claude
Code, Cursor, Claude Desktop, or anything else that speaks the protocol. No Nimbus gateway
required.

**What you get depends on your client**, and the difference is writes: see
[Client support](#client-support) before assuming a write tool will appear.

Standalone, a connector gives you:

- **Consent before every mutation.** A write tool asks your MCP client to put the exact operation
  and parameters in front of you, and does nothing unless you approve.
- **A write-scope allow-list**, enforced by the server and unreachable by the model.
- **A mutation budget** per session, which caps a runaway agent loop.
- **A local, hash-chained, append-only audit log**, when `NIMBUS_MCP_AUDIT_LOG` is set.

It does **not** give you the process sandbox, OS-keychain credential storage, the egress ledger, or
owner-controlled consent. Those are properties of the Nimbus gateway and no published package can
supply them. See [`../NOTICE`](../NOTICE).

## Install

**This package is not published yet.** Run it from a checkout:

```bash
bun run packages/mcp-connectors/standalone/src/bin.ts <connector-id>
```

> **Do not run `npx nimbus-mcp`.** An earlier version of this file said to, and that was wrong in a
> way worth stating plainly: `nimbus-mcp` on npm belongs to an unrelated third party — an AWS
> security-assessment server at version 1.6.0 — so the command fetched and executed someone else's
> code. It is also not a name this project can publish under. The bin is now `nimbus-connector` to
> avoid a second collision: `@nimbus-dev/mcp` already ships a `nimbus-mcp` bin that launches the
> **gateway's** MCP server, which is a different program with a different tool surface.

The published name is deliberately still open — it is one of the packaging decisions in the
connector-extraction design, and picking it here would prejudge that.

The launcher refuses a connector that declares write or delete tools which have not yet been routed
through the consent kit, exiting `3` rather than starting it ungated. Today **all 94 are
eligible** — 58 declare no mutating tools, and the other 36 have had their writes routed through
the consent kit. The verdict is derived from each connector's own manifest, never hand-maintained,
so this count cannot drift from the code even if this sentence does.

## Quickstart

Claude Code, Cursor, or Claude Desktop — the config is the same shape everywhere. The write-scope
variable below is only consulted by a client that can show a consent prompt; on Claude Desktop it is
harmless and unused, because the write tools never register.

```json
{
  "mcpServers": {
    "nimbus-github": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/Nimbus/packages/mcp-connectors/standalone/src/bin.ts", "github"],
      "env": {
        "GITHUB_PAT": "ghp_...",
        "NIMBUS_MCP_GITHUB_WRITE_SCOPE": "repo:acme/api",
        "NIMBUS_MCP_AUDIT_LOG": "/absolute/path/to/nimbus-mcp-audit.jsonl"
      }
    }
  }
}
```

Credentials come from the environment. There is no Vault outside the gateway, so whoever writes
this config holds the secret.

| Variable | Meaning |
| --- | --- |
| `NIMBUS_MCP_<SERVICE>_WRITE_SCOPE` | Comma-separated `kind:value` terms, e.g. `repo:acme/api`. Unset authorises nothing. |
| `NIMBUS_MCP_WRITE_BUDGET` | Maximum mutations per session. Defaults to `10`. |
| `NIMBUS_MCP_AUDIT_LOG` | Absolute path for the hash-chained JSONL audit log. Unset disables the durable log; the client-visible log messages are always sent. |
| _connector credentials_ | Per connector, e.g. `GITHUB_PAT`. See the connector's own README. |

## Client support

Reads work everywhere. **Writes require your client to implement the MCP `elicitation` capability**,
because that is the only way a server can put a consent prompt in front of you. A client without it
gets read tools only — see the first entry under [behaviours that look like
bugs](#two-behaviours-that-look-like-bugs-and-are-not).

**This table is a dated observation, not a standing guarantee.** Client support changes between
releases, so the version tested is part of the claim; re-check yours rather than trusting a row.

| Client | Version tested | `elicitation` | Basis | You get |
| --- | --- | --- | --- | --- |
| **Claude Desktop** | 1.34493.1 (MSIX) | **no** | **observed** — see below | **reads only** |
| Claude Code | not tested | yes — form + URL | vendor docs | reads and writes |
| Cursor | not tested | yes, since v1.5 | vendor changelog | reads and writes |
| Anything else | — | check it | — | reads, plus writes if it advertises `elicitation` |

Measured 2026-08-24 against the `github` connector, which exposes 9 read tools and 5 write tools
(`github_pr_merge`, `github_branch_delete`, `github_issue_create`, `github_pr_close`,
`github_tag_create`).

**The two numbers have different provenance, and the difference matters:**

- **9 — observed from the real client.** Claude Desktop 1.34493.1, negotiating protocol
  `2025-11-25`, declared only `roots` and `io.modelcontextprotocol/ui` in its `initialize` frame —
  no `elicitation` — and its own log recorded `Connected to nimbus-github (9 tools)`. Asking it to
  list them returned exactly the nine reads.
- **14 — from a synthetic client.** An SDK client declaring `{ elicitation: {} }`, not a shipped
  application. It establishes what a supporting client *would* be served; it is not evidence about
  any product.

Claude Code and Cursor rows are vendor documentation only — **not measured here**, and not implied
to be by the 14.

This is the designed behaviour, not a degradation we tolerate: a write tool the model cannot see is
one it cannot call without a human. It also means the tool list is an honest signal — if the writes
are there, consent is enforceable.

**Checking your own client** takes one query: ask it to list the connector's tools. If the write
tools are absent, your client does not implement elicitation.

### Two behaviours that look like bugs and are not

**No write tools appear.** Write tools register only if your client advertises the MCP `elicitation`
capability — the mechanism a server uses to ask a human a question. Without it there is no way to
obtain consent, so the tools are not offered at all rather than offered ungated. Reads work
normally. The moment your client ships elicitation support, the same version gains its write tools.
**On Claude Desktop this is the expected state today** — it does not implement elicitation, so you
will see reads only. See [Client support](#client-support).

**Every write refuses with "out of scope".** `NIMBUS_MCP_<SERVICE>_WRITE_SCOPE` is unset. An empty
scope authorises nothing — unset never means unrestricted. The server prints a warning to stderr at
startup saying exactly this.

## See also

- [`../NOTICE`](../NOTICE) — the security tiering, and what standalone does not provide.
- [Nimbus](https://github.com/nimbus-agent/Nimbus) — the gateway, which adds the sandbox, the
  Vault, the egress ledger and owner-controlled consent.

## License

[AGPL-3.0-only](../../../LICENSE). See [`../NOTICE`](../NOTICE) for the security tiering that notice
asks you to preserve.
