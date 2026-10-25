# Parallel session prompts (2026-10-25)

Each block below is a self-contained prompt for a NEW Claude Code session, started from `C:\gitrep\Nimbus`. They run alongside role-packs P2 PR 2b, which another session is implementing on `dev/asaf/role-packs-p2-glossary`.

**Do not touch while PR 2b is open:** `packages/gateway/src/glossary/`, `sources/`, `agents/glossary.ts`, `agents/_lib/tour-selectors.ts`, `fleet/fleet-sweep-enumerators.ts`, `embedding/routing.ts`, `packs/pack-prompt.ts`, and the glossary wiring in `platform/assemble.ts`. Prompt 1 says where it may need to.

Every prompt includes the shared review block below. Paste it where a prompt says **[REVIEW BLOCK]**.

---

## Shared review block (Antigravity CLI)

```
Independent review with the Google Antigravity CLI (`agy`, on PATH).

Headless `agy` auto-DENIES shell commands, so never ask it to run git. Give it a read-only file bundle instead:
1. In your scratchpad, make a fresh dir `agy-bundle-<stage>`. Fill it with:
   - `git archive <base-ref> <paths the work touches> | tar -x -C <bundle>` (base-ref = origin/main for a spec or plan, your branch HEAD for the end result)
   - copies of the spec/plan under `<bundle>/plan/`
   - for the end-result stage, `git diff origin/main...HEAD > <bundle>/branch.diff`
   - a `callers.txt` from `git grep -n` over every symbol whose signature changes
2. From inside the bundle run:
   `agy -p "<review prompt>" --mode plan --print-timeout 900s > <scratchpad>/agy-<stage>-review.md`
   Run it in the background and wait for the notification. The review prompt must say:
   - "Do NOT edit, create or delete files or run commands; only read files in this directory."
   - what the files are;
   - what to check (spec coverage, wrong paths/line refs, missed callers, correctness traps, contradictions);
   - "Output numbered findings with Critical/Important/Minor severity, file:line evidence and a concrete fix; skip praise."
3. Verify EVERY finding against the real code before acting. Fix the real ones. Rule on the rest.
4. Save the review next to the reviewed doc as `<name>-review.md`, with a "Disposition" table appended (finding → fixed/deferred/declined + why). Commit it with the doc. For the end result, put the disposition in the PR description instead.

Run the review three times: on the spec (before the plan), on the plan (before execution), and on the finished branch (after the final review, before opening the PR).
```

---

## Prompt 1 — Role packs P2 PR 3: Google Docs text + PM pack 1.1.0

```
Role packs Project 2, PR 3 of 3: Google Docs text and PM pack 1.1.0.

Read first:
- The design is § 8 and § 9 item 3 of `docs/superpowers/specs/2026-10-25-role-packs-p2-source-mapping-design.md` (+ `-review.md`), on branch `dev/asaf/role-packs` (worktree `C:\gitrep\Nimbus\.claude\worktrees\role-packs`). § 11 lists what is left to the builder:
  - the Docs export cap,
  - PROSE_HEAVY vs local-only for Docs,
  - the `doc` row id scheme.
- Memory: `role-packs-workstream.md`.

Already merged:
- PR 1 kinds: #1772.
- PR 2a mappings + decisions: #1774, `sources/source-mapping.ts`, V74.
- PR 2b, the glossary side, is IN PROGRESS in another session on `dev/asaf/role-packs-p2-glossary`.

Rules:
- Specs and plans live ONLY on `dev/asaf/role-packs`. Never put `docs/superpowers/**` on an implementation branch.
- Use the project skills `nimbus-connector-authoring`, `nimbus-index-body-depth` and `nimbus-embedding-routing`.
- Remember that the connectors live in the nimbus-mcp-servers repo while sync and indexing stay here.
- Never name `readwise` in a production example. `scripts/structure-audit/readwise-unbundled.acceptance.test.ts` allows it in three files only.

Steps:
1. **Spec review.** Re-read § 8 against the current code. Run [REVIEW BLOCK] on § 8 of the spec, and fix the spec on `dev/asaf/role-packs` before planning.
2. **Plan.** Write the plan with superpowers:writing-plans at `docs/superpowers/plans/<date>-role-packs-p2-pr3-google-docs.md` on `dev/asaf/role-packs`. Run [REVIEW BLOCK] on the plan, fix it, then ask me to approve the plan and pick an execution method.
3. **Branch.** Create the implementation worktree from origin/main with an ABSOLUTE path:
   `git worktree add C:/gitrep/Nimbus/.claude/worktrees/role-packs-p2-docs -b dev/asaf/role-packs-p2-docs origin/main`
4. **PR 2b overlap.** If PR 2b has not merged when you need `sources/source-kinds.ts` (a new built-in `google_drive:doc`) or `embedding/routing.ts` (Docs routing), wait for it, or rebase after it merges. Do not edit those files on a branch that would conflict with an open PR 2b.
5. **Finish.**
   - Execute the plan. Before the PR, run: `bun run preflight:fast`, `bun run typecheck:tests` (0 new), the whole `bun test packages/gateway/src`, and `bun test scripts`.
   - Run [REVIEW BLOCK] on the finished branch.
   - Push, then open the PR with auto-merge (`gh pr merge <n> --squash --auto`).
   - Monitor it: after each push, check for failing checks and new CodeRabbit threads.
```

---

## Prompt 2 — Role packs Project 5: onboarding (design)

```
Role packs Project 5: onboarding. This is the last of the five projects.

Read first:
- The overview spec `docs/superpowers/specs/2026-10-21-role-packs-overview-design.md` (+ `-review.md`), § 5 Project 5, on branch `dev/asaf/role-packs` (worktree `C:\gitrep\Nimbus\.claude\worktrees\role-packs`).
- The finished specs for P1, P3 and P4 in the same folder. Reuse their decisions; don't relitigate them.
- Memory: `role-packs-workstream.md`, `nimbus-wow-workstream.md` (`nimbus init` and the tour) and `nimbus-demo-workstream.md`.

Rules:
- Specs and plans live ONLY on `dev/asaf/role-packs`.
- This session produces a design spec and then a plan. No implementation until I approve.
- Don't touch PR 2b's files (glossary, sources). It is open in another session.

Steps:
1. **Brainstorm.** Use superpowers:brainstorming. Ask me about the onboarding moment I have in mind, and how it relates to `nimbus init`, `nimbus wow`, `nimbus demo`, the role packs and the desktop app.
2. **Spec.** Write it at `docs/superpowers/specs/<date>-role-packs-p5-onboarding-design.md`. Run [REVIEW BLOCK] on it. Fix what's real, append the disposition table, commit and push on `dev/asaf/role-packs`, then hand it to me for approval.
3. **Plan.** Once I approve, write the plan with superpowers:writing-plans, run [REVIEW BLOCK] on it, fix it, and ask me for approval and an execution method.
4. **Finish.** If you implement: before the PR, run `bun run preflight:fast`, `typecheck:tests`, the whole `bun test packages/gateway/src` and `bun test scripts` (and `packages/ui` vitest if the desktop is touched). Run [REVIEW BLOCK] on the finished branch, push, open the PR with auto-merge, and monitor it.
```

---

## Prompt 3 — Add obsidian to the connector catalog (MCP act-door follow-up)

```
Close the known gap from the S3 MCP act door. `obsidian.note.append` is denied as `unroutable` because `obsidian` is missing from the connector catalog: from the tool-map SERVICE_IDS and from CONNECTOR_SERVICE_IDS.

Read first:
- Memory `s3-mcp-capture-sink-workstream.md` (the "obsidian catalog" follow-up, and the lesson that tool names are NOT derivable from action types: `obsidian.note.append` → `obsidian_append_to_daily_note`).
- `packages/gateway/src/connectors/proposable-actions.ts` and its tests.
- `connectors/connector-catalog.ts`.
- The project skill `nimbus-mcp-sink`.

Rules:
- This is a small change. Write the spec as a short design note in the PR description, not a spec file.
- The plan can live inline in this session.
- Counts are test-enforced: the proposable/denied/HITL numbers appear in prose in CLAUDE.md, GEMINI.md and `.claude/commands/nimbus-mcp-sink.md`. Re-derive the enumerations, not just the totals.
- Obsidian is a LOCAL_ONLY_SYNC_SERVICES connector. Check what adding it to the catalog changes for sync egress (I29), `nimbus prove`, `nimbus connector list` and the readwise-style acceptance tests.
- Don't touch PR 2b's files.

Steps:
1. **Note and review.** Write the design note (what changes, which tables, which counts). Run [REVIEW BLOCK] on it with the relevant files bundled. Fix it.
2. **Branch.** `git worktree add C:/gitrep/Nimbus/.claude/worktrees/obsidian-catalog -b dev/asaf/obsidian-catalog origin/main`
3. **Implement with TDD.** Prove routing through the REAL dispatcher over mesh-shaped keys, not a fake.
4. **Finish.**
   - Before the PR, run `bun run preflight:fast`, `typecheck:tests`, the whole `bun test packages/gateway/src` and `bun test scripts`.
   - Run [REVIEW BLOCK] on the finished branch.
   - Push, then open the PR with auto-merge.
   - Monitor it: failing checks and CodeRabbit threads after each push.
```

---

## Prompt 4 — Distribution Gate 1 on Windows (and prep for macOS)

```
The distribution program's next step is Gate 1 on Windows and macOS. Gate 1 means the documented install one-liner works on a clean machine and the wedge command (`nimbus why <file>:<line>`) produces a real answer. Linux passed on 2026-08-13, after #1167/#1168/#1169.

Read first:
- Memory: `distribution-program-workstream.md`, `launch-execution-first-run.md`, `released-first-run-gate-workstream.md` and `nimbus-acceptance-sandbox-via-localappdata.md`.
- `docs/superpowers/specs/2026-08-19-nimbus-distribution-program-design.md`, on branch `dev/asafgolombek/distribution-program` (worktree `.claude/worktrees/distribution-program`).

Rules:
- This is an ACCEPTANCE run on my real Windows machine, so isolate it:
  - Use the LOCALAPPDATA sandbox from memory, not `NIMBUS_CONFIG_DIR`.
  - Never touch my real `~/.nimbus` data or real Vault entries.
  - Ask me before anything that installs software globally or changes PATH.
- I perform any step that needs a human (a fresh user profile, a browser, a TTY approval). Tell me exactly what to type, and use `! <command>` when the output should land in this session.

Steps:
1. **Plan.** Write a short Gate 1 checklist for Windows from the spec and memory: install, `nimbus doctor`, `nimbus demo`, `nimbus why`, uninstall. Run [REVIEW BLOCK] on the checklist and the install docs it relies on (bundle the install script, the docs pages, and the released-install-smoke workflow). Fix it.
2. **Run Gate 1 on Windows.** Record every step's real output. Any failure is a finding:
   - reproduce it;
   - file a GitHub issue;
   - fix it on a branch from origin/main (absolute-path worktree);
   - run [REVIEW BLOCK] on the fix;
   - open the PR with auto-merge and monitor it.
3. **Record the result.** Update memory and the distribution spec's status, and write the macOS checklist for me to run on a Mac later.
```

---

## Prompt 5 (ops, optional) — Renew the VS Code Marketplace token before 2026-12-15

```
`VSCE_PAT` expires 2026-12-15, and the date is recorded in two repos (see memory `secrets-management-program.md`).

Steps:
1. Walk me through rotating it. I create the token myself in Azure DevOps. Never ask me to paste the secret into this chat. I set it with `gh secret set` myself, through `! <command>`.
2. Update the recorded expiry in both repos on branches from origin/main, opening each PR with auto-merge, and monitor them.
3. Verify the next nimbus-vscode release workflow can publish.

This needs no code review, so skip [REVIEW BLOCK] here.
```
