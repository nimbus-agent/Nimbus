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

# Nimbus publishes one Linux CLI binary, x64 only — there is no linux/arm64
# asset to select. The platform is therefore pinned rather than resolved from
# TARGETARCH; on an arm64 builder this runs under emulation.
FROM --platform=linux/amd64 debian:bookworm-slim

# Bumping NIMBUS_VERSION requires updating NIMBUS_CLI_SHA256 to match, taken
# from that release's SHA256SUMS. A mismatch fails the build by design.
ARG NIMBUS_VERSION=v1.12.1
ARG NIMBUS_CLI_SHA256=78e43ec607d2fcd62e7395ff09bdf829558f772578c2bde4d4d2970ffaa6e444

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && curl -fsSL -o /tmp/nimbus \
      "https://github.com/nimbus-agent/Nimbus/releases/download/${NIMBUS_VERSION}/nimbus-cli-linux-x64" \
 && echo "${NIMBUS_CLI_SHA256}  /tmp/nimbus" | sha256sum -c - \
 && install -m 0755 /tmp/nimbus /usr/local/bin/nimbus \
 && rm -f /tmp/nimbus \
 && apt-get purge -y --auto-remove curl \
 && rm -rf /var/lib/apt/lists/*

ENTRYPOINT ["nimbus", "mcp-server", "--stdio"]
