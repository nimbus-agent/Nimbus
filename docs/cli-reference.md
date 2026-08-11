# Nimbus CLI Reference

Complete reference for all `nimbus` commands. For installation see [`README.md`](./README.md). For architecture context see [`architecture.md`](./architecture.md).

**Three ways to use Nimbus interactively:**

- [`nimbus tui`](#nimbus-tui) — rich Ink terminal UI (5 panes, streaming result, inline mid-stream HITL, live connector + watcher + sub-task panes). Auto-falls back to the REPL on unsuitable terminals.
- [`nimbus repl`](#nimbus-repl) — line-based readline loop for scripts, SSH, CI, and other headless environments. `nimbus` with no arguments on an interactive shell is an alias.
- `nimbus <command>` — one-shot commands documented below (`ask`, `search`, `query`, `run`, `status`, `doctor`, `diag`, …).

---

## Global Flags

These flags are accepted by most commands, which silently ignore any dash-argument they do not define. Five surfaces are the exception and hard-reject an unrecognised flag: `nimbus search` (throws on any argument starting with `-`), `nimbus glossary`, `nimbus update` (which rejects anything other than `--check` / `--yes` / `-y`), `nimbus deploy annotate`, and `nimbus tribal capture`.

| Flag | Description |
|---|---|
| `--help`, `-h` | Print command help and exit |
| `--version`, `-v` | Print Nimbus version and exit |
| `NO_COLOR` (env var, not a flag) | Disable ANSI colour output. There is no `--no-color` flag. |
| `--json` | Machine-readable JSON output — **per-command**, not global. Only the commands whose Options table or examples list it change their output; anywhere else it is silently ignored (top level, `--json` only suppresses the interactive banner). |

### The `--json` contract

Every command that documents `--json` obeys the same four rules, so a script can rely on them without
reading the command's implementation:

1. **stdout is the document, and nothing else.** With `--json`, stdout carries exactly one JSON value
   (pretty-printed, 2-space indent) — no banner, no table, no empty-state hint, no progress line. `nimbus <cmd> --json | jq` always works.
2. **Diagnostics go to stderr.** Warnings, hints, and degradation notes are written to stderr, never
   mixed into the document.
3. **Exit codes are unchanged by `--json`.** A command that exits `1` on a finding (e.g. `nimbus db verify`) still does so. A command that *fails* prints its error to stderr, exits non-zero, and emits **no JSON at all** — check the exit code, not the presence of output. This covers failures raised before the command can build a document at all, including the one most likely to bite a monitoring script: `nimbus status --json` against a **stale state file** whose socket has no listener. Connecting to the socket throws (`connect ENOENT` / `ECONNREFUSED`) before any JSON exists, so stdout stays empty and the process exits `1` — exactly as `nimbus status` without `--json` does. Do not expect a `running: false` document there.
4. **The shape is the gateway's own payload, unwrapped.** There is no `{ ok, data }` envelope: list commands emit a JSON array, single-result commands a JSON object, with the gateway's own field names. Pre-rendered human strings (the `formatted` blob some gateway methods return) are dropped rather than embedded.

---

## Getting Started

### `nimbus init`

Index the git repository in the current directory. Needs no credentials, no API key, and no LLM.

```bash
cd ~/code/your-project
nimbus init
nimbus init --no-sync           # Write the config only; do not start or sync
nimbus init --help              # Usage and the exit-code table
```

What it does:

1. Verifies the current directory is a git repository (exits 1 if not, writing nothing).
2. **Appends** a `[[filesystem.roots]]` block for it to `nimbus.toml` with `git_aware = true` and `code_index = true`. Appending — never rewriting — is deliberate: it cannot reorder keys, strip comments, or reformat anything you wrote. An existing file is copied to `nimbus.toml.bak` first.
3. Starts the Gateway if it is not already running, then syncs the `filesystem` connector.
4. Prints a real `file:line` from your own repository to try with [`nimbus why`](#nimbus-why).

Re-running is safe and idempotent — a root that is already configured reports `Already configured` and is not duplicated.

Exit codes:

| Code | Meaning |
| --- | --- |
| `0` | The repository was indexed. A concrete `nimbus why` target may or may not have been found — if the index had nothing to suggest yet, `init` says so and prints the generic next step. |
| `1` | The current directory is not a git repository. Nothing was written. |
| `2` | The Gateway never became ready, so **nothing was indexed**. The failure names what happened, inlines the tail of the gateway log, and tells you what to run next. |
| `3` | The Gateway is reachable but this repository was still not indexed — the `filesystem` sync failed, or a Gateway that is already running has to be restarted before it can see the new root. |

Two behaviours worth knowing:

- **If a Gateway is already running**, it cannot see a root that was just added: filesystem roots are read once at startup. `nimbus init` says so and asks you to `nimbus stop && nimbus start` rather than syncing nothing or restarting your daemon for you (exit `3`).
- **The config edit is the durable half of the work** and survives every failure above — a second `nimbus init` after fixing the Gateway will not duplicate it. What does *not* survive is the pretence that the command succeeded: a run that indexed nothing exits non-zero and never prints a next step it cannot back up.

`NIMBUS_CONFIG_DIR` overrides the config directory this command writes to (the Gateway honours the same variable). It moves the config directory only — never the data directory.

`NIMBUS_GATEWAY_SOCKET` overrides the IPC socket/pipe path and is honoured by **both** the CLI and the Gateway. It is deliberately a separate variable from `NIMBUS_CONFIG_DIR`: one variable moving both would let a test-isolation mistake silently reroute live IPC. Note it does **not** move the data directory either, so a Gateway started with it still reads and writes the real index.

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
nimbus status --json            # One JSON object; `--verbose` / `--drift` add keys to it
nimbus status --json | jq -r '.version'
```

`nimbus status` reads exactly three flags — `--verbose`, `--drift`, and `--json`. Any other dash-argument is silently ignored.

**Output includes:** Gateway PID, uptime, active profile, total indexed items, agent limits (`depth=N  tool-calls/session=N`), connector list with health state (`healthy` / `degraded` / `error` / `rate_limited` / `unauthenticated` / `paused`).

**`--json` shape.** One object; **every key is always present**, using `null` for absent data, so `jq` never has to guard for existence:

| Key | Type | Notes |
|---|---|---|
| `running` | boolean | `true` only when the state file exists **and** `gateway.ping` answered |
| `pid` / `socketPath` / `logPath` | number / string / string, or `null` | Read from the gateway state file |
| `version` | string \| null | Gateway version |
| `uptimeMs` | number \| null | Milliseconds, not the rounded seconds the human view prints |
| `agentLimits` | object \| null | `{ maxAgentDepth, maxToolCallsPerSession }` |
| `embeddingBackfill` | object \| null | `{ done, total }` |
| `drift` | object \| null | `{ lines: string[] }` — populated only with `--drift` |
| `index` / `connectorHealth` | object / array, or `null` | The `diag.snapshot` payload — populated only with `--verbose` |
| `error` | string \| null | Set when the socket **connected** but `gateway.ping` then failed — the JSON form of the human "state exists but IPC failed" line; `running` is `false`. A socket that cannot be connected to at all does not reach this field (see below) |

Two "not running" cases, and they do **not** behave alike:

- **No state file.** `running: false`, `error: null`, every other key `null`, exit `0`. Not an error.
- **A stale state file whose socket has no listener.** The connect throws before the document can be
  built, so **no JSON is emitted at all**: the connect error (`connect ENOENT` on a Windows named pipe,
  `ECONNREFUSED` on a Unix socket) goes to stderr and the process exits `1`. This is `--json` obeying
  rule 3 of the contract above, and it matches what plain `nimbus status` does with the same stale
  file. `error` is populated only in the narrower case where the connection succeeded and the
  subsequent `gateway.ping` failed — a gateway that is listening but wedged, or one that dies
  mid-call. A script that must distinguish "gone" from "never started" should check the exit code
  first and only parse stdout on `0`.

---

## Querying and Asking

### `nimbus ask`

Ask the agent a natural-language question or give it a task. The agent answers from the local index; it only calls live APIs when freshness is required. Any destructive or outgoing action requires HITL consent before it executes.

If `[llm].prefer_local = true` and a local provider is available, `nimbus ask` routes open-ended conversational answers through the local model. With Ollama, set `[llm].local_model` to any pulled model name; if no remote classifier API key is configured, Nimbus falls back to local indexed-context answering instead of failing before the local model can run.

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

Fast structured search over the local index. Answers always come from the SQLite metadata index — no cloud call is ever made. The query is positional; results are printed as JSON.

```bash
nimbus search "quarterly review documents"
nimbus search "payment-service incident" --service slack --limit 50
nimbus search "design doc" --service google_drive --type pdf
nimbus search "flaky test" --keyword-only            # BM25 only, no vector ranking
```

**Options:**

| Flag | Description |
|---|---|
| `--service <name>`, `-s` | Filter by connector (e.g. `github`, `google_drive`, `slack`) |
| `--type <type>`, `-t` | Item type (`pr`, `issue`, `file`, `email`, `message`, `ci_run`, `web_clip`, …). `pipeline_run` is a `graph_entity` type, not an item type — it matches nothing here. |
| `--semantic` | *(default)* Vector/semantic ranking — already on, so passing this changes nothing |
| `--no-semantic`, `--keyword-only` | Turn semantic ranking off; keyword (BM25) results only |
| `--limit <n>`, `-n` | Maximum results (1–500, default: 20) |

> **No other flags are accepted.** `nimbus search` throws `Unknown flag: <arg>` on any argument starting with `-` that is not in the table above — including `--help`, `--json`, `--since` and `--state`. (It is not alone: `nimbus glossary`, `nimbus update`, `nimbus deploy annotate` and `nimbus tribal capture` reject unknown flags too. Most other commands ignore them.) Time, state and assignee filtering are not available here; use [`nimbus query`](#nimbus-query) for `--since`, or raw SQL via `nimbus query --sql`.
>
> If the embedding model is still warming up, a semantic search falls back to keyword-only for that call and prints a note on stderr.

---

### `nimbus query`

Structured index query with explicit filters or raw SQL. Intended for scripting and CI pipelines.

```bash
nimbus query --service github --type pr --since 7d
nimbus query --service linear --type issue --since 14d --json
nimbus query --sql "SELECT title, url FROM item WHERE pinned = 1" --pretty
nimbus query --service pagerduty --type alert --since 1d --json | jq '.[] | .title'
```

**Options:**

| Flag | Description |
|---|---|
| `--service <name>` | Filter by connector |
| `--type <type>` | Item type |
| `--since <duration>` | Lower time bound (`7d`, `24h`, `30m`, `2w`, …) |
| `--sql <query>` | Raw read-only SQL (SELECT only; DML is blocked) |
| `--pretty` | Pretty-print table output |
| `--json` | JSON array output |
| `--limit <n>` | Max rows (default: 50, capped at 1000) |

`--service` is required unless `--sql` is used.

> **Unknown flags are ignored, not rejected.** `nimbus query` scans for the flags above and ignores anything else it finds, so a typo or an invented filter fails silently rather than erroring. (`nimbus search` behaves the opposite way — it throws on any flag it does not define.)
>
> **Security note:** `--sql` is guarded — only `SELECT` statements are allowed. Any `INSERT`, `UPDATE`, `DELETE`, or DDL is rejected before execution.

---

### `nimbus run`

Execute a YAML script file as a single agent session. All steps use the same engine as `nimbus ask`. A plain `nimbus run` executes straight away — there is no preview step and no "proceed?" confirmation; HITL gates fire inline as each step reaches them. A preview is opt-in via `--dry-run` or `--no-ttv`.

```bash
nimbus run ./weekly-cleanup.yml
nimbus run ./deploy.yml --dry-run         # Preview only — no step executes
nimbus run ./deploy.yml --no-ttv          # Preview first, abort if any step is flagged HITL; otherwise run
```

`--no-ttv` is the unattended-safety flag, not a dry run: the CLI asks for a dry-run preview, and if any step's `hitlActions` is non-empty it throws `Workflow steps may require human approval (HITL). …` and nothing executes. If nothing is flagged, the workflow runs for real. `--agent nimbus|devops|research` selects the agent profile.

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

### `nimbus why`

Answer "why is this line/file the way it is?" — six parallel lanes over the local relationship graph: authorship (who last touched the line and when), pull request (the PR that merged it), ticket (the issue it resolves), discussion (Slack/Teams messages mentioning the commit, PR, or ticket), driver/what-drove-it (a temporally correlated incident within a 48h window — never a causal claim), and downstream (reverse `depends_on` edges from the file's indexed symbols). `<ref>` is a `path[:line]` (e.g. `src/billing/retry.ts:42`) or a bare symbol name resolved against indexed code symbols; `--line` overrides a line number embedded in `<ref>`. A lane with nothing to show degrades to a gap note naming the missing connector or graph relation rather than going silent.

```bash
nimbus why src/billing/retry.ts:42
nimbus why retryPayment --peek
nimbus why src/billing/retry.ts --line 42 --json
```

**Options:**

| Flag | Description |
|---|---|
| `--line <n>` | Line number, overriding any `:line` suffix on `<ref>` |
| `--peek` | Sub-300ms one-liner via `agents.whyPeek` instead of the full six-lane brief: author · short SHA · date · commit subject · PR # · ticket key |
| `--json` | Machine-readable JSON output (otherwise Markdown / a one-line string for `--peek`) |

**Output (Markdown):** one section per lane with its findings, plus gap notes for any lane that couldn't answer confidently (e.g. "no blame available for this line", "PRs emit `merged_as` when github-sync records a merge commit SHA — sync the connector for this repo"). The downstream lane currently degrades to a gap note on most real indexes — the graph populator emits `depends_on` at workspace→package granularity today; symbol-level edges are a populator follow-up. `--peek --json` returns the full `agents.whyPeek` payload (subject, author, commit, PR, ticket) rather than the one-line summary string, including `hasMore: true` whenever the full six-lane agent would surface findings beyond what author/PR/ticket already cover (a mentioning message, a `depends_on` edge, or a `correlates_with` deployment).

**Read-only:** never triggers HITL, never makes a live connector API call — answered from the local index and relationship graph, with one exception: an unblamed line triggers a single, cached, root-fenced local `git blame` subprocess (via `ensureBlameLine`), scoped to a configured `[[filesystem.roots]]` repo, bounded by a 20s timeout, and cached forever after in `git_blame_line`. This is a local git read, not a connector dispatch.

---

### `nimbus glossary`

Turn terminology the team already uses — but has never written down — into a queryable glossary, extracted entirely from the local index. `nimbus glossary` with no argument prints terms sorted by frequency; `nimbus glossary <term>` prints the team's consolidated definition, resolved against an exact term match, then a known synonym, then (on a miss) a "did you mean" list of near-misses. Candidates are mined deterministically from indexed titles/bodies (5 surface-form families — acronyms, backticked tokens, PascalCase identifiers, hyphenated compounds, capitalized phrases) and require evidence across at least `min_doc_freq` (default 3) source items before a term is considered; a local LLM then consolidates or vetoes each candidate.

Extraction normally runs as a background pass, debounced after a successful connector sync (`[glossary]` in `nimbus.toml`, default on); `nimbus glossary` with no mutating flag only reads the already-materialized `glossary_term` table. `--refresh` and `--rebuild` drive an on-demand pass instead of waiting for the next sync.

```bash
nimbus glossary
nimbus glossary CDR
nimbus glossary --limit 50 --json
nimbus glossary --refresh
nimbus glossary --rebuild
nimbus glossary --rebuild --yes
```

**Options:**

| Flag | Description |
|---|---|
| `--limit <n>` | Cap the number of terms/entries returned |
| `--json` | Machine-readable JSON output (otherwise Markdown) |
| `--refresh` | Run an on-demand incremental pass now, then print the (possibly updated) brief. Fails with `ERR_GLOSSARY_PASS_RUNNING` if a pass is already in flight. |
| `--rebuild` | Truncate every consolidated/pending glossary term and re-derive. Without `--yes`, prints a count of what would be deleted plus a sample of the highest-scoring terms and exits without touching anything. **One `--rebuild` runs exactly one bounded pass** (`SCAN_BATCH_LIMIT` items scanned, `max_new_terms_per_pass` terms consolidated — 25 by default) — it does not re-derive the whole glossary in one shot; the rest comes back incrementally over subsequent connector syncs or further `--refresh`/`--rebuild` runs. |
| `--yes` | Required alongside `--rebuild` to actually run the destructive rebuild. |

`--refresh` and `--rebuild` are mutually exclusive. A pass can take several minutes (up to `max_new_terms_per_pass * consolidate_timeout_ms`, ~12.5 minutes at defaults); on a TTY, progress prints in place as `consolidating <done>/<total>` and is suppressed for piped/redirected output. On completion, up to three summary lines are written to **stderr** (never stdout, so `--json`'s stdout stays JSON-only): a base line reporting new/upgraded term counts, a warning if a local LLM was configured but never answered and terms were deferred to retry (Ollama not running), and a line naming (up to 10, with a count of any remainder) any previously snippet-defined term vetoed during an upgrade.

**Output (Markdown):** with no argument, a frequency-sorted term list with coverage stats (how many terms are consolidated vs. still pending). With `<term>`, the consolidated definition, first-seen / last-seen dates, up to 5 top sources, and known synonyms/near-misses; gap notes explain an empty or partially-built glossary (no pass has run yet, every candidate fell below the frequency floor, consolidation is still in progress) rather than looking broken.

**Definition provenance.** A definition's `definitionSource` is `"llm"` (the local model consolidated it from source snippets), `"snippet"` (no LLM was available at consolidation time, so the verbatim sentence containing the term was used instead — honest and attributable, but not synthesized), or `"manual"` (a human authored it directly in `nimbus.toml` — see **Authoring and correcting terms manually** below). The background pass consolidates through a local model whenever `[glossary].use_llm` is true (the default) and one is available (Ollama or llama.cpp); with neither running, or `use_llm = false`, it produces snippet-sourced definitions instead. A snippet-sourced definition is not permanent: a later pass automatically re-consolidates it once a local LLM becomes available, using a reserved share of that pass's budget so a large backlog of new terms cannot starve upgrades indefinitely. A manual definition never auto-consolidates — it changes only when you edit `nimbus.toml`.

**Enabling the LLM can remove terms you've already seen.** Snippet mode has no veto path, so a glossary built without a model can accumulate terms nothing has ever judged. The upgrade path above puts those same terms in front of a real model for the first time, and a term the model vetoes is removed from the glossary (it survives internally as `vetoed`, and returns only if a later `--rebuild` re-derives it). `--refresh` names up to 10 terms vetoed this way in its stderr summary — plus a count of any remainder beyond that (`VETOED_TERMS_REPORTED`), so the total is never silently dropped — but a user who only reads the terminal output between runs, or consumes the glossary via search/`nimbus ask`, will not see that line unless they run `--refresh` themselves.

**Authoring and correcting terms manually.** A term does not have to come from mining. Add entries under two flat blocks in `nimbus.toml`:

```toml
[glossary.terms]
CDR = "Change Data Record — the durable event our pipeline emits on every row mutation."
"node.js" = "Our shorthand for the Node runtime services, as opposed to the Python worker fleet."

[glossary.synonyms]
"Change Data Record" = "CDR"
```

**Entries must sit under exactly these two headers — `[glossary.terms]` and `[glossary.synonyms]`.** This is a deliberately dependency-free line-based TOML parser, not a general-purpose one: a dotted key written directly under `[glossary]` (`[glossary]` with `terms.CDR = "…"` on its own line) is valid TOML, but this parser does not read it. That entry is now reported by name as a skipped/rejected entry in `--refresh`'s stderr summary (`packages/gateway/src/config/nimbus-toml-glossary-terms.ts`) rather than silently dropped — but the fix is to move it under `[glossary.terms]`, not to rely on the warning appearing. **A definition must be a single line — `"""` triple-quoted block strings are not supported** and are also reported as a skipped entry rather than silently dropped; write the definition as one quoted line, however long.

An authored entry is upserted straight to a consolidated, `definitionSource: "manual"` term the moment the config is next read — no LLM call, no pending queue, no `min_doc_freq` evidence requirement. On a key collision with a mined term, the authored definition **wins** unconditionally, and it sorts ahead of every mined term in `nimbus glossary`'s list output and near-miss suggestions regardless of score. `[glossary.synonyms]` aliases resolve only to an authored term — pointing one at a mined term is rejected and reported the same way as a misplaced entry.

**The edit-then-`--refresh` loop:** config is re-read at the start of every pass (not cached from gateway startup), so editing `nimbus.toml` and running `nimbus glossary --refresh` applies the change immediately — no gateway restart needed. To remove an override, delete its line from `[glossary.terms]` and run `--refresh` again: the row is **demoted, not deleted**, back to `status='pending'`. A term with real mined evidence (`doc_freq >= min_doc_freq`) then re-enters the ordinary consolidation queue and comes back with a mined definition over subsequent passes (subject to the same per-pass cap as any other pending term, not necessarily the very next one), while a pure invention with no mined evidence sinks below the floor and disappears from the glossary for good.

A manual row is exempt from being demoted or vetoed by the reconciliation sweep — a human assertion outranks a doc-frequency floor — but **not** exempt from having its statistics (`doc_freq`, `top_sources`) refreshed by that same sweep, so an authored term's cited sources still self-heal as the underlying threads are edited or deleted.

**Term-key normalization is not exact-string round-tripping.** The key you write (`CDR`, `node.js`) is normalized the same way a mined surface form is — casefolded, de-pluralized, backticks stripped — before it becomes the term's lookup key, and `depluralize()` still strips a trailing plural `s` outside of dotted identifiers: `"https"` normalizes to `"http"` and `"kubernetes"` to `"kubernete"`. That is a pre-existing, deliberate limitation of the shared normalizer (an acronym allowlist would be needed to fix it, and a general "consonant + s" rule was measured to break the normalizer's own headline case, `"SLOs"` → `"slo"`) — only dotted identifiers like `node.js` are exempted from it, not every acronym. What a user actually **sees**, though, is unaffected: `display_term` always preserves the exact key you wrote in `nimbus.toml`, so `nimbus glossary` prints `"node.js"` and `"CDR"` verbatim regardless of what the internal term key normalizes to.

**Read-only:** never triggers HITL, never makes a live API call — the extraction pass calls only the local LLM (when configured), and the `nimbus glossary` read path is pure SQLite. Zero `egress_ledger` rows.

**Exit codes:** `1` = gateway not running; `2` = agent error (timeout or a malformed `agents.glossary` response). An unknown term is not an error — it returns a "did you mean" brief of near-misses.

---

### `nimbus decisions`

The third member of the implicit-knowledge triad (after `nimbus why` and `nimbus glossary`): recovers decisions buried in Slack/Discord/Teams messages, Notion/Confluence/Obsidian pages, and Linear/Jira/GitHub/GitLab issues — statements of the form "we decided X because Y, alternatives were Z" — and corroborates each one against downstream PRs, commits and ADRs already in the local relationship graph. `nimbus decisions` prints a chronological, confidence-scored list read straight from the already-materialized `decision_record` table; it never calls a model on the read path.

Extraction normally runs as a background pass, debounced after a successful connector sync (`[decisions]` in `nimbus.toml`, default on). `--refresh` and `--rebuild` drive an on-demand pass instead of waiting for the next sync.

```bash
nimbus decisions
nimbus decisions --since 30d --service billing
nimbus decisions --explain --min-confidence 0.5
nimbus decisions --refresh
nimbus decisions --rebuild --yes
nimbus decisions --json
```

**Options:**

| Flag | Description |
|---|---|
| `--since <duration>` | Only decisions decided on/after `now - <duration>` (`ms\|s\|m\|h\|d\|w`, e.g. `90d`, `2w`). Defaults to `90d`. |
| `--service <name>` | Filter to decisions matched by either of two routes: the repository a corroborating PR/commit touches, or the source ticket's project key (Jira/Linear). Matching is on normalized tokens, not substrings — `--service bill` does not match `billing`. `--explain` labels which route fired; the brief reports how many decisions matched neither. |
| `--min-confidence <0..1>` | Drop any decision scoring below this. When omitted, the floor is `[decisions].min_confidence` (default `0.3`); an explicit value always wins, including `--min-confidence 0` for no floor at all. |
| `--explain` | Print the four confidence terms (`cue_strength`, `corroboration`, `source_authority`, `completeness`) and the matched cue text for every decision. |
| `--json` | Machine-readable JSON output (otherwise Markdown) |
| `--refresh` | Run an on-demand pass now, then print the (possibly updated) brief. Fails with `ERR_DECISIONS_PASS_RUNNING` if a pass is already in flight. |
| `--rebuild` | Clear the decision store — **including every `vetoed` row** — reset the watermark, and re-mine from scratch. Without `--yes`, prints a warning and exits without touching anything: a veto is a judgement already spent, and a rebuild re-asks the model about every previously rejected candidate. |
| `--yes` | Required alongside `--rebuild` to actually run the destructive rebuild. |

`--refresh` and `--rebuild` cannot be combined. A pass can take several minutes (bounded by `max_llm_calls_per_pass` sequential local-model calls); on completion, a one-line summary is written to **stderr** (never stdout, so `--json`'s stdout stays JSON-only): counts of extracted/upgraded/no-model rows. If discovery stopped on its internal batch bound with source items still unscanned, that same line says so explicitly and re-running resumes from where it stopped — a pass never silently reports success over a partial scan. Unlike `nimbus glossary`, a decisions pass reports no mid-pass progress — there is no `decisions.passProgress` notification.

**If `--refresh` or `--rebuild` keeps failing with `ERR_DECISIONS_PASS_RUNNING`, restart the gateway (`nimbus stop && nimbus start`).** A pass has no timeout and no cancellation: it awaits the local model one candidate at a time, and neither shutdown nor a later request can interrupt a call already in flight. A model that hangs therefore leaves the pass marked as running for the life of the gateway process, and every subsequent on-demand pass is refused. A restart clears it, and no work is lost — extraction resumes from the persisted watermark. Bounding the model call properly requires an abort signal the LLM layer does not yet carry (the same limit `nimbus glossary` has); it is deferred rather than papered over, and the code says so at `packages/gateway/src/decisions/decision-llm-adapter.ts`.

**Output (Markdown):** a chronological list, each entry showing the confidence score, decided-at date, statement, rationale, alternatives, evidence (source item plus any corroborating PR/commit/ADR), and a `⚠ no ADR found` marker when `has_adr` is false. Gap notes explain an empty or partially-built list (no pass has run yet, candidates are still awaiting extraction, decisions matched neither service route) rather than looking broken.

**Two honest limits, stated in every brief — not optional polish:**

- **Body cap.** This pass reads `item.body` directly (`decision-extract.ts` `scanDelta`), so prose-heavy item types (e.g. `confluence:page`, `notion:page`) are visible up to their 16 KiB cap, not the old flat 512 characters — a decision stated deep in a long Confluence/Notion page is no longer structurally invisible the way it once was. Everything else is still capped at 512, since only prose-heavy types get the wider `item.body` cap. (The embedding pipeline is a separate surface: it deliberately still reads the 512-character `body_preview`, unchanged and intentional, so semantic search recall over long documents is unaffected by this.) Recall is capped, not complete.
- **Confidence ceiling is 0.86, not 1.0.** The corroboration term of the confidence formula reserves its top score (1.0) for `migration`/`iac` evidence — properties of a corroborating change's file paths — but no connector today indexes changed-file paths, so that tier is specified in the schema and never actually reached. The real ceiling with only PR/commit corroboration available is `0.6`, which caps total confidence at `0.86`. The brief does not present a full-marks scale you cannot reach.

**Definition provenance.** A decision's `extractionSource` is `"llm"` (a local model structured it into statement/rationale/alternatives) or `"snippet"` (no local model was available at extraction time, so the matched sentence itself became the statement, with no rationale or alternatives). A snippet-sourced row is not permanent: a later pass automatically upgrades it once a local LLM is available, using a reserved share of that pass's budget so a large backlog of new candidates cannot starve upgrades indefinitely.

**Configuration — `[decisions]` in `nimbus.toml`:**

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Run the background extraction pass at all. Extraction opens no network surface — it reads the local index and writes local rows — so, like `[glossary]` and unlike `[briefs]`, it defaults on. |
| `use_llm` | `true` | Extract via a local model (Ollama or llama.cpp). `false` keeps the cheap deterministic cue-mining pass but forces every candidate into snippet mode, sparing a laptop the sequential local-model calls. |
| `min_confidence` | `0.3` | The `nimbus decisions` read-path floor when `--min-confidence` is omitted: decisions scoring below it are not listed. An explicit `--min-confidence` overrides it (pass `0` to see everything). Re-read per command, so an edit applies without restarting the gateway. Extraction itself is unfiltered — every candidate is stored with its score, so raising or lowering this changes what you see without re-running a pass. |
| `max_llm_calls_per_pass` | `25` | LLM calls per pass (sequential), split between new pending candidates and snippet-row upgrades. |
| `debounce_ms` | `30000` | How long a burst of connector syncs coalesces before triggering one pass. |
| `retry_cooldown_ms` | `60000` | Cooldown before a failed (unparseable) extraction is retried, preventing a permanently-unparseable high-priority candidate from starving lower-priority ones. |

**Read-only:** never triggers HITL, never makes a live connector API call, never calls `connectors.dispatch` — the extraction pass calls only the local LLM (when configured and available), and the `nimbus decisions` read path is pure SQLite. Zero `egress_ledger` rows.

**Exit codes:** `1` = gateway not running; `2` = agent error (timeout or a malformed `agents.decisions` response).

---

### `nimbus owners`

The read surface over the git-blame-derived ownership graph (schema **V51**): ranks who wrote a file or directory's lines, recency-weighted, and rolls a repository root up to the `[ci.service.<id>]` it is bound to. With no argument it prints a coverage summary (last-pass timestamp, roots/files covered, services bound).

**This is authorship-derived ownership, not accountability.** It answers "who wrote this," from `git blame`, not "who is responsible for approving a change to it." There is no CODEOWNERS file, no code-review data, and no on-call rotation anywhere in the local index, so the ranking is a starting point for who to ask — never an approval list. Every brief says so explicitly via an unconditional gap note.

```text
Usage: nimbus owners [<path>] [--service <name>] [--json] [--refresh]
  <path>       a file or directory inside a configured git-aware root
  --service    a [ci.service.<id>] service id
  (no args)    ownership coverage summary
```

```bash
nimbus owners
nimbus owners src/billing/retry.ts
nimbus owners src/billing
nimbus owners --service billing
nimbus owners --refresh
nimbus owners --json
```

**Options:**

| Flag | Description |
|---|---|
| `<path>` | A file or directory inside a configured git-aware root (either a `[[filesystem.roots]]` block or a `nimbus index add` registration). Resolves to the nearest graph entity; a path with no owners still routes to its parent directory so a one-committer file isn't a dead end. Mutually exclusive with `--service`. |
| `--service <name>` | Look up the owners of a bound `[ci.service.<id>]` service directly, instead of a path. Mutually exclusive with `<path>`. |
| `--json` | Machine-readable JSON output (otherwise Markdown). |
| `--refresh` | Run an on-demand derivation pass now (`ownership.refresh`), then print the (possibly updated) brief. Fails if a pass is already running. |

Like `nimbus glossary`, `nimbus owners` **hard-rejects** an unrecognised flag rather than ignoring it — a typo'd `--srevice` would otherwise silently fall through to a whole-repo coverage summary that looks like a successful answer to a different question. `<path>` and `--service` together are also rejected, not silently resolved by picking one.

**Output (Markdown):** the requested target's ranked owners (each with a recency-weighted share and a resolved-person-or-git-email label), the parent directory's owners as a fallback lane, the service the containing root rolls up to (if any), and the coverage summary. Gap notes explain a `0`-coverage result (no git-aware roots configured, the pass hasn't run yet, the path is outside every configured root, `[ownership].ignore_globs` excluded it) rather than looking broken, plus the standing authorship-vs-accountability disclaimer described above.

**Configuration — `[ownership]` in `nimbus.toml`:**

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Run the background derivation pass at all. Like `[glossary]` and `[decisions]`, this opens no network surface — it reads the local `git_blame_line` index and writes local graph edges — so it defaults on. |
| `half_life_days` | `365` | Recency half-life for blame-line weighting: a line blamed today counts more than one blamed a half-life ago. |
| `min_share` | `0.05` | An owner below this recency-weighted share of a path is dropped from the emitted set (but still counted toward the true total). |
| `max_owners_per_path` | `10` | Cap on owners emitted per path; the true count above the floor is kept on the entity's metadata and reported as a truncation fact. |
| `ignore_globs` | a default list of lock files, `vendor/`, `node_modules/`, `dist/`, `build/`, minified/generated/snapshot files | Root-relative globs excluded from aggregation. `git log --name-only` consults no exclude list on its own, so an unfiltered lock file would otherwise hand a directory to whoever last ran the installer. An explicit `[]` disables filtering entirely. |
| `debounce_ms` | `30000` | How long a burst of connector syncs coalesces before triggering one pass. |

**Read-only (normal lookup):** never triggers HITL, never makes a live connector API call, never calls `connectors.dispatch` — a plain `nimbus owners` reads only the already-indexed `git_blame_line` table and calls no model. Zero `egress_ledger` rows. `--refresh` is different: it invokes `ownership.refresh`, which clears and re-derives every ownership edge — local write-class maintenance, not a live connector call, but not read-only either.

**Exit codes:** `1` = gateway not running; `2` = agent error (timeout or a malformed `agents.ownership` response).

---

### `nimbus pre-mortem`

The thirteenth built-in agent: a risk brief for a Jira epic, built from comparable past epics already in the local index. Four sequential lanes — resolve the epic to its affected services, build an IDF-weighted service-overlap cohort of closed epics touching those services, compute five structural risks over that cohort (cycle-time overrun, size overrun, review drag, incident coupling, abandonment), and read recurring blocker themes mined by the background pass (schema **V53**). It then proposes — but never arms — one paused `incident_opened` watcher per affected service that resolves to a configured deployment-service id.

**Jira-only, and narrower still within Jira:** `--service` overrides aside, affected-service derivation walks `parent_key`-linked children, which `jira-sync.ts` only populates for **team-managed** projects — a company-managed epic resolves to zero derived services. No Linear epic is ever recognized: no `linear:project` items are indexed at all, so a `linear:...` reference is reported as an unsupported-tracker gap, not silently ignored.

```text
Usage: nimbus pre-mortem <epic-ref> [--service <name>]... [--json] [--refresh] [--repropose]
  <epic-ref>   a Jira epic key, e.g. PROJ-120 or jira:PROJ-120
  --service    repeatable; overrides the derived affected-service set
  --refresh    run the pre-mortem theme pass before building the brief
  --repropose  re-create a previously-deleted watcher proposal for this epic
```

```bash
nimbus pre-mortem PROJ-120
nimbus pre-mortem PROJ-120 --service billing-api --service payments-api
nimbus pre-mortem PROJ-120 --refresh
nimbus pre-mortem PROJ-120 --repropose
nimbus pre-mortem PROJ-120 --json
```

**Options:**

| Flag | Description |
|---|---|
| `<epic-ref>` | Required. A Jira epic key (`PROJ-120`) or explicitly-prefixed reference (`jira:PROJ-120`). Any other tracker prefix (e.g. `linear:ABC-1`) is reported as an unsupported-tracker gap rather than looked up. |
| `--service <name>` | Repeatable. Overrides the derived affected-service set entirely — useful for a brand-new epic with no PR-derivable services yet. |
| `--refresh` | Run `premortem.refresh` (the on-demand theme-extraction pass) before building the brief. Unlike `glossary`/`decisions`/`ownership`'s `.refresh`, this is a bare awaited RPC call, not a `{ jobId }` long-running job — a disabled pass (`[premortem].enabled = false`) or a concurrent pass surfaces as a normal error, exit code 2. |
| `--repropose` | Deletes this epic's `premortem_watcher_proposal` tombstones before proposing, so a watcher the user had previously deleted is re-created (paused) instead of staying suppressed. Scoped to this one epic only. |
| `--json` | Machine-readable JSON output (otherwise Markdown). |

Like `nimbus owners`/`nimbus glossary`, `nimbus pre-mortem` **hard-rejects** an unrecognised flag rather than ignoring it.

**Watcher proposals — what they are and are not:** every affected service **that resolves to a configured deployment-service id** gets one `watcher` row inserted with `enabled = 0` (paused) plus a `premortem_watcher_proposal` tombstone, wrapped in one transaction so the two can never land separately. A paused row cannot fire — `automation/watcher-store.ts`'s `listEnabledWatchers` filters strictly on `enabled = 1` — until a human arms it through the existing watcher-arming path; `nimbus pre-mortem` never arms anything itself. Proposals depend on the target epic's affected services only, not on its cohort, so an epic with no comparable history still gets them. This is the one narrowly-bounded exception to the built-in-agent read-only shape invariant — see the `nimbus-agent-patterns` skill for its exact bounds and why it is not an I2/HITL matter.

**A proposal is scoped by affected service, not by connector.** The watcher condition carries `filter.affectedService` — the `[metrics.dora.<id>]` / `[ci.service.<id>]` id the repo resolves to — which the watcher engine matches against the incident's `graph_entity.metadata.affectedService`. The older `filter.service` axis matches the `item.service` **column**, which for an incident is always the connector id (`pagerduty`), so it can only ever scope a watcher to a whole connector. **A repo with no configured service mapping gets no watcher at all**, and the brief says so by name: falling back to the repo path would write a watcher that silently matches nothing once armed. Add a `[ci.service.<id>]` block whose `repos` names the repository, then re-run.

**No deploy-failure watcher is proposed.** Deploy failure is a watcher condition kind, not one of the five risks — the fifth risk is abandonment, and no deploy-failure risk is computed. The engine can now scope such a watcher the same way, so the earlier reason (`item.service` being the annotate provider slug) no longer holds; what does is that `deployment/annotate.ts` — the only writer of the `metadata.conclusion` a `deploy_failed` watcher matches — inserts its `item` row directly and creates no `deployment` graph entity, so such a watcher would match nothing until `nimbus index regraph` runs.

**Review drag cannot currently be measured for any repo:** no connector indexes a pull request's *opened* timestamp (only `merged_at`), so the review-drag risk reports a named gap rather than a fabricated `0`. The measured path exists and activates the moment a connector starts recording that field; until then every brief reports the gap.

**Read-only in the request sense, not the write sense:** a plain `nimbus pre-mortem` never triggers HITL and never calls `connectors.dispatch` — the watcher-proposal writes above are plain local SQLite inserts, not egress. `agents.premortem` is deliberately excluded from the HTTP agent-invocation surface (`POST /v1/agents/{agent}`) and the MCP tool surface, matching `agents.preflight`, because those writes have no HITL gate and an external caller must not be able to trigger them unprompted; it remains reachable from the CLI (this command) and the Tauri renderer.

**Exit codes:** `1` = gateway not running; `2` = agent error (unknown or non-Epic epic key, unsupported tracker, or a `--refresh` pass failure).

---

### `nimbus catchup`

Personalized retrospective digest of everything that happened across connected services while you were away, weighted by your historical involvement. Unlike a uniform, service-scoped digest, `catchup` prioritizes activity by the user's recent work: services they own, repos they contribute to, incidents they've responded to, people they collaborate with frequently. Five parallel sub-agents (`s_owned_services`, `s_active_repos`, `s_responded_incidents`, `s_collaborators`, `s_window_items`); three-tier self-person resolver (override → git email → OS username).

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

### `nimbus ghost`

Surface ambient teammate context for a file by querying paired peers' expertise across the federation mesh. Returns a ranked list of teammates with recent PRs, issues, and commits touching the file — helping you identify who to consult before starting work. No message is ever sent automatically; this is a read-only suggestion surface.

```bash
nimbus ghost src/auth/session.ts
nimbus ghost src/auth/session.ts --json
nimbus ghost src/auth/session.ts --namespace project:zurich
```

**Options:**

| Flag | Description |
|---|---|
| `--namespace <n>` | Restrict the peer sweep to a single published namespace (default: ambient sweep across all paired peers) |
| `--json` | Machine-readable JSON output (otherwise Markdown) |

**Output (Markdown):** ranked list of teammates with their file-relevant evidence (recent PR titles, commit messages, issue assignments), confidence scores, and any gap notes (e.g. "peer offline", "no matching namespace").

**Read-only:** never triggers HITL, never sends a message, never makes a live API call. Fan-out goes only to consented, paired peers via the existing federated query gate (I17).

---

### `nimbus conflicts`

Warn of work-in-progress collisions before editing a file — surfaces teammates who have an open PR, assigned ticket, recent commit, or open branch touching the same file across the federation mesh.

```bash
nimbus conflicts src/auth/session.ts
nimbus conflicts src/auth/session.ts --json
nimbus conflicts src/auth/session.ts --namespace project:zurich
```

**Options:**

| Flag | Description |
|---|---|
| `--namespace <n>` | Restrict the peer sweep to a single published namespace (default: ambient sweep across all paired peers) |
| `--json` | Machine-readable JSON output (otherwise Markdown) |

**Output (Markdown):** list of detected WIP collisions per teammate (open PR url / ticket / branch / recent commit), ordered by recency; gap notes if a peer is unreachable.

**Read-only:** never triggers HITL, never makes a live API call.

---

### `nimbus huddle`

Team-scoped morning briefing aggregating each teammate's recent PRs, tickets, and incidents from across paired peers — a status summary without manual reporting.

```bash
nimbus huddle
nimbus huddle --since 86400000
nimbus huddle --json
nimbus huddle --namespace project:zurich --json
```

**Options:**

| Flag | Description |
|---|---|
| `--since <ms>` | Lookback window in milliseconds (default: 86400000 = 24 h) |
| `--namespace <n>` | Restrict the peer sweep to a single published namespace (default: ambient sweep across all paired peers) |
| `--json` | Machine-readable JSON output (otherwise Markdown) |

**Output (Markdown):** one section per teammate, each listing recent merged PRs, closed tickets, and resolved incidents with one-line context; gap notes if a peer is unreachable.

**Read-only:** never triggers HITL, never makes a live API call.

---

### `nimbus janitor`

Answer "is this cloud resource still in use, and what breaks if I delete it?" — cross-references a resource against indexed deployments, dashboards, alerts, and on-call rotations, and reports how long it has been idle.

```bash
nimbus janitor arn:aws:s3:::legacy-reports
nimbus janitor legacy-reports --idle-days 30
nimbus janitor legacy-reports --cleanup aws.s3.bucket_delete
nimbus janitor legacy-reports --allow-gaps --json
```

**Options:**

| Flag | Description |
|---|---|
| `--idle-days <n>` | Idle threshold in days (default: 14); must be a positive integer |
| `--cleanup <action.type>` | Propose a cleanup action of this type. The action still passes the local owner's HITL gate before it executes — the brief itself never deletes anything |
| `--allow-gaps` | Report a verdict even when some evidence lanes are missing (default: an incomplete sweep is called out rather than concluded from) |
| `--json` | Machine-readable JSON output (otherwise Markdown) |

**Output (Markdown):** the idle verdict with its evidence, the referencing surfaces found, and — when `--cleanup` is given — the proposed action awaiting consent.

**Read-only until approved:** the brief itself makes no writes; any `--cleanup` action is gated by HITL (invariant `I24`).

---

### `nimbus preflight`

Blast-radius preflight before a change lands: asks each paired downstream owner in a namespace to run their own verification against your candidate ref, then merges the answers. Each downstream owner approves the request behind their own HITL gate (invariant `I24` / static `D18`), so the call blocks on human responses for up to 10 minutes.

```bash
nimbus preflight src/billing/retry.ts --namespace project:zurich
nimbus preflight src/billing/retry.ts --namespace project:zurich --strict
nimbus preflight src/billing/retry.ts --namespace project:zurich --json
nimbus preflight approve req_8f3c21
```

**Options:**

| Flag | Description |
|---|---|
| `--namespace <ns>` | **Required.** The published namespace whose downstream owners are asked |
| `--strict` | Also exit non-zero when coverage is incomplete (a downstream declined, is not configured, or is unreachable) |
| `--json` | Machine-readable JSON output (otherwise Markdown) |

**Sub-command:** `nimbus preflight approve <request-id>` — respond to an inbound federated preflight request as the local owner.

**Exit code:** non-zero if any downstream's verification failed; with `--strict`, also non-zero on incomplete coverage. Useful as a CI gate.

**`nimbus deploy preflight` is a different command** — that one runs the local pre-deploy checks for a service; see [`nimbus deploy preflight`](#nimbus-deploy-preflight).

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

**HTTP write surface:** internally this routes through `POST /v1/deployments` on the local HTTP API — one of the twelve routes on the compile-time `WRITE_ROUTE_ALLOWLIST` (invariant `I13`: allowlist + bearer auth + per-token rate limit + audit-on-rejection). Any write to a non-allowlisted route is rejected. For this route an 8 KiB body cap applies, and every rejection is recorded as a `deployment.annotation_rejected` audit row.

**Required vault key:**

| Key | Purpose |
|---|---|
| `http_api.deployment_token` | Bearer token sent with every `POST /v1/deployments`. Set with `nimbus vault set http_api.deployment_token <token>`. Without it the HTTP write surface returns 503 (`write_surface_disabled`). |

A first-party GitHub Action wraps the endpoint for use directly in workflows — see [`packages/github-actions/annotate-action/`](../packages/github-actions/annotate-action/).

---

## Editor Integration

### `nimbus mcp-server`

Expose the Nimbus local index to MCP-compatible editor AIs (Cursor, Claude Code, Copilot) as a read-only MCP stdio server.

```bash
nimbus mcp-server            # print the MCP config block to paste into your editor (mcp.json)
nimbus mcp-server --stdio    # run the server over stdio (your editor launches this)
```

The Gateway must be running (`nimbus start`). Seventeen tools are registered; run
`nimbus mcp-server --help` for the live list, which is derived from the registry rather
than restated.

**Index and metrics (6, synchronous):** `searchIndex`, `getConnectorStatus`,
`getRecentIncidents`, `getRecentPullRequests`, `getRecentDeployments`, `getDoraMetrics`.

**Why-lens probe (1, synchronous):** `peekWhy` — a sub-300 ms one-liner for a
`path[:line]` or symbol.

**Agent briefs (10, asynchronous):** `explainWhy`, `getCatchup`, `findExpert`,
`assessImpact`, `findConflicts`, `findDecisions`, `getGlossary`, `checkResourceUsage`,
`getPeerContext`, `getTeamHuddle`. Each starts an `agents.*` run and returns the markdown
brief plus its typed findings once the matching `briefReady` notification arrives; the
wait is bounded at 60 s, overridable with `NIMBUS_MCP_TIMEOUT_MS`. `getPeerContext` and
`getTeamHuddle` reach paired peers across the federation mesh, not just this machine.

`agents.preflight` is deliberately **not** exposed: it is the `I24` federated action path,
and triggers sandboxed execution on peers behind the owner's HITL gate. No write or HITL
surface is exposed.

Briefs served over MCP are recorded in the egress ledger (`I29`) — the adapter declares
`kind: "mcp"` on connect, so `nimbus prove` accounts for them.

---

## Security

### `nimbus security scan`

Local credential-hygiene scan over already-indexed content.

```bash
nimbus security scan                       # pretty table
nimbus security scan --json                # frozen JSON envelope (machine-readable)
nimbus security scan --service filesystem  # scope to one connector
nimbus security scan --fail-on-finding     # exit 1 if any non-muted finding remains (CI)
nimbus security scan --extended            # also run the low-confidence pattern tier
```

**Flags.** `--service <name>` scopes the scan to one connector. `--fail-on-finding`
makes the command exit `1` when any non-muted finding remains (for CI gates).
`--extended` additionally runs the low-confidence pattern tier
(`[security].extended_patterns`) — combine it with `--fail-on-finding` only with a
well-maintained `[[security.allowlist]]`, or CI will flag false positives.

**Muting false positives.** Each finding prints a `fingerprint`; add it under
`[[security.allowlist]]` in `nimbus.toml` to mute it on future scans.

**Blame attribution.** For findings in git-tracked source files, the scan reports
the commit, author, and date that introduced the line — read from the local index
(no `git` call at scan time). If a finding shows no attribution, run
`nimbus connector sync filesystem` to populate the blame data, then re-scan.

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
  - `d` — show details (no-op; full payload is already shown)
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

**Cancel note:** the Gateway has an `engine.cancelStream` handler (`ipc/engine-cancel-stream.ts`) that stops token streaming immediately on `Ctrl+C`. The underlying LLM generation may still complete in the background — the `AbortSignal` is not yet plumbed into the agent invocation context (see `architecture.md` § *AbortController scope in `engine.cancelStream`*), so full-fidelity cancellation remains a follow-up.

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

The canonical per-connector credential keys live in `CONNECTOR_VAULT_SECRET_KEYS` (`packages/gateway/src/connectors/connector-secrets-manifest.ts`); the list below is grouped by domain.

```bash
# Cloud storage / mail / calendar (OAuth PKCE — opens browser)
nimbus connector auth google_drive
nimbus connector auth gmail
nimbus connector auth google_photos
nimbus connector auth onedrive
nimbus connector auth outlook
nimbus connector auth teams

# Source control / project tracking / knowledge
nimbus connector auth github         # PAT prompt — stored in OS keystore
nimbus connector auth gitlab         # PAT (+ optional self-hosted api_base)
nimbus connector auth bitbucket      # username + app password
nimbus connector auth linear         # API key
nimbus connector auth jira           # API token + email + base URL
nimbus connector auth confluence     # API token + email + base URL
nimbus connector auth notion         # OAuth
nimbus connector auth slack          # OAuth
nimbus connector auth discord        # bot token (opt-in)

# CI/CD
nimbus connector auth jenkins        # base URL + username + API token
nimbus connector auth circleci       # API token
nimbus connector auth bitrise        # PAT
# github_actions / gitlab_ci reuse the github / gitlab credentials above

# Cloud platforms / infrastructure
nimbus connector auth aws
nimbus connector auth azure
nimbus connector auth gcp
nimbus connector auth kubernetes
nimbus connector auth iac            # IaC CLIs (enable flag)

# Observability / incident
nimbus connector auth pagerduty
nimbus connector auth grafana        # URL + API token
nimbus connector auth sentry         # auth token + org slug + URL
nimbus connector auth newrelic       # API key + account id
nimbus connector auth datadog        # API key + app key + site

# Security scanning
nimbus connector auth snyk           # API token
nimbus connector auth sonarqube      # API token (+ optional org for SonarCloud)
nimbus connector auth semgrep        # PAT + deployment slug
nimbus connector auth wiz            # client id + secret (CSPM)
nimbus connector auth dependencytrack # base URL + API key (OWASP Dependency-Track SBOM)

# Feature flags
nimbus connector auth launchdarkly   # token + base URL + project key
nimbus connector auth flagsmith      # token + api base

# GitOps / data / BI
nimbus connector auth argocd         # URL + token
nimbus connector auth flux           # API URL + token
nimbus connector auth dbt            # token + api base + account id
nimbus connector auth metabase       # URL + API key
nimbus connector auth superset       # URL + username + password
nimbus connector auth databricks     # host + token
nimbus connector auth mlflow         # host + token

# Deploy platforms
nimbus connector auth vercel         # token (+ optional team id)
nimbus connector auth netlify        # token

# Finance / productivity / support
nimbus connector auth stripe         # secret API key
nimbus connector auth mercury        # token
nimbus connector auth readwise       # token
nimbus connector auth raindrop       # token
nimbus connector auth intercom       # token
nimbus connector auth zendesk        # URL + email + API token
nimbus connector auth stackoverflow  # token + team
nimbus connector auth ramp           # OAuth client-credentials (client id + secret)
nimbus connector auth zotero         # API key + library id

# Recruiting / CRM (OAuth where noted — opens browser)
nimbus connector auth lever          # API key
nimbus connector auth greenhouse     # API key
nimbus connector auth pipedrive      # token
nimbus connector auth hubspot        # OAuth 3-legged
nimbus connector auth salesforce     # OAuth 3-legged + PKCE — per-tenant instance_url

# Design / whiteboard (OAuth 3-legged — opens browser)
nimbus connector auth miro           # OAuth
nimbus connector auth canva          # OAuth + PKCE (Basic-header secret)
nimbus connector auth figma          # OAuth (+ non-secret team id)

# Data orchestration / search / quality
nimbus connector auth airflow            # base URL + username + password
nimbus connector auth prefect            # API URL + API key
nimbus connector auth dagster            # base URL + API token
nimbus connector auth elasticsearch      # URL + API key (index metadata only)
nimbus connector auth great_expectations # results dir path (filesystem; no live creds)

# Meetings
nimbus connector auth zoom           # OAuth 3-legged PKCE — opens browser
```

**Credential reuse — no separate `connector auth` needed.** `github_actions` / `gitlab_ci` reuse the `github` / `gitlab` credentials; `google_meet` rides the `google` OAuth; and the metadata-only **BigQuery / Athena / CloudWatch / SageMaker / Cloud Logging / Vertex AI** connectors reuse your `aws` / `gcp` credentials. Authenticate the underlying provider and these light up automatically.

**Output — the command reports only what it actually checked.** For a handful of PAT-based connectors (`github`, `gitlab`, `bitbucket`, `jira`, `jenkins`) the gateway makes one cheap identity-endpoint call before returning; every OAuth connector is confirmed by construction — a completed PKCE browser consent + token exchange IS the provider confirming the credential. So the outcome is one of:

- `Verified: <service>` — the provider confirmed the credential: a 2xx from the identity check (PAT connectors), or a completed OAuth token exchange (OAuth connectors).
- `Stored: <service> (NOT verified — the provider did not confirm it)`, plus a follow-up line suggesting a retry — the credential was stored but the check got a non-401 failure (403, 429, 5xx, 404, or a transport failure); those causes are not distinguished. It may still be valid.
- `Stored: <service> (not verified)` — no probe is registered for that service (the remaining PAT connectors); the credential was stored as given and nothing was checked.

A credential the provider actively **rejects** (HTTP 401) is never stored: `nimbus connector auth` throws and exits with status `1` (a user-actionable precondition — fix the token and retry). Any other failure to store — including the gateway being unreachable — also exits with status `1`; `connector auth` has only one error path (an unhandled `Error` reaching the CLI's top-level catch-all), so there is no separate "operational failure" exit code here. All three outcomes above — verified, unverified, and unprobed — exit `0`: the credential was stored, which is what the command was asked to do.

#### Zoom OAuth setup

Zoom uses 3-legged OAuth (PKCE + Basic-header client-secret). Before running `nimbus connector auth zoom`, create a Zoom app and export the client credentials:

1. Go to [marketplace.zoom.us](https://marketplace.zoom.us) → **Develop** → **Build App** → **General app** (User-managed, PKCE).
2. Add scopes: `user:read:user`, `meeting:read:list_meetings`, `cloud_recording:read:list_user_recordings`.
3. Copy the **Client ID** and **Client Secret** and export them:

```bash
export NIMBUS_OAUTH_ZOOM_CLIENT_ID=<client_id>
export NIMBUS_OAUTH_ZOOM_CLIENT_SECRET=<client_secret>
nimbus connector auth zoom
```

The access token and rotating refresh token are stored in the OS keystore under `zoom.oauth`. Token rotation is handled automatically by the Gateway's single-flight refresh lock (Zoom invalidates the entire token chain on refresh-token reuse, so only one refresh runs at a time).

The connector indexes both scheduled meetings (`zoom:meeting`) and cloud-recording AI transcripts (`zoom:transcript`, prose-heavy). The `cloud_recording:read:list_user_recordings` scope above covers transcripts — no re-consent is needed beyond the initial `nimbus connector auth zoom`. New transcripts are picked up on the next sync cycle; `nimbus connector reindex zoom` forces an immediate pass.

---

### `nimbus connector list`

List all connectors and their current health state.

```bash
nimbus connector list
nimbus connector list --json
nimbus connector list --json | jq -r '.[] | select(.healthState != "healthy") | .serviceId'
```

**Health states:** `healthy` · `degraded` · `error` · `rate_limited` · `unauthenticated` · `paused`

**`--json` shape.** A JSON array of the raw `connector.listStatus` rows — `serviceId`, `status`, `lastSyncAt`, `nextSyncAt`, `intervalMs`, `itemCount`, `lastError`, `consecutiveFailures`, `healthState`, `healthRetryAfterMs` (timestamps are epoch ms or `null`, not the relative "5m ago" strings the table renders). With no connectors registered the output is `[]`, not the human "No connectors registered yet" hint.

---

### `nimbus connector status <name>`

Show detailed status for a single connector.

```bash
nimbus connector status github
nimbus connector status github --stats   # Attach the 15 most recent sync-telemetry rows
```

Output is always JSON; `--stats` is the only flag read.

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

### `nimbus connector set-interval <name> <duration>`

Override the sync interval for a connector. The duration is unit-suffixed (`ms`, `s`, `m`, `h`) — a bare number is rejected with `Invalid duration "300" (use e.g. 5m, 1h, 30s)`.

```bash
nimbus connector set-interval github 5m
nimbus connector set-interval google_drive 1h
```

---

### `nimbus connector history <name>`

Show the health transition history for a connector — useful for diagnosing flapping or persistent errors.

```bash
nimbus connector history github
nimbus connector history github --limit 50
```

Output is always JSON.

---

### `nimbus connector remove <name>`

Remove a connector: deletes all associated Vault entries and index rows atomically.

```bash
nimbus connector remove github          # Prompts: y/n
nimbus connector remove github --yes    # Skip confirmation (-y also works)
```

> **Irreversible.** On success the command prints the number of index rows deleted plus the Vault keys it cleared, and nothing restores them. Take a snapshot first (`nimbus db snapshot`) if you may want the index rows back.

The CLI asks for confirmation before it sends `connector.remove`. Declining the prompt (or cancelling it with Ctrl-C) prints `Cancelled.` and sends nothing. Outside an interactive shell — piped, or run from a script — there is no prompt to answer, so the command refuses with a non-zero exit rather than waiting for input; pass `--yes` or `-y` to proceed non-interactively.

`connector.remove` is also a HITL action on the Gateway side, but you are only asked once: the CLI confirmation *is* the consent decision, and the CLI answers the Gateway's consent request with it. A declined prompt never reaches the Gateway at all, and `--yes` covers both — the auto-approval is still noted on stderr (`[--yes] auto-approving HITL request: …`) so it shows up in a script's log. If the Gateway rejects the removal anyway (for example an org policy that forbids it), the command exits non-zero with the rejection reason and removes nothing.

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
| `metadata_only` *(default for this command)* | IDs, timestamps, titles, URLs, owners — no body content. Suppresses both `body` and `body_preview`; a connector's fetched text is discarded before it reaches the index. |
| `summary` | Metadata + a 512-character prefix of each item's body, stored in `body_preview`. There is no summarizer — it is a plain truncation, and it never claims completeness (`body_complete` stays 0). |
| `full` | Metadata + full body content up to the connector's cap (16 KiB for prose-heavy item types, 512 characters otherwise) — the largest index footprint. |

`metadata_only` is the default **only for `nimbus connector reindex` when `--depth` is omitted** (the CLI passes `metadata_only` explicitly in that case, and the reindex persists it). It is not the depth a connector starts at: a connector that has never had its depth explicitly set — a fresh install's first sync — resolves to `full`, since `sync_state` rows are always written with `depth = 'full'` (`connectors/health.ts` `upsertHealthRow`) and a missing `sync_state.depth` row also resolves to `full`. Running `reindex` without `--depth` therefore *lowers* a connector's depth from its `full` starting point — pass `--depth full` explicitly to reindex without changing it.

Output reports the resolved mode and the number of items affected. The depth is persisted as the connector's default and is enforced on **every** subsequent sync, not only at `reindex` time — every connector's item-writing code path is routed through a shared depth chokepoint (`upsertIndexedItemForSync`) that coerces the row to the configured depth before it is written, so a `metadata_only` or `summary` connector never accumulates full bodies between explicit reindexes.

**Deepening is not retroactive.** Lowering the depth rewrites existing rows immediately (bodies are stripped or clamped in place), but **raising** it does not bring back text that was never stored: `--depth full` on a connector that has been running at `summary` or `metadata_only` reports `0` items affected and switches the setting for future syncs only. The Gateway has no copy of the discarded bodies to restore from — they have to be fetched again. To recover them, either force a fresh sync (`nimbus connector sync <name> --full`, which re-fetches from scratch rather than resuming the stored cursor) or run `nimbus index rebody --service <name>` for the connectors that support it. This asymmetry has always been in the code; it becomes visible for the first time now that depth is actually enforced between reindexes.

---

## Configuration

### `nimbus config get <key>`

Read a single configuration value.

```bash
nimbus config get telemetry.enabled
nimbus config get llm.remote_model
```

There is no TOML key for sync cadence — per-connector intervals are set with `nimbus connector set-interval <service> <duration>`, which writes to the index, not to `nimbus.toml`.

---

### `nimbus config set <key> <value>`

Set a configuration value. Changes take effect on the next Gateway restart for Gateway-owned keys; CLI-only keys take effect immediately.

```bash
nimbus config set telemetry.enabled false
nimbus config set llm.remote_model      claude-sonnet-4-6
nimbus config set llm.classifier_model  claude-haiku-4-5-20251001
nimbus config set llm.local_model       llama3.2
nimbus config set llm.prefer_local      true
```

The provider is inferred from the model id: `claude-*` → Anthropic, `gpt-*` / `o1-*` / `o3-*` / `o4-*` → OpenAI. Already-prefixed forms (`anthropic/...`, `openai/...`) are accepted as-is.

---

### `nimbus config list`

Print the config file path, then a per-key line for whichever of the five env-overridable keys (`telemetry.enabled`, `telemetry.endpoint`, `telemetry.flush_interval_seconds`, `llm.remote_model`, `llm.classifier_model`) currently has a value, followed by the raw `nimbus.toml` body. A key is listed as `env` when its environment variable is set to a non-empty value, otherwise as `file` when it is present in `nimbus.toml` — and is **omitted entirely** when it is neither. There is no `default` source and no line for an unset key. Every other key appears only in the raw dump; there is no per-key documentation column.

```bash
nimbus config list
nimbus config list --json
nimbus config list --json | jq -r '.keys[] | select(.source == "env") | .envVar'
```

**`--json` shape.** One object:

| Key | Type | Notes |
|---|---|---|
| `path` | string | Resolved `nimbus.toml` path |
| `exists` | boolean | Whether that file is present |
| `keys` | array | `{ key, value, source: "file" \| "env", envVar: string \| null }` — `envVar` is the overriding variable, `null` for file-sourced keys |
| `raw` | string \| null | The file body verbatim; `null` when the file is missing |

The prose "other `NIMBUS_*` overrides" legend the human view prints is static documentation, not data, and has no JSON counterpart.

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
local_model        = "llama3.2" # Any pulled Ollama model name
# llama.cpp HTTP base URL; not the filesystem path to the llama-server binary.
# llamacpp_server_path = "http://127.0.0.1:8080"
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

### `nimbus profile delete <name> --yes`

Delete a profile and its associated configuration. Does not delete Vault entries (use `nimbus connector remove` first). Requires the `--yes` flag for confirmation (same pattern as other destructive operations).

```bash
nimbus profile delete personal --yes
```

---

## Team Federation

Peer-to-peer federation between Nimbus Gateways over the encrypted LAN channel (Phase 6 Slice 1). Disabled by default; enable via the `[federation]` section in `nimbus.toml`. Every inbound query is answered only through the consent-scoped, leak-proof **query gate** (invariant `I17`): grant + role + consent + declared-namespace filter, returning rank/metadata-free results only. Pairing uses an out-of-band code (same trust model as `nimbus lan pair`).

### `nimbus team discover`

Discover reachable peer Gateways via mDNS (with a manual fallback). Read-only. This is the default subcommand (`nimbus team` with no argument runs `discover`).

```bash
nimbus team discover
```

### `nimbus team pair <host> <code>`

Pair with a peer Gateway using a one-time, out-of-band pairing code. Transmit the code over a channel other than the one being paired (read it aloud, SMS, etc.) — a mid-pairing network attacker who sees the code can substitute their own key.

```bash
nimbus team pair gw.lan:7700 a1b2c3d4e5f6g7h8i9j0
```

### `nimbus team namespace publish <name> --type <T> --service <S>`

Publish a shared scoped namespace. Requires at least one `--type` / `--service` / `--tag` filter; the filters define exactly what a granted peer may query.

```bash
nimbus team namespace publish incidents --type incident --service pagerduty
```

### `nimbus team namespace grant <ns> <peerId> <role> [--standing]`

Grant a paired peer role-based access to a published namespace. `--standing` persists the grant across sessions (otherwise it is session-scoped).

```bash
nimbus team namespace grant incidents peer:aabbcc reader --standing
```

### `nimbus team namespace revoke <ns> <peerId>`

Revoke a peer's access to a namespace. Further answers stop within one sync cycle.

```bash
nimbus team namespace revoke incidents peer:aabbcc
```

### `nimbus team query <ns> <peerId> "<purpose>"`

Send a consent-scoped federated query to a paired peer within a namespace. The answering peer's query gate enforces grant + role + consent (`I17`); results never include raw item bodies.

```bash
nimbus team query incidents peer:aabbcc "open P1 incidents this week"
```

### `nimbus team who-knows <peerId> "<query>"`

Expertise routing — ask a peer "who knows X?" Returns a ranked contributor list with **no** indexed item content transmitted (ranks only).

```bash
nimbus team who-knows peer:aabbcc "src/billing/retry.ts"
```

### `nimbus team consent <requestId> approve|deny` · `nimbus team listen`

`consent` replies to an inbound federated-query consent request — the host owner remains the consent authority. `listen` runs the foreground listener that surfaces inbound consent requests as they arrive.

```bash
nimbus team consent req:1234 approve
nimbus team listen
```

### Team Vault (Phase 6 Slice 2)

Store team-shared secrets in a leak-proof team vault and grant paired peers tool-scoped use of them. Secrets are never returned over the wire (invariant `I19`); a granted peer can only *invoke* a tool that consumes the secret.

### `nimbus team vault put <entry> <service> --secret key=value`

Store one or more secrets for a team-vault entry bound to a connector service. Repeat `--secret key=value` for each field; at least one is required.

```bash
nimbus team vault put prod-stripe stripe --secret api_key=sk_live_xxxx
```

### `nimbus team vault grant <entry> <peerId> <toolId>`

Grant a paired peer permission to invoke one tool against a team-vault entry.

```bash
nimbus team vault grant prod-stripe peer:aabbcc stripe.refund.create
```

### `nimbus team vault revoke <entry> <peerId> <toolId>`

Revoke a peer's permission to invoke a tool against a team-vault entry.

```bash
nimbus team vault revoke prod-stripe peer:aabbcc stripe.refund.create
```

### `nimbus team vault list`

List the team-vault entries and their grants (JSON).

```bash
nimbus team vault list
```

### `nimbus team invoke <peerId> <entry> <toolId> --purpose "<why>" [--args <json>]`

Ask a peer to invoke a granted tool against one of their team-vault entries on your behalf. The peer's gateway runs the tool with team-scoped credentials and returns a leak-proof result (invariant `I19`). `--args` accepts a JSON object of tool arguments.

```bash
nimbus team invoke peer:aabbcc prod-stripe stripe.refund.create --purpose "refund order 1234" --args '{"charge":"ch_xyz"}'
```

### Delegation & Quorum Approval (Phase 6 Slice 2)

### `nimbus team delegate <peerId> --scope kind:value --expires <seconds>`

Delegate your HITL approval authority for a scope to a paired peer for a bounded window. A delegated approval is honored only from a live, in-scope, identity-valid delegate; otherwise it falls back to the local owner (invariant `I20`).

```bash
nimbus team delegate peer:aabbcc --scope service:stripe --expires 3600
```

### `nimbus team delegations`

List the active HITL delegations (JSON).

```bash
nimbus team delegations
```

### `nimbus team approve <requestId> [--as <peerId>]` / `nimbus team deny <requestId> [--as <peerId>]`

Approve or deny a pending federated approval — a delegated approval or a quorum vote. `--as <peerId>` casts the decision as a specific peer identity (defaults to `self`). Quorum counts only distinct authenticated peers and is deny-fail-closed (invariant `I21`).

```bash
nimbus team approve req:1234
nimbus team deny req:1234 --as peer:aabbcc
```

### Audit & GDPR (Phase 6 Slice 4)

### `nimbus team audit <namespace> [--purpose "<why>"] [--since <unixMs>]`

Render the merged team-audit timeline for a namespace as a fixed-width table (timestamp, peer, action, HITL status, hash). `--since` filters by unix-millisecond timestamp.

```bash
nimbus team audit incidents --purpose "quarterly review" --since 1715000000000
```

### `nimbus team purge --user <externalId> [--yes]`

GDPR-purge all data for a user across the team. Irreversible; prompts for confirmation unless `--yes` (or `--force`) is passed.

```bash
nimbus team purge --user alice@acme.com --yes
```

---

## Identity & Access

Enterprise SSO/OIDC and SCIM provisioning for the Phase 6 federation layer (Slice 3). Identity gates **federation only** — local `ask` / `search` are never affected. Disabled by default; enable via the `[identity]` / `[scim]` sections in `nimbus.toml`. Raw ID/refresh tokens and the SCIM bearer live only in the Vault (invariant I18); ID tokens are validated (RS256) on every session.

### `nimbus identity login`

Start the OIDC device-code login flow. The Gateway prints a verification URL and a user code; open the URL in a browser and enter the code to complete sign-in. This is the default subcommand (`nimbus identity` with no argument runs `login`).

```bash
nimbus identity login
```

---

### `nimbus identity status`

Show the current operator session (issuer, subject/email, validity window) as JSON.

```bash
nimbus identity status
```

---

### `nimbus identity logout`

Clear the current operator session and remove the Vault-stored tokens.

```bash
nimbus identity logout
```

---

### `nimbus identity list-bindings <email>`

List the federation peer bindings for a provisioned user.

```bash
nimbus identity list-bindings alice@acme.com
```

---

### `nimbus identity bind <email> <peerId>` / `unbind <peerId>`

Administratively bind a provisioned user to a federation peer (or remove the binding). Credential-mutating; CLI-only (not exposed to the desktop UI).

```bash
nimbus identity bind alice@acme.com peer:aabbcc
nimbus identity unbind peer:aabbcc
```

---

### `nimbus scim status`

Show the SCIM provisioning endpoint status (enabled, user count) as JSON. This is the default subcommand (`nimbus scim` with no argument runs `status`).

```bash
nimbus scim status
```

---

### `nimbus scim set-token <token>`

Store the SCIM bearer token (the trust anchor the IdP presents on SCIM 2.0 requests) in the Vault. Credential-mutating; CLI-only.

```bash
nimbus scim set-token "$SCIM_BEARER"
```

---

### `nimbus scim list-users`

List the SCIM-provisioned users as JSON.

```bash
nimbus scim list-users
```

---

### `nimbus scim deprovision <email>`

Deprovision a user. Marks the SCIM user inactive and auto-revokes their federation grants/bindings. Credential-mutating; CLI-only.

```bash
nimbus scim deprovision alice@acme.com
```

---

## Org Policy

Signature-verified organization policy for the Phase 6 federation layer (Slice 4). Enforcement reads a resolved, monotonic-stricter `EnforcedPolicy` — never the raw policy TOML — and resolution is tighten-only and fail-closed to the last-valid/baseline policy (invariant `I22`). Channel↔namespace bindings and resource→owner ownership for ChatOps live in `[policy.chatops.*]`.

### `nimbus policy show`

Display the current org policy as JSON. This is the default subcommand (`nimbus policy` with no argument runs `show`).

```bash
nimbus policy show
```

---

### `nimbus policy verify`

Verify the org policy signature and print the validation result as JSON.

```bash
nimbus policy verify
```

---

### `nimbus policy sign <file.toml>` / `nimbus policy push <file.toml>`

Sign a policy TOML file and apply it. `push` is an alias for `sign`.

```bash
nimbus policy sign ./org-policy.toml
nimbus policy push ./org-policy.toml
```

---

### `nimbus policy trust <pubkeyBase64>`

Pin an org-policy anchor public key (base64). Subsequent policies must verify against a trusted anchor.

```bash
nimbus policy trust BASE64_PUBKEY
```

---

### `nimbus policy refetch`

Fetch the latest policy from the configured policy source and print the result as JSON.

```bash
nimbus policy refetch
```

---

## ChatOps

A bidirectional Slack/Teams `@nimbus` bot (Phase 6 Slice 5). Read queries are answered from the shared index; structured write commands (`@nimbus run <action> service=<svc> …`) route to the resolved resource owner's HITL approval before executing — the bot never bypasses the consent gate (invariant `I23` bounds the operational reply surface). Disabled by default; enable via the `[chatops]` section in `nimbus.toml`. Channel↔namespace bindings and resource→owner ownership live in the signed org policy (`[policy.chatops.*]`). The subcommands are local/CLI-only (forbidden over the LAN wire); only `chatops.status` is exposed to the desktop UI.

### `nimbus chatops status`

Show whether ChatOps is enabled and, per platform, whether the transport is connected and how many policy-bound channels it serves. Default subcommand (`nimbus chatops` with no argument).

```bash
nimbus chatops status
```

### `nimbus chatops start` / `nimbus chatops stop`

Start or stop the bot transports (Slack Socket Mode connection / Teams webhook dispatch).

```bash
nimbus chatops start
nimbus chatops stop
```

### `nimbus chatops test "<message>"`

Dry-run the command parser against a message without sending anything — prints the parsed `read` / `write` / `refused` result. Useful for checking how a phrasing is interpreted.

```bash
nimbus chatops test "run deployment.rollback service=payment-service version=v1.4"
```

---

## Tribal-Knowledge Extraction

Detects repeated questions in an allowlisted set of Slack/Teams channels and, on your HITL approval, captures a synthesized Q&A into a config-pinned shared knowledge base (Notion/Confluence) — Phase 6 Slice 6c, behind invariant `I25` (the KB write destination comes from local config only, never the caller). Disabled by default; enable via the `[tribal]` section in `nimbus.toml`. The subcommands are local/CLI-only (forbidden over the LAN wire); only `tribal.status` / `tribal.list` are exposed to the desktop UI.

**Configuration (`nimbus.toml`):**

```toml
[tribal]
enabled = true
match = "embedding"            # or "embedding+llm" for a precision second pass
min_occurrences = 3            # fire a suggestion after N occurrences of a question
window_days = 14               # within this rolling window
cooldown_days = 30             # after capture/dismiss, suppress re-suggestion this long
watch_channels = ["C123ABC"]   # REQUIRED non-empty when enabled (fail-closed privacy boundary)

# At least one capture destination — the owner's local config is the ONLY source of the
# destination (I25); a `--target` selector on capture just picks which one.
[tribal.notion]
database_id = "<notion-database-id>"

[tribal.confluence]
space_key = "ENG"
parent_page_id = "<parent-page-id>"
```

> **Deployment note (Slack):** seeing non-mention channel messages requires the deployed Slack app manifest to subscribe to the `message.channels` bot event. Without it the watcher only sees `@nimbus` mentions (degraded, not broken). **Cost note:** every watched-channel question is embedded locally (MiniLM, no network) before the cheap question-classifier and the channel allowlist short-circuit non-questions — keep `watch_channels` scoped to the channels where Q&A actually happens.

### `nimbus tribal status`

Show whether the watcher is enabled and how many clusters are tracked. Default subcommand.

```bash
nimbus tribal status
```

### `nimbus tribal start` / `nimbus tribal stop`

Pause/resume ingestion of inbound messages without restarting the gateway.

### `nimbus tribal list [status]`

List tracked clusters, optionally filtered by `pending` / `suggested` / `captured` / `dismissed`.

```bash
nimbus tribal list suggested
```

### `nimbus tribal capture <cluster-id> [--target notion|confluence]`

Synthesize a draft answer + citations for a cluster and write it to the KB **after your HITL approval**. `--target` is required only when both `[tribal.notion]` and `[tribal.confluence]` are configured; the destination database/space/parent is always taken from local config, never from the command. Also available in-chat as `@nimbus tribal capture <cluster-id>`.

```bash
nimbus tribal capture tq_ab12cd34ef56 --target notion
```

### `nimbus tribal dismiss <cluster-id>` · `nimbus tribal scan`

`dismiss` suppresses a cluster (enters cooldown); `scan` re-fires suggestions for any pending cluster that already crossed the threshold.

---

## Sharing

Publish a redacted, signed, verifiable copy of an agent session — Phase 6 Slice 8, behind invariant `I27`. An outbound share leaves the machine **only** through the share gate: default + caller-supplied redaction is applied, the LOCAL owner approves the exact redacted preview via the `share.publish` HITL action, the body is signed with the Vault-only `share.signing.privkey`, and the share record is persisted to the `share_records` table (schema V41/V42). A denied or timed-out approval emits nothing (fail-closed). The write/owner-action subcommands (`create`, `prune`, `approve`/`reject`) are local/CLI-only — forbidden over the LAN wire so a remote peer can never trigger or approve an outbound publish; only the read-only verify/list/pubkey surfaces are LAN- and Tauri-reachable.

### `nimbus share create <session-id>`

Publish a redacted, signed copy of a session. By default the share is written to a local file; choose a sink with the flags below. The command blocks on the `share.publish` HITL approval of the redacted preview and prints the resulting content hash on success.

| Flag | Effect |
| --- | --- |
| `--out <file>` | Write the signed share bundle to `<file>` (default sink is a file). |
| `--http` | POST the bundle to the config-pinned `[share.http_sink]` (SSRF-safe; the only host `--http` may target). |
| `--to-peer <id>` | Send the bundle to a paired federation peer. |
| `--as-recipe` | Share a declarative recipe (DAG of params) instead of the raw transcript. |
| `--redact <pattern>` | Add a redaction pattern (repeatable); applied on top of the default redaction set. |
| `--expires <dur>` | Expiry as `30s` / `15m` / `12h` / `7d`; omit for no expiry. |

```bash
nimbus share create sess_ab12cd34 --out ./my-session.share
nimbus share create sess_ab12cd34 --as-recipe --redact "internal-host" --expires 7d
```

Precedence when multiple sinks are given: `--out` (file) > `--http` > `--to-peer` > default file.

### `nimbus share list [--all]`

List persisted share records (content hash, kind, creation time). `--all` includes expired records.

```bash
nimbus share list
```

### `nimbus share prune`

Delete expired `share_records` rows and report how many were removed. Local-only.

```bash
nimbus share prune
```

### `nimbus share pubkey` · `nimbus share approve|reject <request-id>` · `nimbus verify-share <file|url>`

`pubkey` prints this gateway's share-signing public key (so recipients can verify). `approve`/`reject` answer a pending `share.publish` approval prompt by request id (the LOCAL-owner action — never answerable over LAN). `nimbus verify-share` checks a received share file or URL: it reports whether the signature is valid, whether the content hash matches, and whether the share has expired.

```bash
nimbus share pubkey
nimbus verify-share ./received.share
```

---

## Egress Ledger & Provenance

Prove what (if anything) a query sent off your machine, and inspect the append-only egress ledger — Phase 6 / S1 (PR #698), behind invariant `I29`. Every gated action appends exactly one `egress_ledger` row at the executor chokepoint **before** the connector dispatch (a `blocked` row on a denied action; an append failure aborts the dispatch). The ledger is BLAKE3-hash-chained and append-only; its head advances if — and only if — a real outbound action ran. Verification is offline and timing-safe (invariant `I10`). The only mutation of `egress_ledger` is the owner-HITL-gated `nimbus egress prune`, which writes a continuing tombstone rather than rewriting history.

### `nimbus prove "<query>"`

Run a query and prove its outbound footprint. The command snapshots the ledger head **before** the query, runs it through the same blocking agent path as `nimbus ask`, snapshots the head **after**, and prints the delta:

```text
outbound egress events during this query: N
```

`0 ✓` means the query was answered entirely from the local index — nothing left the machine. A non-zero count is followed by the per-event egress report (see `nimbus egress` below) so you can see exactly what went where.

| Flag | Effect |
| --- | --- |
| `--receipt` / `--sign` | Sign the printed egress report with the gateway's egress-attestation key (prints a `receipt: digest=… sig=…` line) when the count is non-zero. |

```bash
nimbus prove "what did Alice say about the launch?"
# outbound egress events during this query: 0 ✓   (answered from the local index)

nimbus prove "open a GitHub issue for the flaky test" --receipt
# outbound egress events during this query: 1
#   2026-06-21 14:03:11  github.issues.create         ok
# receipt: digest=… sig=…
```

The first positional non-flag argument is the query; flags may appear in any position.

### `nimbus egress` / `nimbus egress verify`

`nimbus egress` (no subcommand) prints the egress report: the outbound-event count, the completeness tier, and one line per ledger row (`timestamp`, `method`, `result status`). Before printing, the chain is verified offline; if the chain is **degraded/unverifiable** the report prints `indeterminate` and exits non-zero — it never reports a false `0` (a broken chain is unverifiable, not proof of no egress).

`nimbus egress verify` runs the standalone offline integrity check and prints `[ok]` with the verified row count, or `[FAIL]` with the row index of the chain break (timing-safe comparison, invariant `I10`).

| Flag | Effect |
| --- | --- |
| `--since <dur>` | Restrict the report to events newer than the duration (`24h` / `30m` / `7d` — the shared `--since` grammar, same as `nimbus query --since`; `nimbus audit` has no `--since`). |
| `--json` | Emit the full result (rows, completeness, verify status, receipt) as JSON. |
| `--sign` | Attach a signed attestation receipt to the report. |

```bash
nimbus egress
# outbound egress events: 3 (tier: complete)
#   2026-06-21 09:12:04  slack.messages.send          ok
#   ...

nimbus egress --since 24h --json
nimbus egress verify
# [ok]   egress chain integrity — 128 rows verified
```

### `nimbus egress prune (--before <ISO|epoch> | --older-than <duration>)`

Trim old ledger rows under retention. This is the **sole** mutation of `egress_ledger` and is gated by the LOCAL owner's HITL approval (it prompts inline; deny removes nothing). Rather than rewriting the hash chain, prune writes a **continuing tombstone** so verification of the remaining chain still holds. Provide the cutoff in exactly one of two **mutually exclusive** forms — supplying both is an error:

| Flag | Effect |
| --- | --- |
| `--before <ISO\|epoch>` | Absolute cutoff: an ISO date (`2026-01-01`) or an epoch-millisecond integer. Rows at/after the cutoff are kept. |
| `--older-than <duration>` | Relative cutoff: `now − duration` (`7d` / `24h` / `30m`), reusing the shared `--since` duration grammar. |

```bash
nimbus egress prune --older-than 30d
# [ok] pruned 42 egress rows (tombstone written)

nimbus egress prune --before 2026-01-01
# [denied] prune not approved — nothing removed   (HITL deny)
```

---

## Admin Console

Local-only helpers for the admin read-surface (Phase 6 Slice 4). The read-surface bearer is the Vault credential `http_api.deployment_token` — the same bearer that protects the `I13` HTTP write surface. The CLI talks to the gateway IPC-only and never holds the Vault, so `console` and `token` print a resolver command rather than echoing the secret; both are local-only (no gateway round-trip).

### `nimbus admin status`

Show the admin read-surface status as JSON. This is the default subcommand (`nimbus admin` with no argument runs `status`).

```bash
nimbus admin status
```

---

### `nimbus admin console`

Print the admin console URL with the bearer carried in the URL **fragment** (never the query string, so it is not sent to servers or written to access logs). Resolve the bearer with `nimbus vault get http_api.deployment_token` and open the printed URL in a browser.

```bash
nimbus admin console
# Admin console: http://127.0.0.1:<NIMBUS_HTTP_PORT>/admin#token=$(nimbus vault get http_api.deployment_token)
```

---

### `nimbus admin token`

Print the Vault key name (`http_api.deployment_token`) that holds the read-surface bearer, with the command to print its value.

```bash
nimbus admin token
```

---

## Local LLM

### `nimbus llm status`

Show which LLM provider and model is selected for each task type, whether the provider
is reachable, and why it was chosen.

```text
nimbus llm status [--json]
```

**Output columns:**

| Column    | Description |
|-----------|-------------|
| Task type | One of `classification`, `reasoning`, `summarisation`, `agent_step` |
| Provider  | `ollama`, `llamacpp`, or `remote` |
| Model     | Model name from config (`llm.local_model` or `llm.remote_model`) |
| Available | Whether the provider responded to an availability check |
| Reason    | `prefer-local`, `prefer-remote`, `air-gap`, `no-local-provider`, `no-remote-provider`, or `local-below-reasoning-floor` |

The Provider/Model/Reason columns describe the **preferred** provider for each task (the
configured intent). When that provider is unavailable, the Reason cell also names the provider
the router would actually fall back to at generation time — `… (falls back to remote/<model>)`.

**Flags:**

| Flag     | Description |
|----------|-------------|
| `--json` | Emit machine-readable JSON instead of the table |

**Example — table:**

```text
Task type      Provider   Model                    Available  Reason
-------------------------------------------------------------------------------
classification ollama     llama3.2                 yes        prefer-local
reasoning      ollama     llama3.2                 no         prefer-local (falls back to remote/claude-sonnet-4-6)
summarisation  ollama     llama3.2                 yes        prefer-local
agent_step     —          —                        no         unavailable
```

**Example — JSON:**

```json
{
  "classification": {
    "providerId": "ollama",
    "modelName": "llama3.2",
    "isAvailable": true,
    "reason": "prefer-local"
  },
  "reasoning": {
    "providerId": "ollama",
    "modelName": "llama3.2",
    "isAvailable": false,
    "reason": "prefer-local",
    "fallback": { "providerId": "remote", "modelName": "claude-sonnet-4-6" }
  }
}
```

The `fallback` field is present only when the preferred provider is unavailable but another
provider can serve the task.

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

**Write endpoints** — the complete `WRITE_ROUTE_ALLOWLIST` (invariant `I13`); every write not on this list is rejected:

| Endpoint | Description |
|---|---|
| `POST /v1/deployments` | Record a deployment annotation (bearer `http_api.deployment_token`) |
| `POST /scim/v2/Users`, `PATCH /scim/v2/Users/{id}`, `DELETE /scim/v2/Users/{id}` | SCIM v2 provisioning (bearer `identity.scim.bearer`) |
| `PUT /v1/admin/policy` | Admin-console org-policy write (admin bearer; signed with the Vault-only anchor key) |
| `POST /v1/messaging/teams/events` | ChatOps Teams inbound (Bot Framework JWT validated in-route) |
| `POST /v1/clips`, `POST /v1/clips/pair/confirm` | Web-clipper ingest and pairing confirm (invariant `I30`) |
| `POST /v1/briefs`, `POST /v1/briefs/{id}/sources`, `POST /v1/briefs/{id}/run`, `POST /v1/briefs/{id}/save` | Research-brief create / feed source / synthesize / save (labeled clipper token) |

All read endpoints are `localhost`-only and use `SQLITE_OPEN_READONLY`. Every write route carries bearer (or in-route) authentication, a per-route body cap, per-token rate limiting (60 req/min by default; `POST /v1/clips` tightens to 20), and audit-on-rejection. There is no authentication required for read endpoints because the socket is owner-only at the OS level.

---

## Database

### `nimbus db verify`

Run non-destructive integrity checks on the local index. Safe to run at any time.

```bash
nimbus db verify
nimbus db verify --json
nimbus db verify --json | jq -r '.findings[] | select(.status == "fail") | .label'
```

**Checks:** SQLite `integrity_check`, FTS5 consistency, `vec_items_384` rowid alignment, orphaned sync tokens, schema version match, foreign key integrity.

**Exit codes:** `0` = all pass, `1` = at least one finding. `--json` does not change them.

**`--json` shape.** `{ clean: boolean, findings: [{ label, status: "ok" | "fail", detail? }], exitCode: number }`. The gateway's pre-rendered human report is dropped, not embedded; `exitCode` is both reported in the document and applied to the process.

---

### `nimbus db repair`

Run targeted recovery actions for any findings reported by `nimbus db verify`. Writes a structured repair report to the audit log. `--yes` is **mandatory**, not a confirmation skip: there is no interactive prompt, and without the flag the command exits with `Usage: nimbus db repair --yes` — including under `--json`, which emits nothing in that case.

```bash
nimbus db repair --yes
nimbus db repair --yes --json
```

**`--json` shape.** The structured repair report: `{ outcomes: [{ action, status: "applied" | "skipped" | "error", detail? }], repairedAt: string }`, where `action` is one of `vec_orphan_delete` / `fts5_rebuild` / `orphaned_sync_tokens_delete` / `foreign_key_cascade_delete` and `repairedAt` is an ISO timestamp. The pre-rendered human report is dropped, not embedded.

**Repair actions:** Delete orphaned vec rows + re-queue resync, FTS5 rebuild, delete unrecoverable rows, remove orphaned sync tokens.

---

### `nimbus db snapshot`

Create a manual snapshot of the local index database.

```bash
nimbus db snapshot
```

The command takes no arguments and prints the path of the snapshot it wrote. Snapshots are stored under `<dataDir>/snapshots/`, named `nimbus-<epoch-ms>.db.gz`. (`<dataDir>/backups/` is a different directory — it holds the automatic pre-migration backups listed by `nimbus db backups list`.)

---

### `nimbus db restore <snapshot>`

Restore the index from a snapshot. The Gateway must be stopped first — the command refuses to run while a live Gateway process is detected. `<snapshot>` is a `.db.gz` **path**, resolved relative to the current directory and not looked up inside the snapshots directory, so paste the path column from `nimbus db snapshots list`. `--yes` is required to actually overwrite `nimbus.db`: without it the command prints the exact `--yes` invocation and exits `0` having changed nothing.

```bash
nimbus stop
nimbus db snapshots list
nimbus db restore <dataDir>/snapshots/nimbus-1776249000000.db.gz --yes
```

---

### `nimbus db snapshots list` / `nimbus db backups list`

List available snapshots and pre-migration backups.

```bash
nimbus db snapshots list
nimbus db backups list
```

---

### `nimbus db snapshots prune`

Delete old snapshots, keeping the most recent `--keep-last N` (default 7, clamped to 1–100). `--yes` is mandatory — without it the command exits with the usage line, and there is no interactive prompt. There is no `nimbus db prune`; it exits with `Unknown db subcommand: prune`. Pre-migration backups (`nimbus db backups list`) are not touched.

```bash
nimbus db snapshots prune --yes
nimbus db snapshots prune --yes --keep-last 10
```

---

## Index Maintenance

### `nimbus index add <path>`

Register a local git repository as a blame/index root without hand-editing `nimbus.toml`. The path is resolved to an absolute path and sent to the Gateway, which canonicalizes it, verifies it is an existing directory containing a `.git` entry, and persists it to `registered-roots.json`. The registered root is merged with the `[[filesystem.roots]]` TOML set on the next Gateway start (TOML wins on collision), at which point the git-commit, blame, and other filesystem syncables begin indexing it.

```bash
nimbus index add .
nimbus index add /path/to/repo
```

Output is `Registered blame root: <path>` for a new root, or `Already registered: <path>` if it was already present (idempotent).

**Security:** `filesystem.ensureRoot` is CLI-only — the `filesystem` namespace is in `FORBIDDEN_OVER_LAN` (invariant I5), so a remote peer can never register an indexing root on your machine. A path that is not an existing directory, or lacks a `.git` entry, is rejected (this structurally rejects roots like `C:\` or `/`).

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

### `nimbus index rebody`

Re-fetch indexed **depth** for rows that are missing some of it. The full-body store (schema **V48**) lifted the 512-character cap to 16 KiB for `PROSE_HEAVY_TYPES`, but only for connectors that were migrated to pass a declared-full `body:` — existing rows synced before that migration (or by a connector that has not been migrated) are left with `item.body_complete = 0`: text that is genuinely gone from the local index and can only be recovered by re-fetching from the source API. `rebody` works by **clearing a connector's sync watermark** (`scheduler_state.cursor`) and letting the existing sync run from scratch, so a real run is real outbound API traffic against a live connector, not a local recompute.

Bodies were the first kind of depth, and are no longer the only one. A row is **recoverable** when its body is incomplete **or** its service's `metadata.meta_v` is below the version that service is required to carry — `REBODY_REQUIRED_META_VERSION` in `packages/gateway/src/ipc/index-rebody-rpc.ts`, today `jira` and `linear` at version 1 (the ticket-depth contract: issue type, normalized `status_category`, and the created/resolved/due timestamps). The two reasons are reported **separately**, never summed: `pending`/`pendingBefore`/`pendingAfter` count missing bodies, `pendingMeta`/`pendingMetaBefore`/`pendingMetaAfter` count stale metadata. A row can be behind on both; they are two questions about the same rows, not a partition. A service with no entry in `REBODY_REQUIRED_META_VERSION` keeps body-only eligibility exactly as before.

```bash
nimbus index rebody --dry-run
nimbus index rebody --service slack --yes
nimbus index rebody --type issue --limit 3 --yes --json
nimbus index rebody --service jira --since 365 --yes
```

**Flags:**

| Flag | Required | Description |
|---|---|---|
| `--service <name>` | no | Restrict to a single connector service. |
| `--type <t>` | no | Restrict the dry-run candidate scan to one item `type` (does not itself limit which connector re-syncs — see Behaviour). |
| `--limit N` | no | Cap the number of connectors targeted by a real (non-dry) run; a malformed value is a hard error, not silently ignored, because it bounds how many connectors get an unbounded full-account network re-walk. |
| `--since <days>` | no | Widen the **cold-start** window a connector re-walks, for this run only. Honored by the connectors that read `SyncContext.historyFloorMs` — today `jira` and `linear`; **every other connector silently ignores it** and keeps its own `initialSyncDepthDays` (30). Like `--limit`, a malformed value is a hard error client-side, and a window reaching before 1970 is rejected by the gateway. Over 3650 days the CLI prints a typo warning but still honors the value. |
| `--dry-run` | no | Report per-service pending counts — missing bodies (`body_complete = 0`) and, separately, stale metadata — without clearing any watermark or making any network call. |
| `--yes` | yes (non-dry) | Confirmation gate; required for any non-`--dry-run` invocation. Omitting both `--dry-run` and `--yes` prints the planned action and exits without doing anything. |
| `--json` | no | Suppress progress/prose output; print the final summary as one JSON object. |

There is deliberately **no `--only-truncated` flag**. A sync fetches by page and time window, not by item id — no connector exposes a per-item fetch — so a flag that tried to target only the rows marked incomplete would suppress writes for already-complete items (free) while every API request still happened, saving zero rate-limit budget. It is not a planned follow-up; it is not implementable against the current connector contract.

**Behaviour:** invoking with **neither** `--dry-run` nor `--yes` makes **no IPC call at all** — it prints the planned flags (echoing `--service`/`--type`/`--limit`/`--since` if given) plus the same cost caveat shown below, then exits; it reports no pending counts, because it never asks the gateway for any. **`--dry-run`** does make the call (`{ ..., dryRun: true }`) and computes and returns the whole-index `pending` grouping by service (never scoped to `--service`/`--type` — those filters pick which connector(s) a real run targets, not which rows the summary counts) plus a `cannotImprove` list, without clearing any watermark or making any network call to a connector. A service lands in `cannotImprove` when it is not in `REBODY_IMPROVABLE_SERVICES` (`packages/gateway/src/ipc/index-rebody-rpc.ts`) — the inclusion list of services whose connector passes a declared-full `body:` for every item type it writes today. As of 2026-08-04, that list is thirteen services: `bitbucket`, `confluence`, `discord`, `github`, `gmail`, `jira`, `linear`, `notion`, `obsidian`, `outlook`, `slack`, `snyk`, `teams` — a service with a mixed migration state (e.g. `zoom`, which migrated `zoom:transcript` but not `zoom:meeting`; or the locally-generated `nimbus` bucket, which migrated `web_clip` and `research_brief` but not `glossary_term`) is deliberately left out, because `rebody`'s pending count is grouped by service only, not by `(service, type)`. An unmigrated or newly-added connector defaults to cannot-improve — an over-cautious warning, never a false promise. **`--yes`** (without `--dry-run`) runs for real: it clears the sync watermark for each targeted service (so a `forceSync` failure — rate limit, auth — still leaves the connector armed for its next scheduled tick, surfaced as a warning) and reports `pendingBefore`/`pendingAfter` plus `succeeded`/`failed` counts. An explicit `--service` (optionally narrowed by `--type`) is validated against the actual **recoverable** rows before anything is touched — a typo'd or unknown service, or a `--service`/`--type` combination with nothing recoverable **by body or by metadata version**, is rejected rather than silently spending API quota on a connector with nothing to recover.

**Cost is not proportional to the pending counts shown**, and the CLI prints this caveat on every dry run and every real run: most connectors resume from a bounded recent window even from a cleared watermark (e.g. Slack, Jira's cold-start JQL floor, or Confluence's cold-start CQL floor — the latter recovers roughly the last 30 days of page edits, not the whole wiki). Notion alone has no delta sync and re-walks the **entire** account regardless of how few items are actually pending — for it, `rebody` can be tens of thousands of requests to recover bodies for a handful of rows.

**`--since` and that bounded window.** The 30-day cold-start floor is exactly what makes a Jira or Linear backfill useless without `--since`: clearing the watermark re-walks only the last 30 days, so closed historical tickets are never revisited and their metadata stays stale forever. `--since <days>` hands the scheduler a one-shot absolute floor (epoch ms) that the connector uses **in place of** its own 30-day default — but only on a **cold start**. An established cursor is always more recent and always wins, so the floor cannot cause a re-walk on subsequent scheduled ticks. The floor is held **in gateway memory only** and is consumed by the first run that completes: a restart drops it (the safe direction — ask again rather than silently re-walking history forever), while a run that failed without advancing its watermark keeps it for the retry. When a real run with `--since` reports failed services, the CLI says both halves of this out loud.

**Exit codes:** `0` = run completed (dry or real, any number of per-service failures — see `failedServices` in `--json` output). `1` = fatal abort (malformed params, Gateway down).

---

### `nimbus index regraph`

Re-run the graph populator over every indexed item via `index.regraph`. Needed because a populator change only reaches existing rows when they next re-sync, and historical items may never re-sync. Threads the same service-identity resolver the live sync path uses, so `correlates_with` edges between resolver-bound deployments/incidents survive the backfill instead of being cleared. Idempotent — safe to re-run.

```bash
nimbus index regraph
nimbus index regraph --json
```

**Options:**

| Flag | Description |
|---|---|
| `--json` | Machine-readable JSON output (otherwise a one-line summary) |

**Output:** `regraph: scanned <n>, graphed <n>, skipped <n>` — `graphed` counts only items that actually wrote graph rows (not every item dispatched); `skipped > 0` prints a `WARN` to stderr pointing at the gateway log for per-item errors.

**Read-only relative to connectors:** no live API call — it re-derives graph edges from data already in the local index. It does write to the local database (`graph_entity` / `graph_relation`); no HITL.

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

Scaffold a new extension package from the `@nimbus-dev/sdk` template. The extension id is positional and the package is always created at `./<id>/` in the current working directory — there is no `--name` or `--output` flag (`--name` would be taken as the id and create a directory literally called `--name`).

```bash
nimbus scaffold extension my-connector    # creates ./my-connector/
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

### `nimbus workflow save <name> --file <path>`

Save a YAML script as a named reusable workflow pipeline. The **name is positional** and the file comes from the required `--file` flag; there is no `--name` flag. If the YAML declares a different `name:`, the CLI warns and saves under the name you passed.

```bash
nimbus workflow save weekly-cleanup --file ./weekly-cleanup.yml
nimbus workflow save weekly-cleanup --file ./weekly-cleanup.yml --description "Friday tidy-up"
```

`--description <text>` overrides the description parsed from the file.

---

### `nimbus workflow list`

List saved workflow pipelines.

```bash
nimbus workflow list
```

---

### `nimbus workflow run <name>`

Run a named workflow pipeline. Same engine and same flags as [`nimbus run`](#nimbus-run) — it executes immediately unless a preview is asked for; HITL gated.

```bash
nimbus workflow run weekly-cleanup
nimbus workflow run weekly-cleanup --dry-run    # Preview only
nimbus workflow run weekly-cleanup --no-ttv     # Preview first, abort if any step is flagged HITL; otherwise run
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

Query the cross-service people graph. Resolves identities across GitHub, GitLab, Slack, Linear, Jira, Notion, and more without a network call.

### `nimbus people list [--unlinked] [--limit N]`

List people in the graph. `--unlinked` restricts the output to identities that have not yet been merged into a person; `--limit N` caps the rows (default 100).

```bash
nimbus people list
nimbus people list --unlinked --limit 50
```

---

### `nimbus people search <query> [--limit N]`

Search the graph by name or handle. `--limit N` caps the rows (default 25).

```bash
nimbus people search elena
nimbus people search elena --limit 10
```

---

### `nimbus people get <id>`

Show the details for a single person.

```bash
nimbus people get person:abc123
```

---

### `nimbus people items <id> [--limit N]`

List the indexed items attributed to a person. `--limit N` caps the rows (default 50).

```bash
nimbus people items person:abc123
nimbus people items person:abc123 --limit 20
```

---

### `nimbus people link <id-a> <id-b>`

Merge two people: `id-b` is folded into `id-a` (`id-a` survives).

```bash
nimbus people link person:abc123 person:def456
```

---

## Clip (Web Clipper)

> The browser extension that pairs with these commands ships from its own repo,
> [nimbus-agent/nimbus-web-clipper](https://github.com/nimbus-agent/nimbus-web-clipper)
> (Chrome + Firefox, MV3). The `nimbus clip …` commands below manage the gateway-side
> pairing tokens it uses.

### `nimbus clip pair [--label <device>] [--scopes <a,b>]`

Open a browser-extension pairing session and print the one-time code **plus the gateway URL** to enter in the extension's Options page. The code expires after 2 minutes. `--label` gives the paired device a human-readable name; if omitted the gateway assigns one.

`--scopes` sets what the minted token is allowed to reach. It takes a comma-separated list drawn
from five names:

| Scope | Unlocks |
|---|---|
| `clip` | `POST /v1/clips` (save a clip) and `POST /v1/clips/related` (related-items read) |
| `briefs` | The research-briefs write routes (`POST /v1/briefs`, `.../sources`, `.../run`, `.../save`) and `GET /v1/briefs/*` |
| `agents` | The browser-reachable agent-invocation route: `POST /v1/agents/{agent}`, `GET /v1/agents/runs/{id}`, `GET /v1/agents` |
| `resolve` | The resolve-by-URL read: `GET /v1/items/resolve` |
| `fetch` | The targeted fetch-on-miss write: `POST /v1/items/fetch` — makes an outbound request through a configured connector, so it is a separate scope from `resolve`'s local-index-only read |

If `--scopes` is omitted, the minted token is granted `clip,briefs` — the two surfaces that shipped
before scopes existed. **A client paired before this change holds exactly `clip,briefs` and gains
nothing new automatically** — its token was minted (or is read back) as a bare string, which parses
as that same pair. Use `nimbus clip scopes` (below) to grant it more without re-pairing.

The scope set you pass here is what actually gets minted: it is recorded on the pairing window at
the moment you run this command and is not something the browser extension can influence when it
redeems the code.

The printed URL is the gateway's loopback HTTP origin (`http://127.0.0.1:<port>`), derived from `NIMBUS_HTTP_PORT`. If the gateway is running without the HTTP surface, the command instead warns you to restart it with `nimbus serve --port 7474` — without that surface the extension has nothing to reach.

```bash
nimbus clip pair
nimbus clip pair --label work-chrome
nimbus clip pair --label work-chrome --scopes clip,briefs
```

```text
Pairing "work-chrome" — in the browser extension's Options page, enter:
  Gateway URL:  http://127.0.0.1:7474
  Pairing code: 429040
Enter it within 2 minutes.
```

---

### `nimbus clip scopes <label> --set <a,b>`

Change a paired client's scopes in place — no re-pairing, no new token. `<label>` must match an
existing paired device (see `nimbus clip status`); `--set` takes the same comma-separated scope list
as `pair --scopes` above and replaces the label's scope set entirely (it is not additive).

This is how a client paired before scopes existed picks up `agents`/`resolve`/`fetch` once a route
consumes them, or how you narrow an over-broad grant without disrupting the device's existing token.

```bash
nimbus clip scopes work-chrome --set clip,briefs,agents
```

```text
Scopes for "work-chrome" are now: clip,briefs,agents
```

---

### `nimbus clip list [--tag <t>] [--limit N] [--json]`

List saved web clips, newest first. `--tag` filters to clips carrying that exact tag
(matched in SQL, so `--limit` stays correct). `--limit` defaults to 50 (invalid values fall
back to the default). `--json` emits structured rows (`id, title, url, clippedAt, tags, mode,
wordCount`) for scripting.

```bash
nimbus clip list
nimbus clip list --tag rust --limit 20
nimbus clip list --json
```

---

### `nimbus clip delete <id|url>` / `nimbus clip delete --all [--yes]`

Delete clips. A `nimbus:` argument is treated as a clip ID (from `clip list`); anything else
is treated as a page URL and every clip from that page (the article plus any text selections)
is removed. `--all` clears every clip but is guarded: without `--yes` it only reports how many
would be deleted. Deleting a missing id/url is idempotent (`Deleted 0 clips.`).

```bash
nimbus clip delete https://blog.example.com/rust-async
nimbus clip delete nimbus:clip:abc123…
nimbus clip delete --all --yes
```

---

### `nimbus clip status`

List all paired browser devices — shows each device's label, its token fingerprint (never the raw
token), and its granted scopes, plus whether research briefs are enabled.

```bash
nimbus clip status
```

```text
  work-chrome   3f9a1c2e...   clip,briefs
briefs: enabled
```

---

### `nimbus clip revoke <label|--all>`

Revoke a specific paired device's token by label, or revoke all paired devices with `--all`.

```bash
nimbus clip revoke work-chrome
nimbus clip revoke --all
```

---

## Vault

### `nimbus vault set <key> <value>`

Store a secret in the Vault under the given key.

```bash
nimbus vault set github.pat ghp_xxxx
```

---

### `nimbus vault get <key>`

Retrieve and print a Vault secret. Because the value echoes to the terminal, the command first prompts `Secrets echo to this terminal. Continue?` and prints nothing if you decline.

```bash
nimbus vault get github.pat
```

---

### `nimbus vault list [prefix]`

List Vault key names (never values). Keys are scoped per connector and per profile. An optional `prefix` filters the listing.

```bash
nimbus vault list
nimbus vault list github          # Only keys starting with "github"
```

The single positional argument is the prefix filter — there is no `--profile` flag (passing one would be read as the prefix and match nothing). Profile scoping comes from `NIMBUS_PROFILE` or `nimbus profile switch`.

---

### `nimbus vault delete <key>`

Delete a specific Vault entry. Use `nimbus connector remove` for full connector cleanup.

```bash
nimbus vault delete github.pat
```

---

## Audit

### `nimbus audit`

Show the local audit log. Every action the agent takes — including every HITL decision — is recorded here before execution.

```bash
nimbus audit
nimbus audit --limit 100
nimbus audit --json
nimbus audit --limit 100 --json | jq -r '.[] | select(.hitlStatus == "rejected") | .actionType'
```

`--limit` (default 50) and `--json` are the only flags parsed. There is no `--service` or `--since` **filtering** here — such arguments are silently ignored, and the most recent `--limit` rows are returned regardless; `--json` changes the rendering only, never the row set.

**Columns:** `Timestamp`, `Action`, `Status` (`approved` / `rejected` / `not_required`), `Reason` (the HITL reject reason from `action_json`; `—` when absent).

**`--json` shape.** A JSON array of the raw `audit.list` rows: `{ id, actionType, hitlStatus, actionJson, timestamp }`, newest first, honouring `--limit` (default 50). `actionJson` stays the **string** the chain stored — it is not parsed for you, so a row whose payload is malformed still appears rather than being dropped; the human table's "Reason" column is that string's `hitlRejectReason` field. `--json` applies to the listing only; `nimbus audit verify` and `nimbus audit export` have their own output contracts.

---

### `nimbus audit verify`

Verify the BLAKE3 chain integrity of the audit log. Each row stores `row_hash = BLAKE3(prev_hash || canonical_row_bytes)`; this command walks the chain and reports the first break, if any.

```bash
nimbus audit verify              # Verify chain since the last successful checkpoint
nimbus audit verify --full       # Verify the entire chain from row 1
```

`--full` is the only flag `audit verify` reads; there is no `--since` / row-id start.

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

## Share & Virality

Export, verify, and forward signed session snapshots and recipe DAGs. All outbound shares leave the machine through the share-gate (`share.create` / `share.publish` HITL action, invariant `I27`). Forwarding re-routes an existing share to a federation peer; the inner body and origin signature are never altered (the forwarder appends its own hop signature). Inbound shares are viewable artifacts only — never auto-merged or auto-executed (invariant spec §9.4).

### `nimbus share create <session-id> [--out <file>] [--http] [--to-peer <peerId>] [--expires <dur>] [--redact <field>]... [--as-recipe]`

Create and emit a signed share for a session. Requires your HITL approval before the share leaves the machine. The HITL preview shows the exact redacted content that will be exported.

```bash
nimbus share create sess_abc123 --out ./share.json
nimbus share create sess_abc123 --http
nimbus share create sess_abc123 --to-peer peer_xyz --expires 7d
nimbus share create sess_abc123 --as-recipe --out ./recipe.json
```

**Flags:**

| Flag | Description |
|---|---|
| `--out <file>` | Write the share to a local file |
| `--http` | Emit to the configured HTTP sink |
| `--to-peer <peerId>` | Send directly to a paired federation peer |
| `--expires <dur>` | Expiry duration: `30s`, `5m`, `2h`, `7d`, etc. |
| `--redact <field>` | Redact a field from the share body (repeatable) |
| `--as-recipe` | Emit a declarative V42 recipe DAG instead of a transcript |

---

### `nimbus share list [--all]`

List share records in the local store. Without `--all`, expired shares are excluded.

```bash
nimbus share list
nimbus share list --all
```

---

### `nimbus share prune`

Delete all expired share records from the local store.

```bash
nimbus share prune
```

---

### `nimbus share pubkey`

Print this gateway's Ed25519 share-signing public key (base64). Recipients can use this to verify the origin signature on shares you send.

```bash
nimbus share pubkey
```

---

### `nimbus share approve <request-id>` / `nimbus share reject <request-id>`

Respond to a pending HITL share-approval request. The `request-id` is printed when a share is created and shown in the TUI consent panel.

```bash
nimbus share approve req_abc123
nimbus share reject req_abc123
```

---

### `nimbus share forward <contentHash> --to-peer <peerId>`

Forward an already-emitted share (identified by its content hash) to a federation peer. Requires your HITL `share.publish` approval before the forwarded envelope leaves the machine. The inner body and origin signature are byte-identical across all hops; the forwarder appends only its own hop signature. `federation.shareForward` is local-only and cannot be triggered over LAN by a remote peer (invariant global-constraints §8).

```bash
nimbus share forward sha256:abc123 --to-peer peer_xyz456
```

Prints `delivered <contentHash>` when the peer accepted immediately, or `queued <contentHash>` when the peer is offline and the share will be retried.

---

### `nimbus share inbox [--all]`

List inbound forwarded shares received from federation peers. Each row shows a provenance attribution chip, the content hash, and the share kind. Without `--all`, only unread/unacknowledged shares are shown.

```bash
nimbus share inbox
nimbus share inbox --all
```

**Example output:**

```text
forwarded from alice, 2 hops away  sha256:abc123  transcript
from bob (direct)                  sha256:def456  recipe
```

---

### `nimbus verify-share <file|url> [--replay] [--allow-unsigned]`

Verify the Ed25519 signature and content hash of a share file or URL. With `--replay`, re-execute the session steps against the current local index and compare results.

```bash
nimbus verify-share ./share.json
nimbus verify-share https://example.com/share.json --replay
```

Prints `signature: VALID` or `INVALID`, plus expiry status. With `--replay`, also prints a per-step divergence report and a summary.

**Replay refuses an unverifiable share.** A share file is untrusted input: replay executes the tool calls it names against your live, credentialed connectors. So if the signature, content hash or expiry check fails, `--replay` aborts before any outbound call and exits non-zero. `--allow-unsigned` overrides that, and should be used only for a share you produced yourself.

Two further limits apply to replay, both reported rather than silent: only tools whose id ends in a recognised read verb are executed (anything else is reported `skipped-non-read`), and no more than 256 steps run per replay — any excess is printed as "further step(s) were NOT executed".

---

## LAN Remote Access

Encrypted, relay-free remote access between machines on the same network. Disabled by default (`[lan] enabled = false` in `nimbus.toml`). Enable via `nimbus config set lan.enabled true`.

All traffic is E2E encrypted with NaCl box (X25519 DH + XSalsa20-Poly1305). A set of exfiltration- and management-class methods is forbidden over LAN regardless of peer grants (`FORBIDDEN_OVER_LAN` in `packages/gateway/src/ipc/lan-rpc.ts`, invariant I5) — forbidden namespaces include (but are not limited to) `vault.*`, `updater.*`, `lan.*`, `profile.*`, `audit.*`, `data.*`, `security.*`, `chatops.*`, `tribal.*`, `team.*`, `teamvault.*`, `hitl.*`, `identity.*`, and `scim.*`, plus the full-method forbids `connector.addMcp`, the `extension.*` management methods, `index.reembed` / `index.reembedCancel`, the federation management/asker methods (`federation.discover` / `pair` / `peers` / `namespace.*` / `consentRespond` / `ask*`), and the share owner-action chokepoints `share.create` / `share.prune` / `share.approvalRespond` (the I27 outbound-publish gate). The read-only share methods (`share.verify` / `list` / `get` / `pubkey`) and the answering methods `federation.query` / `federation.expertise` / `federation.invoke` (gated by I17 / I19) stay admitted.

### `nimbus lan status`

Show LAN server state: whether LAN is enabled, whether a pairing window is open, and the listen address. This is the default subcommand (`nimbus lan` with no argument runs `status`).

```bash
nimbus lan status
```

---

### `nimbus lan open`

Open a 5-minute pairing window and print a one-time pairing code (with its expiry). A peer pairs against this window using the code.

```bash
nimbus lan open
```

---

### `nimbus lan close`

Close the active pairing window early.

```bash
nimbus lan close
```

---

### `nimbus lan peers`

List all paired peers with their ID, write-allowed flag, and display name.

```bash
nimbus lan peers
```

---

### `nimbus lan grant <peerId>`

Allow a peer to call write and HITL-gated methods. Read-only by default after pairing.

```bash
nimbus lan grant abc123
```

---

### `nimbus lan revoke <peerId>`

Remove a peer's write grant. They remain paired but are restricted to read-only methods.

```bash
nimbus lan revoke abc123
```

---

### `nimbus lan remove <peerId>`

Unpair a peer. Their stored public key is deleted; any active session is terminated.

```bash
nimbus lan remove abc123
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
| `NIMBUS_TELEMETRY_ENABLED` | Override `[telemetry].enabled` |
| `NIMBUS_TELEMETRY_ENDPOINT` | Override `[telemetry].endpoint` |
| `NIMBUS_CONFIG_DIR` | Override the platform config directory — **config only**. There is no data-directory override: the data directory is not relocatable by any `NIMBUS_*` variable (on Linux it follows `XDG_DATA_HOME`). |
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
| `NIMBUS_EXTENSIONS_REGISTRY_URL` | Extension registry base URL; the auto-update polling daemon is only constructed when this is set |
| `NIMBUS_EXTENSIONS_DISABLE_AUTO_UPDATE` | Set to `1` to hard-disable the extension auto-update polling daemon at Gateway init |
| `NIMBUS_LAN_PORT` | Override the LAN TCP listen port (default: `7475`) |
| `NIMBUS_DEV_UPDATER_PUBLIC_KEY` | Override the embedded Ed25519 updater public key — for tests only |

---

## Platform Notes

| Platform | IPC Socket | Config Dir | Data Dir |
|---|---|---|---|
| Windows 10+ | `\\.\pipe\nimbus-gateway` | `%APPDATA%\Nimbus` | `%LOCALAPPDATA%\Nimbus\data` |
| macOS 13+ | `$TMPDIR/nimbus-gateway.sock` | `~/Library/Application Support/Nimbus` | `~/Library/Application Support/Nimbus` (same root as the config dir — there is no `/data` segment) |
| Ubuntu 22.04+ | `$XDG_RUNTIME_DIR/nimbus-gateway.sock` (falls back to the OS temp dir) | `~/.config/nimbus` | `~/.local/share/nimbus` |

---

## See Also

- [`README.md`](./README.md) — Quick start and overview
- [`architecture.md`](./architecture.md) — Subsystem design and data flow
- [`roadmap.md`](./roadmap.md) — Phase acceptance criteria and sequencing
- [`SECURITY.md`](./SECURITY.md) — Security model and vulnerability reporting
- [`docs/contributors/extension-author-walkthrough.md`](./contributors/extension-author-walkthrough.md) — Writing a connector extension
