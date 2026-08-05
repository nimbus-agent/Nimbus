# @nimbus-dev/mcp

## What this is

A tiny launcher that exposes your local [Nimbus](https://nimbus-agent.dev) index and agents to
any [MCP (Model Context Protocol)](https://modelcontextprotocol.io) client — editors, chat clients,
or other MCP-speaking tools. It does no work itself: it locates the Nimbus CLI binary already
installed on your machine and execs it as `nimbus mcp-server --stdio`, then gets out of the way and
lets stdio pass straight through.

This package is MIT-licensed and does not depend on (or import from) the AGPL-3.0 `packages/cli` or
`packages/gateway` Nimbus source — it only knows how to *find* the installed binary, never how to
run the gateway itself.

**Requires the Nimbus gateway to already be installed.** This launcher does not install or bundle
Nimbus; run the regular Nimbus installer first, and keep the gateway configured the way you
normally use it (the `mcp-server --stdio` command talks to your existing local index).

## Install

Run it directly, without a global install, from your MCP client's config (see below), or install it
explicitly:

```bash
npm install -g @nimbus-dev/mcp
```

## Quickstart

Add `nimbus-mcp` as a command in your MCP client's server configuration, for example:

```json
{
  "mcpServers": {
    "nimbus": {
      "command": "npx",
      "args": ["-y", "@nimbus-dev/mcp"]
    }
  }
}
```

The launcher looks for the Nimbus binary in this order:

1. `NIMBUS_BIN` — an explicit full path to the binary, if set. A `NIMBUS_BIN` that points at a
   non-existent file is reported as an error, never silently ignored.
2. `PATH` — the first `nimbus` (or `nimbus.exe` on Windows) found on your `PATH`.
3. Known per-platform install directories (e.g. `~/.nimbus/bin`, `/usr/local/bin`, or
   `%LOCALAPPDATA%\Nimbus\bin` on Windows).

If none of those resolve, the launcher exits with a message naming the fix — never a bare exit code.

### Environment variables

- `NIMBUS_BIN` — override the resolved binary path. Point it at the exact Nimbus CLI executable.
- `NIMBUS_MCP_TIMEOUT_MS` — lower the MCP transport timeout when your editor's own MCP transport
  timeout is shorter than the gateway's default (60 s). This is read by the underlying `nimbus
  mcp-server` process, which this launcher execs with your environment inherited unchanged.

## See also

- [`docs/architecture.md`](https://github.com/nimbus-agent/Nimbus/blob/main/docs/architecture.md) —
  Nimbus subsystem design and the MCP connector standard.
- The gateway's `mcp-server` command, in the main [Nimbus](https://github.com/nimbus-agent/Nimbus)
  repository (`packages/gateway`, `packages/cli`) — this package launches it, but does not contain
  or license it.

## License

MIT — see [`LICENSE`](./LICENSE). Note that the Nimbus gateway and CLI this launcher execs are
licensed separately under AGPL-3.0.
