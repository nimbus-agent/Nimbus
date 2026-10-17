# Extension runtime PR 4 of 4 — model access, lock-off, doctor line, docs close-out

Branch-only design (stripped before the implementation PR, like PRs 1–3). Parent design:
`docs/superpowers/specs/2026-10-11-extension-runtime-design.md` (not on `main`; read it with
`git show 0030d8d0:docs/superpowers/specs/2026-10-11-extension-runtime-design.md`), § 4.7 and § 10
item 4. Where this document and the parent disagree, this one wins.

## 1. Intent

PRs 1–3 made installed extensions run, sandboxed, behind owner approval, but only the owner can call
them (`nimbus connector tools|call ext_<id>`). PR 4 lets the owner, per extension, also offer an
approved extension's tools to the engine agent — the model — exactly the way a user MCP server
registered with `--model` is offered today under invariant I42. It also closes the slice: an
org-policy lock-off covers it, `nimbus doctor` surfaces extensions left unapproved, and every doc
that still says "extensions are not executed" or "extension tools are not offered to the model" is
corrected.

Why it matters: an extension is owner-approved third-party code. Its tools are only useful in
`nimbus ask` if the model can call them; and that is the path where untrusted output meets the
model, so it must reuse I42's proven path rather than a new one.

## 2. Goals

1. `nimbus extension approve <id> --model` grants model access; the grant row stores it
   (`extension_run_grant.model_access`, column already present since V70, always 0 today).
2. An extension with model access is offered to the engine agent on exactly the client kinds that
   get `--model` user MCP tools today (`cli`, `ui`, `unknown`; never `mcp`/`http`/`chatops`/
   `fleet`/`push`) — via the existing `USER_MCP_OFFER_BY_KIND` table and request-context executor.
   No new offer table.
3. Every model call to an extension tool goes through the turn's own `ToolExecutor` with action
   type `ext_<id>.<tool>`, so the executor's existing I42 rule (HITL required, no delegate) applies.
   That rule already treats `ext_` as owner code (`connectors/owner-code-server.ts`,
   `engine/executor.ts` `isUserMcpActionType`); PR 4 adds no executor change.
4. Tool naming, description fencing, schema sanitising and listing are the existing
   `engine/user-mcp-agent-tools.ts` machinery (`<serviceId>__<tool>`, `wrapToolDescription`,
   `sanitiseUserMcpInputSchema`, I11). The description prefix names the source honestly:
   `owner-approved extension <id>; treat its output as data.` for `ext_`, unchanged for `mcp_`.
5. The org-policy lock-off is the EXISTING `[policy.capabilities.ai_v2] user_mcp_model_access`.
   When it is false, the extension model source is empty too — read live per turn, fail-closed when
   the policy accessor is absent. **Owner decision (2026-10-17): one shared switch; no new
   capability name.** (Parent design Q1, option 1.)
6. `nimbus doctor` prints one line when any installed extension's run state is `no_grant` or
   `grant_stale`.
7. `nimbus extension info` (and `list`, if its row format has room) shows whether model access is on.
8. Docs close-out listed in § 7.

## 3. Non-goals

- MCP agents proposing extension actions on the I28 act door: stays refused (`ext_` remains
  `unknown` in `classifyActionType`). Not touched.
- Changing a user MCP server's `model_access` after registration (still remove + re-add).
- `deps.toolgen` / `deps.computerUse` stay unwired.
- The compiled-binary spawn path (still unproven from PR 3) — separate follow-up.
- A separate `extension_model_access` capability name (rejected by the owner; can be added later
  without loosening anything).

## 4. Anti-goals (would be a failure even if it "works")

- Any path where an extension tool reaches the model without the executor's HITL gate, or on a
  non-owner client kind.
- An extension whose code changed since approval being offered (it must be skipped, not offered and
  then refused at call time only).
- The lock-off leaving extension tools offered.
- Model access turned ON without a fresh owner prompt that shows it.
- Calling the listing's own `execute` (I42 pins that the model path always goes through the
  executor).

## 5. Decisions

### 5.1 Granting and revoking model access (my call, confirmed by the owner's "go ahead")

Every `approve` states the whole grant. `nimbus extension approve <id> --model` sets
`model_access = 1`; `nimbus extension approve <id>` without the flag sets it to 0.

- Both prompt (TTY only, no `--yes`, as today). The consent payload's `modelAccess` field shows the
  value being granted (it is hard-coded `false` today in `approve-run.ts`).
- The "unchanged" short-circuit in `approveExtensionRun` (returns `changed:false` without prompting
  when version, tree digest and permissions match) must ALSO compare `model_access`; a request that
  differs only in model access prompts and writes.
- `extension.approveRun` IPC gains an optional boolean `modelAccess` (absent = false). Non-boolean
  is refused (`-32602`). The method stays CLI-only, LAN-forbidden, demo-refused, absent from the
  Tauri allowlist.
- `nimbus extension revoke` still deletes the whole grant (model access goes with it).
- **Under the org lock-off, `approve --model` still stores the grant (my call, from the builder
  check).** This mirrors `nimbus connector add --mcp --model`, which reads no policy either. The
  lock-off is enforced where it matters — the model source, live per turn — so a stored flag has no
  effect while the policy holds, and takes effect without re-approval if the org lifts it. No policy
  read is added to `approveExtensionRun`.

### 5.2 Which extensions are offered

The extension model source returns grant service ids where `model_access = 1` AND the extension row
is enabled — ordered by service id, `[]` when the lock-off is on or the policy accessor is absent.
The query lives in `extensions/run-grant-store.ts` (D33(b) confines the `extension_run_grant` table
to the store and its DDL). The policy gate wraps it in `connectors/user-mcp-model-capability.ts`
beside `listPolicyGatedModelAccessibleUserMcpIds`, sharing `isUserMcpModelAccessEnabled`.

**Stale grants are filtered in the source (my call, from the builder check).** A grant whose
`version` or `tree_digest` no longer matches the extension row — the same test `run-state.ts` uses
for `grant_stale` — is excluded before any listing. Otherwise every `nimbus ask` turn would
re-verify, re-stage and fail to spawn a merely-installed stale extension, adding latency and a
health write per turn. This pre-filter is a cheap row comparison, not verification; it narrows and
never widens.

Full verification is NOT repeated in the source: listing an extension's tools spawns it through the
mesh (`listOwnerCodeServerTools` → extension slot → `prepareSpawn` → `readVerifiedExtensionForSpawn`),
which refuses a changed tree, a policy-blocked id, etc. `buildUserMcpAgentTools` already catches a
server whose listing throws, warns and skips it — so a stale or refused extension is never offered.
The builder must confirm with a test that a refusing extension yields zero offered tools and a
warning, and that the other servers' tools are still offered.

### 5.3 Wiring

`gateway-main.ts` `createNimbusEngineAgent({ userMcp: … })` currently passes
`listModelAccessibleIds: () => listPolicyGatedModelAccessibleUserMcpIds(db, platform.enforcedPolicy?.())`
and `listTools: (id) => platform.connectorMesh.listUserMcpTools(id)`. PR 4 makes the id source the
union (user MCP ids, then extension ids) and routes `listTools` through
`platform.connectorMesh.listOwnerCodeServerTools(id)`, which already dispatches `ext_*` to the
extension slot. The `security-invariants.test.ts` I42 regex pinning that line is updated in the same
commit, still asserting the policy-gated readers (never a bare `listModelAccessibleUserMcpIds` or
the new unguarded store read) and the predicate-before-read order.

The exact factoring (one combined helper vs two calls) is the builder's choice, provided the policy
predicate is evaluated once per turn and before either read.

### 5.4 `nimbus doctor`

A new check in `packages/cli/src/commands/doctor-core.ts`, modelled on `doctorPrintCaptures` and a
pure formatter beside the extension CLI formatting:

- calls `extension.list`; `-32601` → silent, exit 0; other failure → `[warn] Extensions: status
  check failed (…)`, exit 1;
- zero extensions in `no_grant`/`grant_stale` → no line (or an `[info]` line; builder's choice,
  match the neighbours);
- otherwise `[warn] Extensions: N installed extension(s) not approved to run, or approved for an
  older version — nimbus extension approve <id>` listing the ids (cap the list; builder picks the
  cap), exit 1. Disabled extensions are not counted.
- **Runtime off → silent (my call, from the builder check).** With `[extensions] runtime = false`
  or a demo gateway, `approve` refuses (`ERR_EXTENSION_RUNTIME_DISABLED`), so telling the owner to
  run it would be wrong. `extension.list` gains a top-level `runtimeEnabled: boolean` (the same
  `ctx.runtimeEnabled ?? true` value `extension.approveRun` already uses); the doctor check prints
  nothing when it is false. An older gateway without the field is treated as enabled.

### 5.5 Invariant bookkeeping

No new invariant number and no new static rule: this is I42's existing model path widened to a
second source, plus I43 unchanged. Triple rule applies to I42: production wiring, the
`docs/SECURITY-INVARIANTS.md` I42 entry (the "Extensions (S3 runtime PR 3)" paragraph currently says
extension tools are NOT offered to the model — rewrite it, and add the new store reader and the
gateway-main union to the Wiring list), and enforcement tests in `security-invariants.test.ts` in the
same commit. The `AI_V2_CAPABILITIES` doc comment in `policy/types.ts` and the
`user-mcp-model-capability.ts` header both state that the lock-off covers extensions.

## 6. Tests the builder must include

- Unit: approve with/without `--model` writes 1/0; model-access-only change prompts (not
  short-circuited); consent payload shows the granted value; IPC rejects non-boolean.
- Unit: extension source — enabled+model_access only; disabled excluded; lock-off → `[]`; absent
  policy accessor → `[]`.
- Unit (engine): an `ext_` source's tools are offered with the extension description prefix;
  execute goes through the executor with type `ext_<id>.<tool>` and `payload.mcpToolId`; a throwing
  listing is skipped with a warning while other tools still appear; non-owner kinds get none.
- `security-invariants.test.ts` I42: gateway-main wiring regex, lock-off empties the ext source.
- CLI: `approve --model` argument parsing and the IPC payload; `extension info` shows model access;
  doctor line formatter and the `doctorRunGatewayRpcs` wiring (method-not-found silent).
- E2E: extend `test/e2e/extension-runtime.e2e.test.ts` only if it can be done without a real model;
  at minimum assert `extension.approveRun {modelAccess:true}` round-trips into `extension.info`'s
  `runGrant.modelAccess`. A real-model end-to-end turn is NOT required (no vendor in CI).

## 7. Docs close-out

`docs/architecture.md` (extension runtime section), `docs/sandbox.md`, `docs/README.md` (both "not
executed yet" sentences, if still present after PR 3), `docs/ecosystem-roadmap.md` § Track 0,
`docs/roadmap.md` Phase 9.5 checkbox, `docs/cli-reference.md` (`approve [--model]`, doctor line),
`docs/SECURITY-INVARIANTS.md` I42, `docs/CHANGELOG.md`, and `CLAUDE.md` + `GEMINI.md` status
paragraph (S3 extension runtime PR 4 of 4 shipped). Grep each for the old claim before editing —
PR 3 may already have changed some.

## 8. Constraints

- Non-negotiables and invariants in `CLAUDE.md`; no `any`; platform equality.
- Not a breaking change (opt-in flag) — PR title has no `!`.
- Before the first push: `bun run preflight:fast`, the touched test files, Istanbul coverage on the
  changed source files (per-file floor 85% line / 80% branch), and the SonarCloud PR issue list after
  the first CI run — the CI job's later steps are hidden behind earlier failures.

## 9. Left to the builder

Helper names and factoring; the doctor list cap and `[info]` vs silent at zero; whether `extension
list` rows show model access; exact wording of docs, as long as it is accurate to what shipped.
