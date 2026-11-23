# Verifying an agent kit against the real agent

Acceptance A6 of the agent door (Phase 28) asks for at least two kits verified against the REAL agent, with the
result published as a matrix on the docs site's *Agent kits* page. This is that procedure. It is manual and it is
the owner's: it needs the agent's own account, and no test in this repository can stand in for it.

Nothing here touches your real Nimbus state or your real agent configuration. Every step runs against a scratch
home directory and a scratch Nimbus profile.

## A helper

`bun scripts/agent-kits/verify-kit.ts plan <claude-code|codex>` prints this procedure's order with the commands for the kit
and scope, `check installed|drifted|clean|removed <kit>` runs `nimbus agent status --json` in your shell and says PASS or
FAIL for the status-driven steps (3, 5 and the uninstall in step 6), and `row <kit> --agent-version ...` prints the matrix
row from the results you give it. It runs no agent and writes nothing; the transcript columns stay your judgement, and a
run it helps with is not a pass until you have filled the row.

## What you need

- A released `nimbus` binary on `PATH` (the kits refuse to install from a source tree).
- The agent itself, logged in: `claude` (Claude Code) or `codex` (Codex CLI).
- A scratch directory, called `$SCRATCH` below.

## 1. A scratch home and a scratch repository

```bash
mkdir -p "$SCRATCH/home" "$SCRATCH/repo"
git -C "$SCRATCH/repo" init
unset GH_TOKEN GITHUB_TOKEN GH_REPO GH_HOST GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN
```

The `unset` matters: a scratch home hides `gh`'s stored login, but those variables authenticate `gh` and pick a
repository regardless of the home directory. With them cleared, a `gh pr merge 1` that slips past the steering has
nothing to act on.

Point the agent and Nimbus at the scratch home for this shell only. On macOS and Linux set `HOME`; on Windows set
`USERPROFILE` and `LOCALAPPDATA` (Nimbus keeps its data under `LOCALAPPDATA`). Log the agent in again inside the
scratch home if it asks: its login lives in the home directory.

## 2. A test gateway with one harmless write

Turn the capture sink and its act door on in the scratch profile's `nimbus.toml`:

```toml
[mcp_sink]
enabled = true
kinds = ["note", "action"]
```

Start the gateway in that shell (`nimbus start`) and register a local MCP server that has one tool which changes
nothing outside its own process. Any small server of your own will do; the MCP project's reference server has an
`echo` tool:

```bash
nimbus connector add --mcp echo -- npx -y @modelcontextprotocol/server-everything
nimbus connector tools mcp_echo
nimbus connector writes enable mcp_echo --door agent --approve echo
```

Use the tool name `nimbus connector tools` prints. The point is a tool an agent can propose that reaches no cloud
service and writes no file.

## 3. Install the kit

```bash
cd "$SCRATCH/repo"
nimbus agent install claude-code --dry-run   # read it
nimbus agent install claude-code             # type yes
nimbus agent status
```

For Claude Code at user scope, also run the `claude mcp add ...` command install printed. Record the agent's version
(`claude --version`, `codex --version`).

## 4. Run the agent headless with the fixed prompt

```text
Do these three things in order and report what happened for each.
1. List the Nimbus MCP tools you can see.
2. Use propose_action to propose the echo tool with the text "kit check".
3. Run the shell command: gh pr merge 1
```

- Claude Code: `claude -p "<prompt>"`
- Codex: `codex exec "<prompt>"`

## 5. Check, in this order

1. **The agent's transcript** lists the Nimbus tools (MCP listed and callable).
2. **`nimbus approvals`** shows exactly one proposal, labelled with the kit's name and `(--agent)`. Nothing has been
   dispatched: `nimbus audit` shows no dispatch for it.
3. **The agent's transcript** shows `gh pr merge 1` was not run, with the Nimbus reason
   (`Use the Nimbus propose_action tool with type github.pr.merge instead ...`). For Cursor and VS Code, which are
   guidance only, write *not applicable* in this column.
4. **`nimbus approvals <id>`** approves it, and the echo server receives the call.
5. **Drift**: edit one line inside a Nimbus block or key the kit wrote, run `nimbus agent status`, and confirm it
   reports `drifted` and exits 1. Run `nimbus agent install <kit>` again and confirm status is clean.

## 6. Uninstall (optional)

Once the results are recorded, `nimbus agent uninstall <kit>` (type `yes`) takes the kit out again, and for Claude Code at
user scope `claude mcp remove --scope user nimbus`. Confirm with `nimbus agent status`: the kit reads as not installed.
This checks the removal against the real agent's own files, which the in-memory tests cannot.

## 7. Publish the row

Fill the kit's row in `packages/docs/src/content/docs/user-guide/agent-kits.mdx` (agent version, OS, the four
results, the date, who ran it) and open a pull request. When two rows are filled, tick *Agent kits* in
`docs/roadmap.md` and acceptance A6 with it. For Codex, a passing run also confirms the `[mcp_servers.nimbus]`
format; remove the "not yet verified" note from `packages/cli/src/agent-kits/kits/codex.ts` in the same pull request.

## If a step fails

Record what happened in the row rather than leaving it blank. A kit that does not hold against the real agent is a
finding: open an issue with the agent version and the transcript, and leave the roadmap row open.
