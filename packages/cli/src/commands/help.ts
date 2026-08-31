/**
 * `nimbus help` — every command a user can type, grouped.
 *
 * It used to name 39 of the 65 registered commands. The 26 missing included NINE of the fourteen
 * agents, plus `prove`, `egress`, `share`, `update` and the whole team surface: built,
 * dispatchable, documented in the CLI reference, and discoverable only by someone who already
 * knew they existed. Nothing caught it — `audit:readme-cli` checks README→registry, the one
 * direction that cannot see a registry entry missing from here.
 *
 * GROUPED rather than one flat list, because completeness and usability pull against each other
 * at this size: 62 undifferentiated lines is a wall, and a wall is skimmed. The grouping is also
 * the part that does the discovery work — someone who does not know `negotiate` exists finds it
 * by reading the Agents heading, which a flat alphabetical list would never prompt.
 *
 * `help.test.ts` holds the set-difference guard over `COMMAND_NAMES` plus the one-entry
 * `HIDDEN_FROM_HELP` allow-list. Add a command to the registry without adding it here and that
 * test names it.
 */
export function printHelp(): void {
  console.log(`Nimbus CLI — local-first gateway client

Usage:
  nimbus <command> [options]        Add --help after a command for its own flags.

GETTING STARTED
  nimbus init [--no-sync]   Index the current git repo — no credentials, no LLM. Start here.
  nimbus start [--no-wizard] Start gateway (background); omit first-run hint with --no-wizard
  nimbus stop               Stop gateway
  nimbus status [--verbose] [--drift] [--json]   Ping gateway; --verbose adds health + index metrics
  nimbus doctor             Bun version, data dir, Linux vault (secret-tool), gateway state + IPC
  nimbus update             Check for and install a newer Nimbus release
  nimbus version            Show the installed Nimbus version (also: --version, -v)
  nimbus help               Show this message

ASK & SEARCH
  nimbus ask <query>        Natural language (needs LLM keys, or [llm] prefer_local + Ollama)
  nimbus search <q> …       Ranked index search (FTS + optional semantic)
  nimbus query --service <id> [--type <t>] [--since 7d] [--sql "SELECT …"] [--json | --pretty]
  nimbus repl [--session]   Interactive agent loop (TTY)
  nimbus tui                Rich Ink TUI (falls back to REPL on dumb terminals)

AGENTS — read-only briefs over the local index
  nimbus catchup [--since 3d]        Retrospective digest, weighted by your own involvement
  nimbus expert <topic>              Who has the most context on a topic or file
  nimbus impact <file-or-PR-url>     Reverse-dependency blast radius across services / pipelines
  nimbus why <ref>                   Why a line, file or PR is the way it is — six evidence lanes
  nimbus owners <path>               Who WROTE this code, from git blame (not an approval list)
  nimbus janitor <resource>          Is this cloud resource still in use, and what breaks if I delete it
  nimbus glossary [<term>]           The team's own terminology, mined from the local index
  nimbus decisions [--since 90d]     Decisions buried in chat and docs, corroborated against the graph
  nimbus pre-mortem <epic>           Risk brief for a Jira epic, from comparable past epics
  nimbus negotiate [--since 90d]     Your own contribution record, for a compensation conversation

AGENTS THAT NEED PAIRED PEERS — see TEAM below; these query the federation mesh
  nimbus conflicts <file>            Teammates with an open PR, ticket or branch on the same file
  nimbus ghost <file>                Ambient teammate context for a file, from paired peers
  nimbus huddle                      Team-scoped briefing across paired peers
  nimbus preflight <ref> --namespace <ns>   Ask downstream owners to verify your candidate ref

CONNECTORS & INDEX
  nimbus connector …        Register connectors, OAuth, user MCP (add --mcp), sync
  nimbus people …           Cross-service people graph (list, search, get, items, link)
  nimbus watch …            List/pause/resume index watchers
  nimbus index reembed …    Selective re-embedding to a target model; --yes for non-dry runs
  nimbus index rebody …     Re-fetch indexed depth (real outbound traffic); --yes for non-dry runs
  nimbus session …          Session RAG memory (list, clear, recall — needs embeddings)

METRICS & CI/CD
  nimbus metrics dora --service <id> [--since 30d] [--json]   DORA four-key metrics
  nimbus stats <metric> --service <id> [--window 90d] [--bucket 1w]   Bucketed time series
  nimbus deploy preflight --service <id> --target-ref <ref> [--mode warn|block|off]
  nimbus deploy annotate --service <id> --sha <sha> …   Record a deployment for DORA
  nimbus bench --surface <id> [--runs N]   Performance benchmark surfaces

PRIVACY & AUDIT
  nimbus prove [--since 7d]   What left this machine, from the append-only egress ledger
  nimbus egress verify | prune   Verify the ledger chain; prune behind a HITL gate
  nimbus audit [--limit N]    Recent HITL audit rows
  nimbus exec --code <src> | --file <path>   Run code in the sandbox, behind an approval prompt
                              (off by default; enable with [code_execution] enabled = true)
  nimbus computer browser --origin <o> [--script-origin <o>]   HITL-gated browser session
                              (off by default; enable with [computer_use] enabled = true —
                               browser driver not shipped yet, sessions refuse)
  nimbus computer sessions | close <id>   List / close computer-use sessions
  nimbus security scan        Local security scan (secrets, vulnerable deps, risky IaC)
  nimbus data export|import|delete   Encrypted bundle export/import; per-service deletion
  nimbus vault set|get|delete|list   Secrets (OS keyring only — never config, never logs)
  nimbus telemetry show | disable

SHARING
  nimbus share create|list|prune|approve|forward|inbox   Redacted, signed, owner-approved share
  nimbus verify-share <file>       Verify a share's signature
  nimbus clip pair|status|revoke   Pair a browser for web clipping

TEAM (multi-machine — optional)
  nimbus team …             Peer pairing, namespaces, grants, federated queries
  nimbus identity …         OIDC SSO device-code login and operator bindings
  nimbus scim …             SCIM v2 provisioning
  nimbus policy …           Signed org policy (tighten-only)
  nimbus chatops …          Slack/Teams operator surface
  nimbus tribal …           Tribal-knowledge capture to Notion/Confluence
  nimbus lan …              LAN server exposure controls
  nimbus admin …            Admin console surfaces

AUTOMATION & EXTENSIONS
  nimbus workflow …         List/save/run/delete saved workflows (agent steps)
  nimbus run <file>         Save + run workflow from JSON/YAML file
  nimbus extension …        Install/list/enable/disable/remove local extensions
  nimbus scaffold extension <id>   Minimal extension folder + manifest
  nimbus test [dir]         Extension manifest contract + bun test when a test script exists

CONFIG & DIAGNOSTICS
  nimbus config validate | list [--json] | edit
  nimbus profile create|list|switch|delete
  nimbus llm status [--json]   Every registered LLM route (provider/model) and its availability
  nimbus serve [--port 7474]   Start gateway with NIMBUS_HTTP_PORT (read-only HTTP sidecar)
  nimbus db verify | repair --yes | snapshot | snapshots list | backups list | restore <snap> --yes
  nimbus diag [--json] | diag slow-queries [--limit N] [--since 7d]

Environment (optional):
  NIMBUS_GATEWAY_EXECUTABLE   Path to nimbus-gateway binary (overrides auto-detection)
  NIMBUS_GATEWAY_SOCKET       IPC socket/pipe path; honoured by BOTH the CLI and the gateway
  NIMBUS_CONFIG_DIR           Config directory (nimbus.toml); does NOT move the data directory
  OPENAI_API_KEY              OpenAI embeddings when nimbus.toml [embedding] provider = "openai"

Full reference: docs/cli-reference.md
`);
}
