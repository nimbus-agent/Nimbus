export function printHelp(): void {
  console.log(`Nimbus CLI — local-first gateway client

Usage:
  nimbus init [--no-sync]   Index the current git repo — no credentials, no LLM. Start here.
  nimbus start [--no-wizard] Start gateway (background); omit first-run hint with --no-wizard
  nimbus stop               Stop gateway
  nimbus status [--verbose] [--drift] [--json]   Ping gateway; --verbose adds health + index metrics; --drift adds IaC/AWS index hints
  nimbus db verify [--json] | repair --yes [--json] | snapshot | snapshots list | snapshots prune --yes | backups list | restore <snap> --yes
  nimbus diag [--json] | diag slow-queries [--limit N] [--since 7d]
  nimbus query --service <id> [--type <t>] [--since 7d] [--sql "SELECT …"] [--json | --pretty]
  nimbus telemetry show | disable
  nimbus tui                Rich Ink TUI (falls back to REPL on dumb terminals).
  nimbus doctor             Bun version, data dir, Linux vault (secret-tool), gateway state + IPC
  nimbus config validate | list [--json] | edit
  nimbus profile create|list|switch|delete
  nimbus serve [--port 7474]   Start gateway with NIMBUS_HTTP_PORT (read-only HTTP sidecar)
  nimbus test [dir]         Extension manifest contract + bun test when package.json has a test script
  nimbus search <q> …       Ranked index search (FTS + optional semantic)
  nimbus ask <query>        Natural language (exits early if no connectors registered; needs LLM keys on gateway)
  nimbus expert <topic>     Rank team members with the most context on a topic or file
  nimbus impact <file-or-PR-url>   Reverse-dependency blast radius across services / pipelines / dashboards
                                   (--depth is accepted but reserved for future recursive traversal)
  nimbus index reembed --model <id> [--item-type <key>] [--service <name>] [--limit N] [--batch-size N] [--dry-run] [--yes] [--json]
                            Selective re-embedding to a target model; required --yes for non-dry runs
  nimbus index rebody [--service <name>] [--type <t>] [--limit N] [--since <days>] [--dry-run] [--yes] [--json]
                            Re-fetch indexed depth: truncated legacy bodies, and Jira/Linear metadata below the
                            required version. --since widens the cold-start window past the connector's built-in
                            30 days (jira/linear only; others ignore it).
                            Real outbound API traffic (can re-walk a WHOLE account); required --yes for non-dry runs
  nimbus catchup [--since 3d] [--json] [--service <id>]   Personalised retrospective digest weighted by your involvement
  nimbus glossary [<term>] [--limit N] [--json]   The team's own terminology, mined from the local index
  nimbus llm status [--json]   Show selected LLM provider/model per task type and availability
  nimbus metrics dora --service <id> [--since 30d] [--json]   DORA four-key metrics for a configured service
  nimbus deploy preflight --service <id> --target-ref <ref> [--mode warn|block|off] [--json]   Pre-deploy index check
  nimbus deploy annotate --service <id> --sha <sha> --target-ref <ref> --env <env> --status <success|failure|cancelled|in_progress> --started-at <ms> [--provider P] [--run-id R] [--job-id J] [--workflow-url U] [--finished-at <ms>] [--json]
      Record a completed deployment for DORA + agent correlation.
  nimbus clip pair [--label <device>]   open a pairing window and print the one-time code
  nimbus clip status                    list paired browsers (labels + token fingerprints)
  nimbus clip revoke <label|--all>      revoke a paired browser's token
  nimbus vault set <k> <v>  Store a secret
  nimbus vault get <k>      Read a secret (prompts first)
  nimbus vault delete <k>    Remove a secret
  nimbus vault list [pfx]   List vault key names
  nimbus audit [--limit N] [--json]  Recent HITL audit rows
  nimbus connector …       Register connectors, OAuth, user MCP (add --mcp), sync (see: nimbus connector help)
  nimbus extension …       Install/list/enable/disable/remove local extensions (needs gateway)
  nimbus people …          Cross-service people graph (list, search, get, items, link)
  nimbus session …         Session RAG memory (list, clear, recall — needs embeddings)
  nimbus workflow …        List/save/run/delete saved workflows (agent steps)
  nimbus watch …           List/pause/resume index watchers
  nimbus repl [--session]  Interactive agent loop (TTY)
  nimbus run <file>        Save + run workflow from JSON/YAML file
  nimbus scaffold extension <id>  Minimal extension folder + manifest
  nimbus version            Show the installed Nimbus version (also: --version, -v)
  nimbus help               Show this message

Environment (optional):
  NIMBUS_GATEWAY_EXECUTABLE   Path to nimbus-gateway binary (overrides auto-detection)
  NIMBUS_GATEWAY_SOCKET       IPC socket/pipe path; honoured by BOTH the CLI and the gateway
  NIMBUS_CONFIG_DIR           Config directory (nimbus.toml); does NOT move the data directory
  OPENAI_API_KEY              OpenAI embeddings when nimbus.toml [embedding] provider = "openai"
`);
}
