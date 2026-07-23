# Stage 2 — Re-cut the VS Code surface for the ICP (design)

**Date:** 2026-07-23 · **Status:** approved · **Owner repo for the work:** `nimbus-vscode` (plus a read-only spike against the gateway index)

Authoritative context: [`docs/ecosystem-roadmap.md`](../../ecosystem-roadmap.md) Stage 2. Stage 1 is
complete (2026-07-23): `@nimbus-dev/client` 0.11.0 exposes 52 methods. This spec covers consuming
that surface in `nimbus-vscode` and the deliberately-selected Stage 2 items: **2e-core, 2d, 2c, 2b
in full, plus a de-risk spike for 2a**. Scope was chosen against the roadmap's own framing: 2e
fixes a silent bug, 2d is a large multiplier for ~zero new RPCs, and 2a's headline value is
data-dependent and unproven (roadmap Open Decision #3).

## Verified starting facts

- `nimbus-vscode/package.json` pins `"@nimbus-dev/client": "^0.6.0"`. On 0.x a caret does not
  cross minors, so the extension sees **none** of Stage 1 today. The bump is the unblock.
- The extension calls 13 client methods. Two are the hacks Stage 1 exists to delete:
  `client.querySql(SESSIONS_SQL)` (`src/extension.ts:440`) and a local `listSessions` wrapper
  (`src/extension.ts:457`) — the code comment itself says *"switch to client.listSessions() once
  the client exposes one"*. Wave 1d shipped `session.*`; the client method is `sessionList()`.
- `capabilities.untrustedWorkspaces` and `extensionKind` are **undeclared**, so VS Code disables
  the extension entirely in a Restricted-Mode workspace, with no explanation.
- The `nimbus.statusBarPollMs` setting description says it polls *connector health*, but the poll
  only drives the egress badge (`egressHead`). The description is currently a lie.
- Open gateway issues [#809] (`connector.configChanged` unexposed), [#810] (`workflow.run` stream
  chunks unconsumable), [#812] (ipc test flake) do **not** block any selected item.

## Deliverables (5 PRs + 1 spike)

### PR 1 — Consumption (`nimbus-vscode`)

The mandatory unblock, scoped opportunistically:

- Bump `@nimbus-dev/client` to `^0.11.0`.
- Sessions view: replace `querySql(SESSIONS_SQL)` + the local `listSessions` wrapper with
  `sessionList()`; delete `SESSIONS_SQL`.
- Wire `gatewayPing()` into connection health and the Troubleshoot Connection command.
- Status bar: add a connector-health segment fed by `connectorListStatus()` on the existing
  `statusBarPollMs` cadence — making the setting's description true.
- Guard test: assert `querySql(` appears nowhere in `src/` so the hack cannot return
  (assert on the call shape, not the bare identifier).

Explicitly **not** here: built-in brief agents in the sidebar — they land with 2b, where they are
the engine.

### PR 2 — 2e-core: native-feel correctness (`nimbus-vscode`)

- `capabilities.untrustedWorkspaces: { supported: "limited" }` with `restrictedConfigurations`
  for the two dangerous settings: `nimbus.socketPath` (redirects the IPC target) and
  `nimbus.autoStartGateway` (spawns a process).
- `extensionKind: ["ui"]` — the gateway daemon lives on the user's local machine, so in
  SSH/remote/container scenarios the extension must run on the client side.
- `viewsWelcome` for all five sidebar views: the gateway-down state renders "Start Gateway" /
  "Troubleshoot" buttons instead of blank boxes.

Deferred from 2e (deliberately): `TreeView.badge`, `FileDecorationProvider`, chat participant
`followupProvider` / `onDidReceiveFeedback` / `disambiguation`.

### PR 3 — 2d: Language Model tool registration (`nimbus-vscode`)

- `contributes.languageModelTools` + `vscode.lm.registerTool` — both in stable `@types/vscode`
  at the existing `^1.95.0` engines floor: no engines bump, no proposed-API flag.
- Two tools to start:
  - `nimbus_search` — ranked local-index search via `searchRanked`.
  - `nimbus_ask` — one-shot grounded answer via `askStream`, collected to a string.
- Tool descriptions written in the ICP's vocabulary (private incident / CI / PR context the
  cloud assistant cannot see). More tools follow demand, not speculation.

### PR 4 — 2b: ops vocabulary (`nimbus-vscode`)

- Chat participant commands: **replace** `/explain` `/fix` `/test` with `/incident`, `/deploys`,
  `/owns`, `/blast` (roadmap-intended; the old three survive as quick-ask presets).
- Where a built-in brief agent is the right engine, use it: `/blast` → `agentsImpact`,
  `/owns` → `agentsExpert`, `/incident` → `agentsCatchup`; `/deploys` → `metricsDora` plus recent
  deploy/`ci_run` items from the index.
- Quick-ask presets keyed to file type: `*.tf`, k8s/helm YAML, `Dockerfile`,
  `.github/workflows/*` — e.g. *"What breaks if I apply this?"*, *"Who owns this service?"*.

### PR 5 — 2c: egress receipts (`nimbus-vscode`)

- Per-answer footer in chat: `egressHead` before/after each answer → ledger-delta line
  ("N rows appended · chain verified").
- "Prove window" exports a **self-contained offline verifier** (single file: verifier + embedded
  window JSON), not just raw JSON.
- "Prove this PR": opt-in signed `Nimbus-Egress-Proof` trailer appended by Generate Commit
  Message (via `egressProveWindow`).
- Blocked/denied rows rendered distinctly in the Egress view — proof-of-denial as a first-class
  artifact.

### Spike — 2a data quality (read-only, no PR)

Against the live local index: measure `git_blame_line` (V32) coverage, blame→PR→issue join
rates, and Slack/incident linkage. Deliverable is a findings report with a build / don't-build
recommendation for the hover lens, feeding roadmap Open Decision #3. No UI work until the data
supports the hover experience.

## Sequencing

PR 1 first (everything else assumes 0.11.0) → PR 2 → PR 3 → PR 4 → PR 5. The spike runs in
parallel at any point. Each PR: worktree branch `dev/asafgolombek/<topic>`, `bun install` first
in a fresh worktree, full preflight before the first push. The user merges; the agent opens.

## Risks / decisions taken

- **2b replaces the Copilot three** — a user-visible change for existing installs; approved
  explicitly, and the old prompts remain reachable as quick-ask presets.
- **`extensionKind: ["ui"]`** is a judgment call: it privileges the local-gateway topology over
  remote-workspace file access. The extension reads workspace state only through VS Code APIs
  (selection text, SCM diffs), which work from the UI host.
- **LM tools hand context to Copilot** — the roadmap names this trade ("hands the relationship
  to Microsoft; does not create installs"); accepted because it multiplies value per install and
  Stage 3 owns installs.

[#809]: https://github.com/nimbus-agent/Nimbus/issues/809
[#810]: https://github.com/nimbus-agent/Nimbus/issues/810
[#812]: https://github.com/nimbus-agent/Nimbus/issues/812
