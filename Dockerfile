# Nimbus MCP server — stdio transport.
#
# This image exists so MCP registries can build and introspect the Nimbus MCP
# server. It is NOT how you run Nimbus.
#
# Nimbus is local-first: the SQLite index, the Vault and the audit log live on
# your machine, and credentials are held in the OS keystore. Inside this
# container there is no Gateway, no index and no credentials, so protocol
# introspection (initialize / tools/list) succeeds while individual tool CALLS
# return errors. Tool calls need a Gateway running on the host — install Nimbus
# and run `nimbus start`, then point your editor at `nimbus mcp-server --stdio`.
#
# See docs/install.md for the supported install channels.

FROM debian:bookworm-slim

ARG NIMBUS_VERSION=v1.12.1

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && curl -fsSL -o /usr/local/bin/nimbus \
      "https://github.com/nimbus-agent/Nimbus/releases/download/${NIMBUS_VERSION}/nimbus-cli-linux-x64" \
 && chmod +x /usr/local/bin/nimbus \
 && apt-get purge -y --auto-remove curl \
 && rm -rf /var/lib/apt/lists/*

ENTRYPOINT ["nimbus", "mcp-server", "--stdio"]
