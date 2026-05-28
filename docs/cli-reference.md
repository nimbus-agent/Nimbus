# Nimbus CLI Reference

Complete reference for all `nimbus` commands. For installation see [`README.md`](./README.md). For architecture context see [`architecture.md`](./architecture.md).

**Three ways to use Nimbus interactively:**

- [`nimbus tui`](#nimbus-tui) — rich Ink terminal UI (5 panes, streaming result, inline mid-stream HITL, live connector + watcher + sub-task panes). Auto-falls back to the REPL on unsuitable terminals.
- [`nimbus repl`](#nimbus-repl) — line-based readline loop for scripts, SSH, CI, and other headless environments. `nimbus` with no arguments on an interactive shell is an alias.
- `nimbus <command>` — one-shot commands documented below (`ask`, `search`, `query`, `run`, `status`, `doctor`, `diag`, …).

---

## Global Flags

These flags are accepted by every command.

| Flag | Description |
|---|---|
| `--help`, `-h` | Print command help and exit |
| `--version`, `-v` | Print Nimbus version and exit |
| `--no-color` | Disable ANSI colour output |
| `--json` | Machine-readable JSON output (where supported) |

---

## Gateway Lifecycle

### `nimbus start`

Start the Gateway as a background process and register it for autostart on login.

```bash
nimbus start
nimbus start --no-wizard        # Skip first-run onboarding hints
```

The Gateway starts in the background and listens on the platform-native IPC socket. On first start it prints next-step hints (connect a service, run `nimbus doctor`) unless `--no-wizard` is passed or the index already contains items.

The Gateway also writes **structured JSON logs** (Pino) to a daily file under your data directory’s **`logs/`** folder, named `gateway-YYYY-MM-DD.log` (same path the CLI uses when it redirects the child process). This applies whether you start via `nimbus start` or run the gateway binary directly, so logs are available even when nothing is attached to a console.

---

### `nimbus stop`

Stop the running Gateway process.

```bash
nimbus stop
```

---

### `nimbus status`

Show Gateway status and connector health.

```bash
nimbus status
nimbus status --verbose         # Per-connector item counts, p95 query latency, health lines
nimbus status --drift           # Include IaC drift hints alongside status
nimbus status --json
```

**Output includes:** Gateway PID, uptime, active profile, total indexed items, agent limits (`depth=N  tool-calls/session=N`), connector list with health state (`healthy` / `degraded` / `error` / `rate_limited` / `unauthenticated` / `paused`).

---

## Querying and Asking

### `nimbus ask`

Ask the agent a natural-language question or give it a task. The agent answers from the local index; it only calls live APIs when freshness is required. Any destructive or outgoing action requires HITL consent before it executes.

```bash
nimbus ask "Find all PDFs I received last month that I haven't opened"
nimbus ask "Which of my open PRs mention payment-service and have failing CI?"
nimbus ask "What caused the payment-service alert — what deployed recently?"
nimbus ask "Summarise everything that happened across my projects this week"
```

**Session mode:** Run `nimbus` with no arguments to open an interactive REPL. Context accumulates across turns.

```bash
nimbus                          # Opens interactive session
```

For a richer interactive experience — live connector health, sub-task progress bars, inline mid-stream HITL consent — use [`nimbus tui`](#nimbus-tui) instead.

---

### `nimbus search`

Fast structured search over the local index. Answers come from the SQLite metadata index — no cloud call is made unless `--live` is passed.

```bash
nimbus search --service google_drive --type pdf --since 30d
nimbus search --service github --type pr --state open
nimbus search --service slack --query "payment-service incident" --since 7d
nimbus search --semantic "quarterly review documents"    # Semantic/vector search
nimbus search --service linear --type issue --assignee me
```

**Options:**

| Flag | Description |
|---|---|
| `--service <name>` | Filter by connector (e.g. `github`, `google_drive`, `slack`) |
| `--type <type>` | Item type (`pr`, `issue`, `file`, `email`, `message`, `pipeline_run`, …) |
| `--since <duration>` | Time filter — e.g. `7d`, `2w`, `1m`, `2026-01-01` |
| `--until <duration>` | Upper time bound |
| `--state <state>` | Item state (e.g. `open`, `closed`, `merged`) |
| `--assignee <handle>` | Filter by assignee handle or `me` |
| `--query <text>` | Full-text search term |
| `--semantic <text>` | Vector/semantic search (uses local embedding model) |
| `--limit <n>` | Maximum results (default: 20) |
| `--json` | JSON output |

---

### `nimbus query`

Structured index query with explicit filters or raw SQL. Intended for scripting and CI pipelines.

```bash
nimbus query --service github --type pr --since 7d
nimbus query --service linear --type issue --since 14d --json
nimbus query --sql "SELECT title, url FROM items WHERE pinned = 1" --pretty
nimbus query --service pagerduty --type alert --since 1d --json | jq '.[] | .title'
```

**Options:**

| Flag | Description |
|---|---|
| `--service <name>` | Filter by connector |
| `--type <type>` | Item type |
| `--since <duration>` | Lower time bound |
| `--until <duration>` | Upper time bound |
| `--pinned` | Only pinned items |
| `--sql <query>` | Raw read-only SQL (SELECT only; DML is blocked) |
| `--pretty` | Pretty-print table output |
| `--json` | JSON array output |
| `--limit <n>` | Max rows (default: 50) |

> **Security note:** `--sql` is guarded — only `SELECT` statements are allowed. Any `INSERT`, `UPDATE`, `DELETE`, or DDL is rejected before execution.

---

### `nimbus run`

Execute a YAML script file as a single agent session. All steps use the same engine as `nimbus ask`. Steps requiring HITL are identified in a preview before any execution begins.

```bash
nimbus run ./weekly-cleanup.yml
nimbus run ./deploy.yml --no-ttv          # Dry-run / preview only, no consent prompts
```

**Script format:**

```yaml
name: weekly-cleanup
steps:
  - Find all PDF files in Google Drive not opened in 90 days
  - Summarize them by project folder
  - Move the ones from the Zurich project to /Archive/2025
  - Send me an email with the summary
```

Optional per-step metadata:

```yaml
steps:
  - prompt: Move files older than 90 days to archive
    label: archive-old-files
    continue-on-error: false
```

Scripts with only read-only steps run without a TTY (safe for CI). Scripts with HITL-required steps require an interactive terminal.

---

### `nimbus sync`

Manually trigger a sync cycle for one or all connectors.

```bash
nimbus sync all
nimbus sync github
nimbus sync google_drive
```

---

## Team Intelligence

Built-in agents that answer team-level questions from the local relationship graph and indexed metadata. Each agent is read-only, never triggers HITL, and streams a Markdown brief to stdout.

### `nimbus expert`

Answer "who on my team has the most context on this?" — returns a ranked list of people drawn from indexed PR authorship, review participation, Slack thread activity, and Linear/Jira ticket assignments. Each ranking comes with a confidence score and the underlying evidence.

```bash
nimbus expert src/billing/retry.ts
nimbus expert "payment retry logic"
nimbus expert --json src/billing/retry.ts
```

**Options:**

| Flag | Description |
|---|---|
| `--limit <n>` | Maximum number of ranked people to return (default: 5) |
| `--json` | Machine-readable JSON output (otherwise Markdown) |

**Output (Markdown):** ranked list of contributors, each with their evidence (e.g. *"authored 4 of the last 6 PRs touching this file, resolved 2 incidents tagged `payment-retry`"*) and any **gap notes** if the local index lacks the connectors or relations needed for a confident answer (e.g. "no GitHub connector authenticated", "no review history for this file").

**Read-only:** never triggers HITL, never makes a live API call — answered entirely from the local index.

---

### `nimbus impact`

Answer "if I change this, what breaks?" — reverse-dependency blast radius across five categories: services that import the affected module (via indexed code symbols and `depends_on` graph edges), pipelines that would rebuild (via `pipeline_run` items linked to the repo), dashboards pulling from affected data models (via `upstream_refs` graph edges), API endpoints exposed by the affected service (via the OpenAPI indexer's `api_endpoint → service` edges), and on-call rotations that own the affected services (via PagerDuty schedules). Five parallel sub-agents over the relationship graph.

```bash
nimbus impact src/billing/retry.ts
nimbus impact https://github.com/acme/payment-service/pull/312
nimbus impact --json --service payment-service src/billing/retry.ts
```

**Options:**

| Flag | Description |
|---|---|
| `--service <id>` | Restrict the report to a single service id |
| `--json` | Machine-readable JSON output (otherwise Markdown) |

**Output (Markdown):** structured blast-radius report grouped by category (services / pipelines / dashboards / endpoints / on-call), with gap notes when the local index lacks a connector or relation needed for a confident answer.

**Read-only:** never triggers HITL, never makes a live API call. Built entirely on the Phase 3 relationship graph substrate — no new connectors required.

---

### `nimbus catchup`

Personalized retrospective digest of everything that happened across connected services while you were away, weighted by your historical involvement. Unlike `nimbus changelog` (service-scoped and uniform), `catchup` prioritizes activity by the user's recent work: services they own, repos they contribute to, incidents they've responded to, people they collaborate with frequently. Five parallel sub-agents (`s_owned_services`, `s_active_repos`, `s_responded_incidents`, `s_collaborators`, `s_window_items`); three-tier self-person resolver (override → git email → OS username).

```bash
nimbus catchup
nimbus catchup --since 7d
nimbus catchup --since 24h --service payment-service --json
```

**Options:**

| Flag | Description |
|---|---|
| `--since <duration>` | Window to summarise (default: `3d`); accepts `<n>d` / `<n>h` |
| `--service <id>` | Restrict the digest to a single service |
| `--json` | Machine-readable JSON output (otherwise Markdown) |

**Output (Markdown):** sections per service, prioritized by a per-section relevance score; each section lists recent items (PRs, incidents, threads, tickets) with one-line context.

**Read-only:** never triggers HITL, never makes a live API call.

---

## CI/CD

DORA metrics, pre-deploy checks, and post-deploy annotation — answered from the local index without an external API call. All three commands target a stable `<service-id>` you choose (e.g. `payment-service`); the underlying repo URNs (`<provider>:<owner>/<repo>`) and PagerDuty service ids are configured per-service in `[metrics.dora.<service-id>]` / `[ci.service.<service-id>]` blocks in `nimbus.toml`.

### `nimbus metrics dora`

Compute the four DORA metrics — deployment frequency, lead time for changes, change failure rate, MTTR — for a service over a chosen window. Answered entirely from indexed deployments, PRs, and incidents.

```bash
nimbus metrics dora --service payment-service
nimbus metrics dora --service payment-service --since 30d --json
```

**Options:**

| Flag | Description |
|---|---|
| `--service <id>` | Service id (the table key in `[metrics.dora.<id>]`) (required) |
| `--since <duration>` | Window — `<n>d` or `<n>h`, e.g. `30d`, `24h` (default: `30d`) |
| `--json` | Machine-readable JSON output |

Read-only; no HITL.

---

### `nimbus deploy preflight`

Pre-deploy index check: counts active P1 incidents, failing CI on the target ref, and open PR conflicts. Useful as a deploy-gate step in CI.

```bash
nimbus deploy preflight --service payment-service --target-ref main
nimbus deploy preflight --service payment-service --target-ref release/v2.14 --mode block --json
```

**Options:**

| Flag | Description |
|---|---|
| `--service <id>` | Service id (required) |
| `--target-ref <ref>` | Git ref being deployed (required) |
| `--mode <warn\|block\|off>` | `warn` (default) — print findings, exit 0. `block` — exit 1 when any finding triggers the gate. `off` — skip checks |
| `--json` | Machine-readable JSON output |

**Exit codes:** `0` = ok (or `warn` mode with findings); `1` = `block` mode triggered or usage error; `2` = infrastructure failure (gateway not running, IPC error, malformed envelope).

A first-party GitHub Action wraps `GET /v1/preflight/deploy` for use directly in workflows — see [`packages/github-actions/preflight-query/`](../packages/github-actions/preflight-query/).

Read-only; no HITL.

---

### `nimbus deploy annotate`

Record a deployment event in the local index after a deploy completes. The Gateway upserts a `deployment` item and writes one audit entry. Used by CI to feed DORA metrics.

```bash
nimbus deploy annotate \
  --service payment-service \
  --sha 4a3f9c2 \
  --target-ref main \
  --env production \
  --status success \
  --started-at 1715812800000 \
  --finished-at 1715813100000 \
  --provider github-actions \
  --run-id 12345
```

**Options:**

| Flag | Description |
|---|---|
| `--service <id>` | Service id — 1..64 chars matching `[a-z0-9][a-z0-9._-]*` (required) |
| `--sha <sha>` | Deployed commit SHA — 7..64 lowercase hex chars (required) |
| `--target-ref <ref>` | Git ref deployed (required) |
| `--env <env>` | Environment (`production`, `staging`, …) — 1..32 chars matching `[a-z0-9][a-z0-9._-]*` (required) |
| `--status <s>` | One of `success`, `failure`, `cancelled`, `in_progress` (required) |
| `--started-at <ms>` | Deploy start time, unix milliseconds (required) |
| `--finished-at <ms>` | Deploy end time, unix milliseconds (optional) |
| `--provider <name>` | One of `github-actions`, `gitlab`, `jenkins`, `circleci`, `bitbucket`, `other` (default: `other`) |
| `--workflow-url <url>` | Optional pointer to the CI run URL |
| `--run-id <id>` | CI run identifier |
| `--job-id <id>` | CI job identifier within the run |
| `--json` | Machine-readable JSON output |

**HTTP write surface:** internally this routes through `POST /v1/deployments` on the local HTTP API, which is the **only** write route the HTTP server accepts (invariant `I13`). Bearer auth, an 8 KiB body cap, and per-token rate limiting all apply; every rejection is recorded as a `deployment.annotation_rejected` audit row.

**Required vault key:**

| Key | Purpose |
|---|---|
| `http_api.deployment_token` | Bearer token sent with every `POST /v1/deployments`. Set with `nimbus vault set http_api.deployment_token <token>`. Without it the HTTP write surface returns 503 (`write_surface_disabled`). |

A first-party GitHub Action wraps the endpoint for use directly in workflows — see [`packages/github-actions/annotate-action/`](../packages/github-actions/annotate-action/).

---

## Security

### `nimbus security scan`

Local credential-hygiene scan over already-indexed content.

```bash
nimbus security scan         # pretty table
nimbus security scan --json  # frozen JSON envelope (machine-readable)
```

**What it does.** Iterates every `item` row from connectors at `summary` or
`full` depth, applies a curated set of high-precision regex patterns
against `body_preview`, and reports likely secrets along with their
connector, item id, and modification time. **Read-only** — the scan never
fetches new content, never invokes a connector, never writes anything
beyond a single summary audit row. Connectors at `metadata_only` depth
are skipped and listed in the response.

**Output safety.** The full secret value never appears in stdout, JSON,
logs, or any audit row. Findings show:

- `match_redacted` — first-4 + `****` + last-4 (e.g. `AKIA****MPLE`).
- `context_snippet` — ±40 chars around the match, secret middle replaced
  with the literal string `[REDACTED]`.

**Posture.** CLI-only — not exposed to the Tauri renderer (not in
`ALLOWED_METHODS`), not callable over LAN (in `FORBIDDEN_OVER_LAN` as
exfiltration-class), not on the HTTP API.

**Exit codes.** `0` on completion (with or without findings); `1` on
usage error or gateway-not-running; `2` on IPC failure / malformed
response.

---

## Interactive Sessions

### `nimbus tui`

Launch the rich Ink terminal UI for interactive sessions.

```bash
nimbus tui
```

**Panes** (Option-1 "classic split" layout):

- **Query input** (top bar) — type a query; `Enter` submits.
- **Result stream** (main area) — tokens render live; scrollback preserved via Ink `<Static>` so prior output never re-renders.
- **Connector health** (right column) — polls `connector.list` every 30 s; renders `●` / `◐` / `○` glyphs for `ok` / `degraded` / `down`.
- **Watchers** (right column) — polls `watcher.list` every 30 s; shows N active, M firing, plus up to 5 firing watcher names (truncates beyond with `…N more`).
- **Sub-tasks** (right column) — event-driven via `agent.subTaskProgress`; renders a progress bar + status glyph per sub-task, truncated beyond 8 rows with `…N more (M total)`. Clears when a new query is submitted.

**Interaction:**

- `Up` / `Down` cycles history from `tui-query-history.json` (last 100 queries, dedup-on-repeat-of-last).
- `Ctrl+C` once during a stream → cancels locally with `(canceled by user — LLM may continue in the background)` line; `^C Press again within 2s to exit` hint renders for 1.5 s. Double `Ctrl+C` within 2 s → exits cleanly.
- **Mid-stream HITL:** `──[ consent required ]──` banner appears inline; prompt switches to `nimbus[hitl]>` with single-keystroke capture:
  - `a` — approve current action
  - `r` — reject current action
  - `d` — show details (no-op in v0.1.0; full payload is already shown)
  - `q` — reject all remaining actions and exit

**Automatic fallback** (invokes `nimbus repl` instead, no Ink render) when any of these hold:

- `TERM=dumb`
- `NO_COLOR` set (any value)
- stdout is not a TTY (pipe, file, non-interactive shell)
- `CI=true`
- Terminal height is below 20 rows

Fallback path prints exactly one reason (first match wins) to stderr before handing off to the REPL.

**Responsive layout:**

- Below 100 columns: collapses to a single-column layout with a compact status bar replacing the right column.
- Below 20 rows at any time: Ink unmounts cleanly with a one-line notice; relaunch after resizing.

**Gateway-offline behavior:**

- Top banner: `⚠ Gateway disconnected — reconnecting…`
- Poll panes show last-known data with a `(stale)` marker.
- Input dimmed and disabled; `Ctrl+C` still exits.
- Exponential reconnect: 2 s → 4 s → 8 s → 16 s → 30 s (repeats). Input re-enables on reconnect; `✓ Reconnected` fade confirms recovery.

**Cancel note (v0.1.0):** cancel is local-only — the Gateway has no `engine.cancelStream` handler yet, so the LLM may continue generating in the background after `Ctrl+C`. Full-fidelity cancellation is a post-v0.1.0 Gateway follow-up.

---

### `nimbus repl`

Line-based readline loop over `agent.invoke`. Always works (no Ink dependency), including SSH sessions, dumb terminals, CI, and non-TTY pipelines.

```bash
nimbus repl                      # Interactive line-based session
nimbus repl --session <id>       # Resume a saved session
```

Use this for scripts and headless environments; `nimbus tui` is the richer alternative for interactive developer sessions. `nimbus tui`'s fallback path invokes `runRepl` internally on unsuitable terminals, so you never need to choose manually — just run `nimbus tui` and let it degrade.

---

## Connectors

### `nimbus connector auth <service>`

Authenticate a service and store credentials in the OS keystore. Never stores credentials to disk or logs.

```bash
nimbus connector auth google_drive  # OAuth PKCE — opens browser
nimbus connector auth gmail
nimbus connector auth google_photos
nimbus connector auth onedrive
nimbus connector auth outlook
nimbus connector auth teams
nimbus connector auth github        # PAT prompt — stored in OS keystore
nimbus connector auth gitlab
nimbus connector auth linear
nimbus connector auth jira
nimbus connector auth slack
nimbus connector auth pagerduty
nimbus connector auth aws
nimbus connector auth azure
nimbus connector auth gcp
nimbus connector auth kubernetes
nimbus connector auth snyk           # API token
nimbus connector auth sonarqube      # API token (+ optional org for SonarCloud)
nimbus connector auth semgrep        # PAT
nimbus connector auth bitrise        # PAT
```

---

### `nimbus connector list`

List all connectors and their current health state.

```bash
nimbus connector list
nimbus connector list --json
```

**Health states:** `healthy` · `degraded` · `error` · `rate_limited` · `unauthenticated` · `paused`

---

### `nimbus connector status <name>`

Show detailed status for a single connector.

```bash
nimbus connector status github
nimbus connector status github --json
```

---

### `nimbus connector sync <name>`

Trigger an immediate sync for a connector.

```bash
nimbus connector sync github
nimbus connector sync google_drive
```

---

### `nimbus connector pause <name>` / `resume <name>`

Pause or resume sync scheduling for a connector without removing its credentials.

```bash
nimbus connector pause github
nimbus connector resume github
```

---

### `nimbus connector set-interval <name> <seconds>`

Override the sync interval for a connector.

```bash
nimbus connector set-interval github 300
```

---

### `nimbus connector history <name>`

Show the health transition history for a connector — useful for diagnosing flapping or persistent errors.

```bash
nimbus connector history github
nimbus connector history github --limit 50
nimbus connector history github --json
```

---

### `nimbus connector remove <name>`

Remove a connector: deletes all associated Vault entries and index rows atomically. Irreversible — requires confirmation.

```bash
nimbus connector remove github
nimbus connector remove github --yes    # Skip confirmation
```

---

### `nimbus connector reindex <name>`

Re-ingest a connector's data at a chosen depth. Useful after changing data-minimization policy, recovering from a corrupted partial sync, or applying a new schema version. The Gateway preserves Vault credentials; only index rows are rewritten.

```bash
nimbus connector reindex github
nimbus connector reindex slack --depth metadata_only
nimbus connector reindex notion --depth summary
nimbus connector reindex confluence --depth full
```

**Depth values:**

| Depth | Effect |
|---|---|
| `metadata_only` *(default)* | IDs, timestamps, titles, URLs, owners — no body content |
| `summary` | Metadata + first-N-tokens summary of each item |
| `full` | Metadata + summary + full body content (largest index footprint) |

Output reports the resolved mode and the number of items affected. The depth is persisted as the connector's default for subsequent delta syncs.

---

## Configuration

### `nimbus config get <key>`

Read a single configuration value.

```bash
nimbus config get sync.intervalSeconds
nimbus config get telemetry.enabled
nimbus config get llm.remote_model
```

---

### `nimbus config set <key> <value>`

Set a configuration value. Changes take effect on the next Gateway restart for Gateway-owned keys; CLI-only keys take effect immediately.

```bash
nimbus config set sync.intervalSeconds 300
nimbus config set telemetry.enabled false
nimbus config set llm.remote_model      claude-sonnet-4-6
nimbus config set llm.classifier_model  claude-haiku-4-5-20251001
```

The provider is inferred from the model id: `claude-*` → Anthropic, `gpt-*` / `o1-*` / `o3-*` / `o4-*` → OpenAI. Already-prefixed forms (`anthropic/...`, `openai/...`) are accepted as-is.

---

### `nimbus config list`

List all configuration keys with their current values, source (`file` / `env` / `default`), and documentation.

```bash
nimbus config list
nimbus config list --json
```

---

### `nimbus config validate`

Validate the current `nimbus.toml` configuration file against the schema. Exits `0` on success, `1` on error.

```bash
nimbus config validate
```

---

### `nimbus config edit`

Open `nimbus.toml` in `$EDITOR`.

```bash
nimbus config edit
```

---

### Configuration File

`nimbus.toml` lives in the platform config directory:

| Platform | Path |
|---|---|
| Windows | `%APPDATA%\Nimbus\nimbus.toml` |
| macOS | `~/Library/Application Support/Nimbus/nimbus.toml` |
| Linux | `~/.config/nimbus/nimbus.toml` |

Key sections:

```toml
[llm]
# Conversational agent (Mastra). Provider is inferred from the model id:
# claude-* → Anthropic; gpt-*/o1-*/o3-*/o4-* → OpenAI.
remote_model       = "claude-sonnet-4-6"
# Cheaper/faster model used by the intent classifier. May differ from remote_model.
classifier_model   = "claude-haiku-4-5-20251001"
# Local-LLM routing (Phase 4 LLM router).
prefer_local       = true
local_model        = "llama3.2"
# llamacpp_server_path = "/usr/local/bin/llama-server"
# enforce_air_gap   = false
# max_agent_depth   = 3              # 1–10
# max_tool_calls_per_session = 20    # 1–200

[embedding]
enabled = true
provider = "local"              # local | openai
# model = "all-MiniLM-L6-v2"

[telemetry]
enabled = false
endpoint = "https://telemetry.nimbus-agent.dev/v1/collect"

[filesystem]
# roots = ["/home/user/projects", "/home/user/documents"]

[updater]
# enabled = true
# url = "https://releases.nimbus-agent.dev/latest.json"

[lan]
# enabled = false
# port = 7475

[automation]
# graph_conditions = true
```

**Environment variable overrides:** Most TOML keys have a corresponding `NIMBUS_`-prefixed env var that wins over the file. Examples: `NIMBUS_AGENT_MODEL` (overrides `[llm].remote_model`), `NIMBUS_CLASSIFIER_MODEL` (overrides `[llm].classifier_model`), `NIMBUS_TELEMETRY_ENABLED`. See the [Environment Variables](#environment-variables) table at the end of this document for the full list.

---

## Profiles

Named configuration profiles let you maintain separate settings (e.g. `work` vs `personal`). Each profile has its own Vault key prefix — credentials from one profile are not accessible to another.

### `nimbus profile create <name>`

```bash
nimbus profile create work
nimbus profile create personal
```

---

### `nimbus profile list`

```bash
nimbus profile list
```

---

### `nimbus profile switch <name>`

Switch the active profile. Takes effect on the next Gateway restart.

```bash
nimbus profile switch work
nimbus profile switch personal
```

---

### `nimbus profile delete <name>`

Delete a profile and its associated configuration. Does not delete Vault entries (use `nimbus connector remove` first).

```bash
nimbus profile delete personal
```

---

## Diagnostics and Observability

### `nimbus doctor`

Run environment health checks and print actionable remediation steps. Useful as a first step when something isn't working.

```bash
nimbus doctor
```

**Checks performed:**

- Bun minimum version requirement
- Linux: `secret-tool` available (libsecret)
- Gateway IPC reachable
- Configuration file validates
- Index total item count (warns if zero — suggests connecting a service)
- Per-connector health table
- Voice (when `voice.enabled = true` in config): `whisper-cli` on PATH, `ffmpeg` on PATH, platform TTS available (`espeak-ng` on Linux, `say` on macOS, PowerShell SAPI on Windows)

**Exit codes:** `0` = all healthy, `1` = warnings, `2` = hard failures.

---

### `nimbus diag`

Capture a full diagnostic snapshot — index metrics, connector health, query latency percentiles, recent errors, system info. Safe to share with support.

```bash
nimbus diag
nimbus diag --json
```

**Output includes:** Gateway version, platform, uptime, active profile, SQLite size, item counts by service, FTS5 coverage, embedding coverage, p50/p95/p99 query latency, connector health summary, recent sync errors.

---

### `nimbus diag slow-queries`

List the slowest queries recorded in the latency ring buffer.

```bash
nimbus diag slow-queries
nimbus diag slow-queries --limit 20
nimbus diag slow-queries --since 1h
nimbus diag slow-queries --json
```

---

### `nimbus serve`

Start a read-only local HTTP API on `localhost`. Off by default. Useful for scripts, CI pipelines, and the `@nimbus-dev/client` library.

```bash
nimbus serve
nimbus serve --port 7474        # Default port: 7474
```

**Endpoints:**

| Endpoint | Description |
|---|---|
| `GET /v1/audit` | Recent audit log entries |
| `GET /v1/connectors` | List connectors and health states |
| `GET /v1/health` | Gateway health summary |
| `GET /v1/items` | List indexed items (supports `service`, `type`, `since`, `until`, `limit` query params) |
| `GET /v1/items/:id` | Get a single item by ID |
| `GET /v1/metrics/dora` | DORA metrics for a service (supports `service`, `since` query params) |
| `GET /v1/openapi.json` | Machine-readable OpenAPI 3.1 schema for this API |
| `GET /v1/people` | List people graph entries |
| `GET /v1/people/:id` | Get a single person record |
| `GET /v1/preflight/deploy` | Pre-deploy check: active P1 incidents, failing CI, merge conflicts |
| `POST /v1/deployments` | Record a deployment annotation (bearer-auth required via `http_api.deployment_token`) |

All read endpoints are `localhost`-only and use `SQLITE_OPEN_READONLY`. The `POST /v1/deployments` write surface requires bearer authentication and is rate-limited (60 req/min). There is no authentication required for read endpoints because the socket is owner-only at the OS level.

---

## Database

### `nimbus db verify`

Run non-destructive integrity checks on the local index. Safe to run at any time.

```bash
nimbus db verify
nimbus db verify --json
```

**Checks:** SQLite `integrity_check`, FTS5 consistency, `vec_items_384` rowid alignment, orphaned sync tokens, schema version match, foreign key integrity.

**Exit codes:** `0` = all pass, `1` = at least one finding.

---

### `nimbus db repair`

Run targeted recovery actions for any findings reported by `nimbus db verify`. Requires confirmation unless `--yes` is passed. Writes a structured repair report to the audit log.

```bash
nimbus db repair
nimbus db repair --yes          # Skip confirmation
nimbus db repair --json
```

**Repair actions:** Delete orphaned vec rows + re-queue resync, FTS5 rebuild, delete unrecoverable rows, remove orphaned sync tokens.

---

### `nimbus db snapshot`

Create a manual snapshot of the local index database.

```bash
nimbus db snapshot
nimbus db snapshot --label "before-migration"
```

Snapshots are stored under `<dataDir>/backups/`.

---

### `nimbus db restore <snapshot>`

Restore the index from a named snapshot. The Gateway must be stopped first.

```bash
nimbus stop
nimbus db restore 2026-04-15T10-30-00.snapshot
```

---

### `nimbus db snapshots list` / `nimbus db backups list`

List available snapshots and pre-migration backups.

```bash
nimbus db snapshots list
nimbus db backups list
```

---

### `nimbus db prune`

Remove old snapshots and backups beyond the configured retention window. Requires confirmation unless `--yes` is passed.

```bash
nimbus db prune
nimbus db prune --yes
```

---

## Index Maintenance

### `nimbus index reembed`

Selectively re-embed indexed items to a target embedding model. Useful when switching between local MiniLM (384-dim, `vec_items_384`) and OpenAI `text-embedding-3-small` (1536-dim, `vec_items_1536`) — both tables can coexist; this command backfills missing chunks for a chosen model.

```bash
nimbus index reembed --model openai:text-embedding-3-small --item-type slack:message --dry-run
nimbus index reembed --model openai:text-embedding-3-small --service slack --yes
nimbus index reembed --model Xenova/all-MiniLM-L6-v2 --yes --json
```

**Flags:**

| Flag | Required | Description |
|---|---|---|
| `--model <id>` | yes | Target embedding model id. v1 values: `openai:text-embedding-3-small` (needs vault key `openai.api_key`) or `Xenova/all-MiniLM-L6-v2` (local, no key required). |
| `--item-type <key>` | no | Filter to one logical type. Accepts `"service:type"` (exact) or `"type"` alone. |
| `--service <name>` | no | Restrict to a single connector service. |
| `--limit N` | no | Cap the number of items to process. |
| `--batch-size N` | no | Items per batch; default 100, clamped to `1..256`. |
| `--dry-run` | no | Compute the candidate count and emit a `reembedDone` notification without writing. |
| `--yes` | yes (non-dry) | Confirmation gate; required for any non-`--dry-run` invocation. |
| `--json` | no | Suppress progress output; print the final summary as one JSON object. |

**Behaviour:** the CLI subscribes to `index.reembedProgress` / `index.reembedDone` / `index.reembedError` notifications, issues the `index.reembed` request, and streams progress lines (`progress: 50/200 (skipped 0)`) by default. Re-running is idempotent — items already embedded against the target model are skipped, so retrying after a transient API failure is safe.

**Exit codes:** `0` = run completed (any number of skips); operator re-runs to retry skipped items. `1` = fatal abort (vault key missing, unknown model, auth failure, Gateway down).

**Security:** `index.reembed` and `index.reembedCancel` are CLI-only — both methods are in `FORBIDDEN_OVER_LAN` (invariant I5) and absent from the Tauri renderer allowlist (invariant I7).

---

## Telemetry

Telemetry is **opt-in** and **aggregate-only**. No content, query text, file names, or credentials are ever included. Disabled by default.

### `nimbus telemetry show`

Show the current telemetry configuration and a preview of the next payload.

```bash
nimbus telemetry show
```

**Payload preview includes:** `connector_error_rate`, `sync_duration_p50_ms`, `connector_health_transitions`, `extension_installs_by_id`, `cold_start_ms`, query latency percentiles. All values are aggregate counters — no content.

---

### `nimbus telemetry disable`

Disable telemetry and clear any queued payloads.

```bash
nimbus telemetry disable
```

To re-enable: `nimbus config set telemetry.enabled true`

---

## Extensions

### `nimbus extension install <path|url|package>`

Install a third-party extension. Accepts a local path, URL, or npm package name. The manifest SHA-256 is verified before installation.

```bash
nimbus extension install @community/nimbus-notion
nimbus extension install ./nimbus-my-connector
nimbus extension install https://example.com/nimbus-ext.tar.gz
```

---

### `nimbus extension list [--tree] [--json]`

List installed extensions with their status (enabled / disabled).

`--tree` — print an ASCII dependency forest of installed extensions with their forward-dep edges; cycle-safe; NO_COLOR-aware (T2 PR 4).

```bash
nimbus extension list
nimbus extension list --json
nimbus extension list --tree
```

---

### `nimbus extension info <id> [--deps] [--json]`

Show details for an installed extension. `--deps` appends a Dependencies section showing forward deps (extensions this one requires) and reverse deps (extensions that depend on this one) from the `extension_dependency` table (T2 PR 4).

```bash
nimbus extension info com.example.notion
nimbus extension info com.example.notion --deps
nimbus extension info com.example.notion --deps --json
```

---

### `nimbus extension enable <name>` / `disable <name>`

```bash
nimbus extension enable nimbus-notion
nimbus extension disable nimbus-notion
```

---

### `nimbus extension remove <name> [--yes] [--force] [--json]`

Uninstall an extension and remove its process. Does not delete the extension's Vault entries automatically — use `nimbus connector remove` first if the extension registered connectors.

If other installed extensions depend on this one, the remove is refused unless `--force` is passed. With `--force`, the removal proceeds after a warning listing the affected dependents; the startup completeness guard will hard-disable those dependents on the next Gateway start via `MissingDependencyRegistry` (T2 PR 4).

```bash
nimbus extension remove nimbus-notion
nimbus extension remove nimbus-notion --force
nimbus extension remove nimbus-notion --yes --json
```

---

### `nimbus extension update [<id>] [--check] [--to <version>] [--json]`

Apply a cached auto-update bump (T2 PR 3). Without an id, lists pending updates the daemon detected on its last poll; with `--check`, forces an immediate registry poll first. With an `<id>`, applies the cached bump for that extension after HITL consent (`extension.autoUpdate` for a forward bump, `extension.downgrade` for a backward one).

```bash
nimbus extension update --check                       # force poll + list
nimbus extension update                                # list cached only
nimbus extension update com.example.notion             # apply cached toVersion
nimbus extension update com.example.notion --to 1.0.0  # roll back to a cached _prev
nimbus extension update com.example.notion --json
```

Exit code is `0` on success, `1` on apply failure (with a stderr hint — e.g. `publisher_key_missing` directs the user to `nimbus extension sync`).

---

### `nimbus extension downgrade <id> --to <version> [--json]`

Roll an installed extension back to a cached `_prev/<version>/` (T2 PR 3). The `<version>` must already exist on disk under the extension's `_prev/` directory — typically the version the auto-update flow saved when the user accepted the previous bump.

```bash
nimbus extension downgrade com.example.notion --to 1.0.0
nimbus extension downgrade com.example.notion --to 1.0.0 --json
```

Fires the `extension.downgrade` HITL action type so the consent prompt clearly distinguishes the direction from a forward update.

---

### `nimbus extension keygen [--out <path>] [--force]`

Generate a new Ed25519 keypair for signing extension manifests. The private key is saved to `~/.nimbus/publisher-key` (or `<path>`) with `0600` permissions. The public key (base64) is printed to stdout. Use `--force` to overwrite an existing key.

```bash
nimbus extension keygen
nimbus extension keygen --out ./my-publisher-key
```

---

### `nimbus extension sign <ext-dir> [--key <path>]`

Sign an extension manifest (`nimbus.extension.json`) in the specified directory using the private key at `~/.nimbus/publisher-key` (or `<path>`). The `signature` field is injected directly into the manifest file.

```bash
nimbus extension sign ./nimbus-my-connector
nimbus extension sign ./nimbus-my-connector --key ./my-publisher-key
```

---

### `nimbus extension sync [--dry-run] [--json]`

Poll the registry to check the status of installed publishers. Detects key rotations and revoked publishers, then triggers a re-verification of all installed extensions for affected publishers.

```bash
nimbus extension sync
nimbus extension sync --dry-run
nimbus extension sync --json
```

---

### `nimbus scaffold extension`

Scaffold a new extension package from the `@nimbus-dev/sdk` template.

```bash
nimbus scaffold extension --name my-connector --output ./nimbus-my-connector
```

---

### `nimbus test`

Run contract tests for an extension against the `@nimbus-dev/sdk` manifest contract, followed by the extension's own `bun test` suite.

```bash
nimbus test                     # In extension root directory
nimbus test ./nimbus-my-connector
```

---

## Workflows

### `nimbus workflow save <path>`

Save a YAML script as a named reusable workflow pipeline.

```bash
nimbus workflow save ./weekly-cleanup.yml --name weekly-cleanup
```

---

### `nimbus workflow list`

List saved workflow pipelines.

```bash
nimbus workflow list
```

---

### `nimbus workflow run <name>`

Run a named workflow pipeline. Same engine as `nimbus run` — two-phase preview then execution; HITL gated.

```bash
nimbus workflow run weekly-cleanup
nimbus workflow run weekly-cleanup --no-ttv     # Preview only
```

---

### `nimbus workflow delete <name>`

Delete a saved workflow pipeline.

```bash
nimbus workflow delete weekly-cleanup
```

---

## Sessions

### `nimbus session list` / `clear` / `recall`

Inspect, clear, and recall content from RAG sessions. Each `nimbus ask` opens a session that accumulates context across turns; these subcommands operate on those sessions over the IPC `session.*` surface.

```bash
nimbus session list                                # All active sessions (JSON)
nimbus session clear                               # Clear every session
nimbus session clear <sessionId>                   # Clear one session
nimbus session recall <sessionId> <query>          # Top-K=8 recall from the session's chunks
```

Output is JSON in all forms.

---

## Watchers

### `nimbus watch list` / `pause <id>` / `resume <id>`

Inspect and toggle scheduling on watchers over the IPC `watcher.*` surface. Watcher creation and editing flow through the `nimbus workflow` family (watchers are workflow pipelines with a trigger).

```bash
nimbus watch list                # All watchers + enabled state + last-fired time
nimbus watch pause <watcher-id>  # Stop firing without deleting
nimbus watch resume <watcher-id> # Re-enable a paused watcher
```

Output is JSON in all forms.

---

## People

### `nimbus people`

Query the cross-service people graph. Resolves identities across GitHub, GitLab, Slack, Linear, Jira, Notion, and more without a network call.

```bash
nimbus people --query "elena"
nimbus people --email "elena@company.com"
nimbus people --github "elena-dev"
nimbus people --json
```

---

## Vault

### `nimbus vault list`

List Vault key names (never values). Keys are scoped per connector and per profile.

```bash
nimbus vault list
nimbus vault list --profile work
```

---

### `nimbus vault delete <key>`

Delete a specific Vault entry. Use `nimbus connector remove` for full connector cleanup.

```bash
nimbus vault delete github.pat
```

---

## Documentation

### `nimbus docs [topic]`

Open documentation for a topic in the terminal or browser.

```bash
nimbus docs
nimbus docs connectors
nimbus docs query
nimbus docs extensions
nimbus docs config
```

---

## Audit

### `nimbus audit`

Show the local audit log. Every action the agent takes — including every HITL decision — is recorded here before execution.

```bash
nimbus audit
nimbus audit --limit 100
nimbus audit --service github
nimbus audit --since 7d
nimbus audit --json
```

**Columns:** `timestamp`, `action`, `service`, `payload_summary`, `hitl_status` (`approved` / `rejected` / `not_required`), `result`.

---

### `nimbus audit verify`

Verify the BLAKE3 chain integrity of the audit log. Each row stores `row_hash = BLAKE3(prev_hash || canonical_row_bytes)`; this command walks the chain and reports the first break, if any.

```bash
nimbus audit verify              # Verify chain since the last successful checkpoint
nimbus audit verify --full       # Verify the entire chain from row 1
nimbus audit verify --since 1000 # Verify forward from a specific row id
```

**Exit codes:** `0` = chain intact, `1` = break detected (output names the first broken row id and the reason — e.g. `prev_hash mismatch`, `row_hash mismatch`, `missing predecessor`).

A break indicates either tampering or unsynchronized writes. A break is a hard finding — file an internal issue and capture a `nimbus audit export` snapshot before any other action.

---

### `nimbus audit export`

Export the full audit log as a JSON array. Suitable for backup, compliance handoff, or external SIEM ingestion.

```bash
nimbus audit export --output ./audit-2026-04-30.json
```

The exported payload includes `row_hash` and `prev_hash` for each row, so the chain can be re-verified offline. The output file is written with `Bun.write` and overwrites without prompting — pick a fresh path.

---

## Data Sovereignty

Nimbus stores all your indexed data and credentials locally. The `nimbus data` family lets you take a portable, encrypted backup of that state, restore it on another machine, or perform a service-scoped GDPR deletion. Bundles are protected by an Argon2id-derived key envelope; a 12-word BIP39 recovery seed is generated once and shown only at export time.

### `nimbus data export`

Create an encrypted, portable backup of the local index, the audit log, and (where supported) Vault credential references.

```bash
nimbus data export --output ./nimbus-2026-04-30.tar.gz --passphrase "long-strong-passphrase"
nimbus data export --output ./meta-only.tar.gz --passphrase "..." --no-index
```

**Required flags:**

| Flag | Description |
|---|---|
| `--output <path>` | Destination `.tar.gz`. Overwrites without prompting. |
| `--passphrase <pw>` | Argon2id-derived key. Choose a long passphrase — there is no recovery if you lose both this and the recovery seed. |

**Optional flags:**

| Flag | Description |
|---|---|
| `--no-index` | Skip the SQLite index; export only credential references and audit log. Smaller bundle, faster restore. |

On first export, the Gateway generates a 12-word BIP39 recovery seed and prints it once. **Store it offline.** Subsequent exports reuse the same seed (it is bound to the Gateway, not to a single bundle), so either the passphrase *or* the seed can decrypt any bundle from this Gateway.

---

### `nimbus data import <bundle>`

Restore a previously exported bundle. The Gateway must be stopped before running this command; the index is replaced atomically.

```bash
nimbus data import ./nimbus-2026-04-30.tar.gz --passphrase "..."
nimbus data import ./nimbus-2026-04-30.tar.gz --recovery-seed "word1 word2 ... word12"
```

Provide **either** `--passphrase` or `--recovery-seed`, not both. The output reports the count of credentials restored and a count of OAuth entries that may need re-authentication on the next sync (refresh tokens that were rotated upstream since the export).

**Version-compatibility note:** A bundle from a Gateway with a higher schema version cannot be imported into an older Gateway. Upgrade the target Gateway first.

---

### `nimbus data delete --service <name>`

Service-scoped GDPR deletion. Removes all index rows, embeddings, audit log entries, and Vault credentials associated with the named connector. Irreversible.

```bash
nimbus data delete --service slack --dry-run     # Preview only — no changes
nimbus data delete --service slack --yes         # Execute — required for non-interactive
```

**Flags:**

| Flag | Description |
|---|---|
| `--service <name>` | Connector to purge (`github`, `slack`, `google_drive`, …) |
| `--dry-run` | Print the preflight (item count, vault entry count) and exit |
| `--yes` | Required to execute the deletion (the CLI is non-interactive) |

The preflight is always printed — even with `--yes` — so the deletion blast radius is recorded in the audit log before the destructive write.

---

## Performance Benchmarking

### `nimbus bench`

Run the perf harness against one or all measurement surfaces. Surfaces are pre-defined synthetic workloads (intent classification, sync throughput, query latency, etc.) that produce comparable numbers across runs and machines.

```bash
nimbus bench --surface S2-a --runs 5 --reference     # Reference run — interactive protocol confirm
nimbus bench --surface S2-a --runs 5 --gha           # CI run — auto-tag with platform
nimbus bench --all --gha --corpus medium             # Every registered surface
```

**Required (one of):**

| Flag | Description |
|---|---|
| `--surface <id>` | A registered surface id. Shipped in v0.1.0: `S1`, `S2-a`/`-b`/`-c`, `S3`, `S4`, `S5`, `S6-drive`/`-gmail`/`-github`, `S7-a`/`-b`/`-c`, `S8-l<L>-b<B>` (12-cell embedding cross-product), `S9`, `S10`, `S11-a`/`-b`. See `packages/gateway/src/perf/surfaces/` and `SURFACE_REGISTRY` in `packages/gateway/src/perf/bench-cli.ts` for the canonical list. |
| `--all` | Run every registered surface back-to-back |

**Tagging (one of, required):**

| Flag | Description |
|---|---|
| `--reference` | Tag the run as `reference-m1air`. Interactive protocol confirmation is required by default — see [`docs/perf/reference-runner-setup.md`](./perf/reference-runner-setup.md) |
| `--protocol-confirmed` | Non-interactive equivalent for CI dispatch from `.github/workflows/_perf-reference.yml`. Do not pass this from a developer machine — the protocol gate exists to catch dirty environments before the number lands in `history.jsonl` |
| `--gha` | Tag as `gha-<os>` (auto-derived from `process.platform`) |

**Optional:**

| Flag | Description |
|---|---|
| `--corpus <tier>` | `small` *(default)* / `medium` / `large` — fixture size |
| `--runs <N>` | Per-surface invocations (default: 5) |
| `--history <path>` | `history.jsonl` override — defaults to `packages/gateway/src/perf/history.jsonl` |
| `--fixture-cache <p>` | Fixture cache directory override |

The harness writes a structured `HistoryLine` per surface/run to `history.jsonl`. Surface implementations live under `packages/gateway/src/perf/surfaces/`; the bench runner is `packages/gateway/src/perf/bench-runner.ts`. The surface table and SLO thresholds live in [`docs/perf/slo.md`](./perf/slo.md) + [`docs/perf/baseline.md`](./perf/baseline.md).

---

## Updates

### `nimbus update`

Check for or apply a Nimbus software update. Updates are downloaded, verified against an Ed25519 signature, and then handed off to the platform installer. No update is applied until the binary signature is confirmed.

```bash
nimbus update --check               # Print current vs. latest version; exit 1 if update available, 0 if current
nimbus update                       # Download, verify signature, prompt for confirmation, run installer
nimbus update --yes                 # Skip confirmation prompt (for scripted/unattended use)
```

**Options:**

| Flag | Description |
|---|---|
| `--check` | Check-only mode — no download, no install |
| `--yes` | Skip the "Apply update?" confirmation |

**Security:** The downloaded binary's SHA-256 hash is computed and verified against the Ed25519-signed manifest before any installer is invoked. A tampered binary is rejected and automatically rolled back.

**Headless note:** When the Gateway starts in headless mode (no Tauri connection detected) and an update is available, it prints a one-line hint to stdout: `"A new version of Nimbus is available (X.Y.Z). Run 'nimbus update' to install."`

**Environment overrides:** `NIMBUS_UPDATER_URL` overrides the manifest URL. `NIMBUS_UPDATER_DISABLE=true` disables all update checks.

---

## LAN Remote Access

Encrypted, relay-free remote access between machines on the same network. Disabled by default (`[lan] enabled = false` in `nimbus.toml`). Enable via `nimbus config set lan.enabled true`.

All traffic is E2E encrypted with NaCl box (X25519 DH + XSalsa20-Poly1305). `vault.*`, `updater.*`, `lan.*`, and `profile.*` methods are forbidden over LAN regardless of peer grants.

### `nimbus lan enable`

Start the LAN server. Without `--allow-pairing`, only already-paired peers can connect.

```bash
nimbus lan enable                   # Accept connections from paired peers only
nimbus lan enable --allow-pairing   # Also open a 5-minute pairing window; prints pairing code
```

---

### `nimbus lan disable`

Stop the LAN server and close all active peer connections.

```bash
nimbus lan disable
```

---

### `nimbus lan pair <host-ip> <pairing-code>`

Initiate a key exchange with a host that has an open pairing window. Stores the peer's X25519 public key in the local `lan_peers` table.

```bash
nimbus lan pair 192.168.1.42 Ab3Xy7QmPn1Wk8Zv    # 20-character base58 pairing code
```

---

### `nimbus lan status`

Show LAN server state, listen port, and number of paired peers.

```bash
nimbus lan status
nimbus lan status --json
```

---

### `nimbus lan list-peers`

List all paired peers with their ID, direction (`inbound` / `outbound`), and write-allowed status.

```bash
nimbus lan list-peers
nimbus lan list-peers --json
```

---

### `nimbus lan grant-write <peer-id>`

Allow a peer to call write and HITL-gated methods. Read-only by default after pairing.

```bash
nimbus lan grant-write abc123
```

---

### `nimbus lan revoke-write <peer-id>`

Remove a peer's write grant. They remain paired but are restricted to read-only methods.

```bash
nimbus lan revoke-write abc123
```

---

### `nimbus lan remove-peer <peer-id>`

Unpair a peer. Their stored public key is deleted; any active session is terminated.

```bash
nimbus lan remove-peer abc123
```

---

## Exit Codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | General error / warnings (e.g. `nimbus doctor` warnings, `nimbus db verify` findings) |
| `2` | Hard failure (e.g. `nimbus doctor` hard failures, Gateway unreachable) |

---

## Environment Variables

| Variable | Purpose |
|---|---|
| `NIMBUS_AGENT_MODEL` | Override `[llm].remote_model` — model id for the conversational agent (default: `claude-sonnet-4-6`). Bare ids work; provider is inferred from `claude-*` / `gpt-*` / `o1-*` / `o3-*` / `o4-*` prefix. |
| `NIMBUS_CLASSIFIER_MODEL` | Override `[llm].classifier_model` — Anthropic model used by the intent classifier (default: `claude-haiku-4-5-20251001`). |
| `NIMBUS_OPENAI_CLASSIFIER_MODEL` | OpenAI model used by the classifier when only `OPENAI_API_KEY` is set (default: `gpt-4o-mini`). |
| `NIMBUS_SYNC_INTERVAL_SECONDS` | Override `[sync].intervalSeconds` |
| `NIMBUS_TELEMETRY_ENABLED` | Override `[telemetry].enabled` |
| `NIMBUS_TELEMETRY_ENDPOINT` | Override `[telemetry].endpoint` |
| `NIMBUS_DATA_DIR` | Override the platform data directory |
| `NIMBUS_CONFIG_DIR` | Override the platform config directory |
| `NIMBUS_PROFILE` | Set the active profile at launch |
| `NIMBUS_EMBEDDING_MODEL_DIR` | Path to pre-downloaded MiniLM model weights (headless bundle) |
| `NIMBUS_EMBEDDINGS` | Set to `false` to disable background embedding generation after index upserts |
| `NIMBUS_ENGINE_CONTEXT_WINDOW_ITEMS` | Top-N index items passed in full to the agent after ranked search (1–200; default 10) |
| `NIMBUS_SEARCH_PRIORITY_JSON` | Per-service search priority weights (0–1) as a JSON object e.g. `{"github":0.8,"slack":0.7}` |
| `NIMBUS_ASK_MAX_STEPS` | Mastra tool-loop depth for `nimbus ask` sessions (1–64) |
| `NIMBUS_MAX_AGENT_DEPTH` | Maximum sub-agent recursion depth for multi-agent tasks (1–10; default 3) |
| `NIMBUS_MAX_TOOL_CALLS_PER_SESSION` | Hard cap on total tool calls per session (1–200; default 20) |
| `NIMBUS_RUN_QUERY_BENCH` | Set to `1` to enable strict `< 100ms` p95 assertion in the query latency benchmark |
| `NIMBUS_LOG_LEVEL` | `debug` / `info` / `warn` / `error` (default: `info`) |
| `NIMBUS_UPDATER_URL` | Override the update manifest URL (default: official endpoint) |
| `NIMBUS_UPDATER_DISABLE` | Set to `true` to disable all auto-update checks |
| `NIMBUS_LAN_PORT` | Override the LAN TCP listen port (default: `7475`) |
| `NIMBUS_DEV_UPDATER_PUBLIC_KEY` | Override the embedded Ed25519 updater public key — for tests only |

---

## Platform Notes

| Platform | IPC Socket | Config Dir | Data Dir |
|---|---|---|---|
| Windows 10+ | `\\.\pipe\nimbus-gateway` | `%APPDATA%\Nimbus` | `%LOCALAPPDATA%\Nimbus\data` |
| macOS 13+ | `~/Library/Application Support/Nimbus/gateway.sock` | `~/Library/Application Support/Nimbus` | `~/Library/Application Support/Nimbus/data` |
| Ubuntu 22.04+ | `~/.local/share/nimbus/gateway.sock` | `~/.config/nimbus` | `~/.local/share/nimbus` |

---

## See Also

- [`README.md`](./README.md) — Quick start and overview
- [`architecture.md`](./architecture.md) — Subsystem design and data flow
- [`roadmap.md`](./roadmap.md) — Phase acceptance criteria and sequencing
- [`SECURITY.md`](./SECURITY.md) — Security model and vulnerability reporting
- [`docs/contributors/extension-author-walkthrough.md`](./contributors/extension-author-walkthrough.md) — Writing a connector extension
