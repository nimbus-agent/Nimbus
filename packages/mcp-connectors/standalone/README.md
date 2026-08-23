# nimbus-mcp

## What this is

Runs a Nimbus first-party connector as a **standalone MCP server**, for any MCP client — Claude
Desktop, Cursor, or anything else that speaks the protocol. No Nimbus gateway required.

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

```bash
npx nimbus-mcp <connector-id>
```

Nothing to install ahead of time — `npx` fetches it on first run.

Not every connector can run standalone. The launcher refuses one whose mutating tools have not yet
been routed through the consent kit, and exits `3` rather than starting it ungated. Today **51 of
94** are eligible: the 50 with no mutating tools at all, plus `github`. The rest are gateway-only
until migrated, and the list is derived from the connectors themselves, never hand-maintained.

## Quickstart

Claude Desktop or Cursor:

```json
{
  "mcpServers": {
    "nimbus-github": {
      "command": "npx",
      "args": ["-y", "nimbus-mcp", "github"],
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

### Two behaviours that look like bugs and are not

**No write tools appear.** Write tools register only if your client advertises the MCP `elicitation`
capability — the mechanism a server uses to ask a human a question. Without it there is no way to
obtain consent, so the tools are not offered at all rather than offered ungated. Reads work
normally. The moment your client ships elicitation support, the same version gains its write tools.

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
