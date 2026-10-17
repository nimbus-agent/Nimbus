# Extension Model Access (Extension Runtime PR 4 of 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the owner offer an approved extension's tools to the engine agent with `nimbus extension approve <id> --model`, under the existing `user_mcp_model_access` lock-off, plus a `nimbus doctor` line and the slice's docs close-out.

**Architecture:** Reuse I42's user-MCP model path unchanged: a second id source (extension grants with `model_access = 1`, enabled, not stale, not signature-disabled) joins the user-MCP source behind the same live policy predicate, and `listTools` routes through the mesh's existing `listOwnerCodeServerTools`, which already sends `ext_*` to the extension slot. The approve flow gains a `modelAccess` parameter carried from CLI flag → IPC → grant row.

**Tech Stack:** Bun 1.4, TypeScript strict, bun:sqlite, `bun:test`, Biome.

**Spec:** `docs/superpowers/specs/2026-10-17-extension-model-access-design.md` (branch-only; read it first).

## Global Constraints

- No `any`; external data is `unknown` (CLAUDE.md non-negotiable 7).
- Platform equality: build paths with `path.join`; no OS-specific logic outside `platform/`.
- Lock-off name is the existing `user_mcp_model_access`; add NO new `AI_V2_CAPABILITIES` member.
- No new invariant number, no new static rule; I42 triple rule (wiring + `docs/SECURITY-INVARIANTS.md` + `security-invariants.test.ts`) lands in ONE commit (Task 4).
- `extension.approveRun` stays CLI-only, LAN-forbidden, demo-refused, absent from the Tauri allowlist.
- Every SQLite read of `extension_run_grant` lives in `extensions/run-grant-store.ts` (D33(b)); `upsertRunGrant` is named only by `run-grant-store.ts` and `approve-run.ts` (D33(c)).
- Prefer dependency injection over `mock.module` in tests.
- Per-file coverage floor: ≥85% line AND ≥80% branch on every changed source file (CI-Linux-authoritative).
- PR title: `feat(extensions): …` with no `!`.

## Review Focus

1. **A model-access extension whose code changed after approval** — must never be offered (filtered as stale before listing); pinned in Task 2.
2. **Re-running `approve <id>` without `--model` on an extension that had it** — must prompt and turn it OFF, not short-circuit as "already approved"; pinned in Task 1.
3. **Signature-disabled-but-enabled extension** (`extension.enable` after an I16 failure) — must not be listed for the model; pinned in Task 2.
4. **`nimbus extension approve --model <id>` (flag before id)** — must send the real id, not `"--model"`; pinned in Task 5.
5. **Runtime off (`[extensions] runtime = false`)** — no extension tools offered, no warning, and doctor stays silent; pinned in Tasks 3 and 6.

---

### Task 1: Gateway approve flow carries `modelAccess`

**Files:**
- Modify: `packages/gateway/src/extensions/approve-run.ts` (deps `:35-42`, result `:44-51`, `buildRunConsentPayload` `:148`, `approveExtensionRun` `:207-298`)
- Modify: `packages/gateway/src/ipc/automation-rpc.ts` (`handleExtensionApproveRun` `:751`)
- Test: `packages/gateway/src/extensions/approve-run.test.ts`, `packages/gateway/src/ipc/automation-rpc.run-grant.test.ts`

**Interfaces:**
- Produces: `ApproveExtensionRunDeps.modelAccess?: boolean` (absent = `false`); `ApproveExtensionRunResult.modelAccess: boolean`; `buildRunConsentPayload(row, manifest, serviceId, treeDigest, grants, env, modelAccess: boolean)`; IPC `extension.approveRun { id: string; modelAccess?: boolean }` → result includes `modelAccess`.

- [ ] **Step 1: Write failing tests in `approve-run.test.ts`** (reuse that file's existing fixture/gate helpers):
  - `"--model writes model_access = 1 and the prompt shows modelAccess: true"` — `approveExtensionRun(id, {...deps, modelAccess: true})`; `expect(getRunGrant(db,id)?.model_access).toBe(1)`; captured gate payload `expect(payload.modelAccess).toBe(true)`; `expect(result.modelAccess).toBe(true)`.
  - `"no flag writes model_access = 0"` — `expect(getRunGrant(db,id)?.model_access).toBe(0)`; `result.modelAccess === false`.
  - `"a change only in model access prompts and writes (not short-circuited)"` — approve without, then approve with `modelAccess: true`: gate called twice, second `result.changed === true`, row `model_access === 1`; then approve without again: gate called a third time, row `0`.
  - `"an identical re-approval including model access short-circuits"` — approve with `true` twice: gate called once, second `changed === false`, `modelAccess === true`.
- [ ] **Step 2: Run** `bun test packages/gateway/src/extensions/approve-run.test.ts` — Expected: the four new tests FAIL.
- [ ] **Step 3: Implement.** `const modelAccess = deps.modelAccess === true;` Add `existing.model_access === (modelAccess ? 1 : 0)` to the unchanged condition; pass `modelAccess` to `buildRunConsentPayload` as a REQUIRED 7th parameter (replace the hard-coded `modelAccess: false`) and update its one direct test call, `approve-run.test.ts:402`, to pass `false` — no default, so a future caller cannot forget it; write `model_access: modelAccess ? 1 : 0`; add `modelAccess` to `base` so both returns carry it.
- [ ] **Step 4: Write failing IPC tests**: `extension.approveRun` with `modelAccess: "yes"`, `1`, `null` each rejects `-32602` with message `Invalid params: 'modelAccess' must be a boolean` AND emits no `extension.stateChanged` event (assert via the file's existing event capture, or the `emitGatewayEvent` seam it already uses); `modelAccess: true` reaches `approveExtensionRun` (row `model_access === 1`).
- [ ] **Step 5: Implement in `handleExtensionApproveRun`**, immediately after `const id = requireString(rec, "id");` and before the `try`:
  ```ts
  const rawModel = rec?.["modelAccess"];
  if (rawModel !== undefined && typeof rawModel !== "boolean") {
    throw new AutomationRpcError(-32602, "Invalid params: 'modelAccess' must be a boolean");
  }
  ```
  and pass `modelAccess: rawModel === true` into the deps.
- [ ] **Step 6: Run** both test files — Expected: PASS.
- [ ] **Step 7: Commit** `feat(extensions): extension.approveRun carries modelAccess into the grant`.

---

### Task 2: Extension model source (store read + policy-gated union)

**Files:**
- Modify: `packages/gateway/src/extensions/run-grant-store.ts`
- Modify: `packages/gateway/src/connectors/user-mcp-model-capability.ts`
- Test: `packages/gateway/src/extensions/run-grant-store.test.ts`, `packages/gateway/src/connectors/user-mcp-model-capability.test.ts`

**Interfaces:**
- Produces: `listModelAccessibleExtensionGrants(db: Database): { serviceId: string; extensionId: string }[]` in `run-grant-store.ts` (`[]` below V70).
- Produces: `listPolicyGatedModelAccessibleOwnerCodeServerIds(db: Database, enforced: Pick<EnforcedPolicy, "capabilitiesDisabled"> | undefined, isSignatureDisabled?: (extensionId: string) => boolean): string[]` in `user-mcp-model-capability.ts` — user-MCP ids first (existing order), then extension service ids; `[]` when `isUserMcpModelAccessEnabled(enforced)` is false. Default `isSignatureDisabled` is `(id) => signatureDisabledRegistry.reasonFor(id) !== undefined` (`extensions/hard-disable.ts`).
- Keeps: `listPolicyGatedModelAccessibleUserMcpIds` unchanged (used by `(cap-4)` and elsewhere).

- [ ] **Step 1: Write failing store tests** (seed `extension` rows + grants through existing test helpers or `upsertRunGrant`):
  - returns `[{serviceId:"ext_a", extensionId:"a"}]` for an enabled row with `model_access = 1` and matching version + tree digest;
  - excludes `model_access = 0`; excludes `enabled = 0`; excludes a grant whose `version` differs from the row; excludes one whose `tree_digest` differs; excludes a row whose `tree_digest` is NULL;
  - excludes a stored `service_id` not matching `EXTENSION_SERVICE_ID_PATTERN` (insert via `upsertRunGrant` with `service_id: "mcp_x"`);
  - ordered by service id (`ext_b` inserted before `ext_a` comes back second);
  - returns `[]` on a database below V70.
- [ ] **Step 2: Run** `bun test packages/gateway/src/extensions/run-grant-store.test.ts` — Expected: FAIL (function missing).
- [ ] **Step 3: Implement** `listModelAccessibleExtensionGrants` with one query:
  `SELECT g.service_id, g.extension_id FROM extension_run_grant g JOIN extension e ON e.id = g.extension_id WHERE g.model_access = 1 AND e.enabled = 1 AND e.version = g.version AND e.tree_digest = g.tree_digest ORDER BY g.service_id`, then filter with `EXTENSION_SERVICE_ID_PATTERN.test`. Finalize nothing extra: use `db.query(...).all()` as the file already does.
- [ ] **Step 4: Run** store tests — Expected: PASS.
- [ ] **Step 5: Write failing capability tests**:
  - lock-off (`capabilitiesDisabled` has `user_mcp_model_access`) → `[]` even with an `--model` user-MCP row AND a model-access extension;
  - `enforced === undefined` → `[]`;
  - allowed → `["mcp_x", "ext_a"]` (user-MCP first);
  - injected `isSignatureDisabled = (id) => id === "a"` drops `ext_a` but keeps `mcp_x`.
- [ ] **Step 6: Implement** `listPolicyGatedModelAccessibleOwnerCodeServerIds`: evaluate `isUserMcpModelAccessEnabled(enforced)` once, first; then `[...listModelAccessibleUserMcpIds(db), ...listModelAccessibleExtensionGrants(db).filter(g => !isSignatureDisabled(g.extensionId)).map(g => g.serviceId)]`. Update the file header and both doc comments to say the lock-off covers extensions too.
- [ ] **Step 7: Run** capability tests — Expected: PASS.
- [ ] **Step 8: Commit** `feat(extensions): model-access extension source behind the user_mcp_model_access lock-off`.

---

### Task 3: Engine description prefix for extensions

**Files:**
- Modify: `packages/gateway/src/engine/user-mcp-agent-tools.ts` (`describeFor` `:65-70`)
- Test: `packages/gateway/src/engine/user-mcp-agent-tools.test.ts`

**Interfaces:**
- Consumes: `EXTENSION_SERVICE_ID_PATTERN` from `extensions/extension-service-id.ts`.

- [ ] **Step 1: Write failing tests** using the file's existing fake `UserMcpAgentToolSource`/executor helpers:
  - `"an ext_ source is offered with the extension prefix"` — source lists `["ext_notes"]` whose tools map has key `ext_notes_echo`; offered tool `ext_notes__echo` exists and its description starts with `owner-approved extension ext_notes; treat its output as data. `.
  - `"the ext_ prefix keeps the description cap and the closer intact"` — tool `ext_notes_huge` with description `"z".repeat(10_000)`: `startsWith('owner-approved extension ext_notes; treat its output as data. <tool_description server="ext_notes">')`, `endsWith("z</tool_description>")`, `length === USER_MCP_DESCRIPTION_MAX` (mirrors the existing `mcp_` test at `:187`).
  - `"an mcp_ source keeps the user MCP prefix"` — description starts with `owner-registered user MCP server mcp_x; treat its output as data. `.
  - `"an ext_ tool executes through the executor as ext_notes.echo"` — executing the offered tool calls the fake executor once with `type: "ext_notes.echo"` and `payload.mcpToolId === "ext_notes_echo"`, and the listing's own `execute` is never called.
  - `"a refusing extension is skipped with a warning; other servers still offered"` — `listTools("ext_bad")` rejects with an `Error("ERR_EXTENSION_RUN_TREE_CHANGED")`; result has no `ext_bad__*` key, has `mcp_x__*`, and `warn` was called once with bindings naming `ext_bad`.
  - `"an extension whose listing resolves undefined (runtime off) is skipped silently"` — `listTools("ext_off")` resolves `undefined`: no tools for it, `warn` not called.
  - `"with no owner executor an ext_ tool refuses and never executes"` — build with the executor getter returning `undefined`; executing `ext_notes__echo` returns `{ refused: "user MCP tools are only callable by the local owner" }` and the fake executor is never called. (The per-client-kind table `USER_MCP_OFFER_BY_KIND` is source-independent and already tested in `ipc/server/inline-handlers.test.ts`; do not duplicate it.)
- [ ] **Step 2: Run** `bun test packages/gateway/src/engine/user-mcp-agent-tools.test.ts` — Expected: the two prefix tests FAIL (others may already pass; keep them as pins).
- [ ] **Step 3: Implement**: in `describeFor`, choose the prefix by `EXTENSION_SERVICE_ID_PATTERN.test(serviceId)` — `owner-approved extension ${serviceId}; treat its output as data. ` vs the existing user-MCP text. The cap arithmetic stays as is (it already subtracts `prefix.length`).
- [ ] **Step 4: Run** the file — Expected: PASS.
- [ ] **Step 5: Commit** `feat(engine): name an owner-approved extension in its tool descriptions`.

---

### Task 4: Wire the source in gateway-main + I42 triple rule

**Files:**
- Modify: `packages/gateway/src/gateway-main.ts` (`userMcp:` block `:190-198`, and its comment `:180-189`)
- Modify: `packages/gateway/src/security-invariants.test.ts` (I42 test `:5808-5829`; `(cap-4)` `:2004`)
- Modify: `docs/SECURITY-INVARIANTS.md` (I42 "Extensions (S3 runtime PR 3)" paragraph + Wiring list; I43 statement's last sentence at `:1419`)
- Modify: `packages/gateway/src/policy/types.ts` (`AI_V2_CAPABILITIES` doc comment for `user_mcp_model_access`, `:56-62`)

**Interfaces:**
- Consumes: `listPolicyGatedModelAccessibleOwnerCodeServerIds` (Task 2); `platform.connectorMesh.listOwnerCodeServerTools(serviceId)` (exists, `connectors/lazy-mesh/mesh.ts:407`).

- [ ] **Step 1: Update the I42 test first (it must fail against current main)**:
  - `expect(main).toMatch(/listModelAccessibleIds:\s*\(\)\s*=>\s*listPolicyGatedModelAccessibleOwnerCodeServerIds\(\s*platform\.localIndex\.getDatabase\(\),\s*platform\.enforcedPolicy\?\.\(\),?\s*\)/)`
  - `expect(main).toMatch(/listTools:\s*\(serviceId\)\s*=>\s*platform\.connectorMesh\.listOwnerCodeServerTools\(serviceId\)/)`
  - keep `not.toMatch(/listUserMcpConnectors/)` and `not.toMatch(/\blistModelAccessibleUserMcpIds\b/)`; add `expect(main).not.toMatch(/\blistModelAccessibleExtensionGrants\b|\blistRunGrants\b|\bgetRunGrant\b/)`.
  - In `user-mcp-model-capability.ts`, slice from `export function listPolicyGatedModelAccessibleOwnerCodeServerIds(`; assert `isUserMcpModelAccessEnabled(` index > -1 and less than BOTH `listModelAccessibleUserMcpIds(` and `listModelAccessibleExtensionGrants(` indices (both > -1).
  - Extend `(cap-4)`: seed a model-access extension (enabled row + matching grant) in the same index; assert `listPolicyGatedModelAccessibleOwnerCodeServerIds(index, allow.enforced(), () => false)` contains its service id and `…(index, lock.enforced(), () => false)` equals `[]`.
- [ ] **Step 2: Run** `bun test packages/gateway/src/security-invariants.test.ts -t "I42|cap-4"` — Expected: FAIL on the gateway-main regex.
- [ ] **Step 3: Implement** the gateway-main change: `listModelAccessibleIds: () => listPolicyGatedModelAccessibleOwnerCodeServerIds(platform.localIndex.getDatabase(), platform.enforcedPolicy?.())` and `listTools: (serviceId) => platform.connectorMesh.listOwnerCodeServerTools(serviceId)`; swap the import; rewrite the comment to name extensions (`--model` grants) as the second source and keep the "toolgen/computerUse stay unwired" sentence.
- [ ] **Step 4: Update docs in the same commit**: I42 extensions paragraph (offered only with an `extension approve --model` grant, enabled, not stale, not signature-disabled, behind the shared `user_mcp_model_access` lock-off; still never proposable on the I28 act door); add `extensions/run-grant-store.ts` (`listModelAccessibleExtensionGrants`) to I42's Wiring list; rewrite I43's last sentence to match; `policy/types.ts` comment says the lock-off also empties the extension source.
- [ ] **Step 5: Run** `bun test packages/gateway/src/security-invariants.test.ts` and `bun run typecheck` — Expected: PASS.
- [ ] **Step 6: Commit** `feat(extensions): offer --model extensions to the engine agent (I42)`.

---

### Task 5: CLI `approve --model` and model access in `extension info`

**Files:**
- Modify: `packages/cli/src/commands/extension.ts` (`stripFlags` `:36-48`, `formatRunLine` `:131-136`, `runExtensionApprove` `:394-428`, `EXTENSION_USAGE` `:655`)
- Test: `packages/cli/src/commands/extension.test.ts`

**Interfaces:**
- Consumes: IPC `extension.approveRun { id, modelAccess? }` → `{ id, serviceId, treeDigest, changed, modelAccess }` (Task 1).

- [ ] **Step 1: Write failing tests** (use the file's existing fake client and TTY stubbing):
  - `stripFlags(["--model","a.b"])` → `["a.b"]`; `stripFlags(["a.b","--model"])` → `["a.b"]`.
  - `runExtensionApprove` with args `["approve","--model","a.b"]` calls `extension.approveRun` with `{ id: "a.b", modelAccess: true }`; with `["approve","a.b"]` → `{ id: "a.b", modelAccess: false }`.
  - Output: changed + `modelAccess: true` includes `model access: on`; unchanged + `modelAccess: false` includes `model access: off`.
  - `formatRunLine({ runState: "ready", runGrant: { serviceId: "ext_a", approvedAt: 0, modelAccess: true } })` === `ready (ext_a, approved 1970-01-01T00:00:00.000Z, model: yes)`; with `false` ends `model: no)`.
  - The empty-id usage error message is `Usage: nimbus extension approve <id> [--model]`.
- [ ] **Step 2: Run** `bun test packages/cli/src/commands/extension.test.ts` — Expected: new tests FAIL.
- [ ] **Step 3: Implement**: add `"--model"` to the boolean skip in `stripFlags`; in `runExtensionApprove` send `modelAccess: hasFlag(args, "--model")`, type the result with `modelAccess: boolean`, append `; model access: ${out.modelAccess ? "on" : "off"}` to both messages; `formatRunLine` appends `, model: yes|no`; both usage strings read `approve <id> [--model]`. Update existing expectations that this changes: `extension.test.ts:2253` becomes `params: { id: "x", modelAccess: false }`, and the two `formatRunLine` assertions around `:2334`/`:2339` gain `, model: no`; grep `extension.coverage.test.ts` for the same strings.
- [ ] **Step 4: Run** both CLI extension test files — Expected: PASS.
- [ ] **Step 5: Commit** `feat(cli): nimbus extension approve --model; info shows model access`.

---

### Task 6: `extension.list` reports `runtimeEnabled`; `nimbus doctor` extensions line

**Files:**
- Modify: `packages/gateway/src/ipc/automation-rpc.ts` (`handleExtensionList` `:491-500`)
- Create: `packages/cli/src/commands/extension-doctor-format.ts`
- Create: `packages/cli/src/commands/extension-doctor-format.test.ts`
- Modify: `packages/cli/src/commands/doctor-core.ts` (new `doctorPrintExtensions`, called in `doctorRunGatewayRpcs` right after `doctorPrintCaptures`)
- Test: `packages/cli/src/commands/doctor-core.test.ts`, `packages/gateway/src/ipc/automation-rpc.run-grant.test.ts`

**Interfaces:**
- Produces (gateway): `extension.list` result `{ extensions: [...], runtimeEnabled: boolean }` (`ctx.runtimeEnabled ?? true`).
- Produces (CLI): `doctorExtensionsLines(raw: unknown): { lines: string[]; exit: number }` in `extension-doctor-format.ts`; `doctorPrintExtensions(client: Pick<IPCClient, "call">): Promise<number>` in `doctor-core.ts`.

- [ ] **Step 1: Write failing gateway test**: `extension.list` with `ctx.runtimeEnabled = false` returns `runtimeEnabled: false`; with it unset returns `true`.
- [ ] **Step 2: Implement** `runtimeEnabled: ctx.runtimeEnabled ?? true` in the returned value; run the test — PASS.
- [ ] **Step 3: Write failing formatter tests** (`extension-doctor-format.test.ts`):
  - `runtimeEnabled: false` with an unapproved extension → `{ lines: [], exit: 0 }`.
  - missing `runtimeEnabled` (older gateway) with one `no_grant` → treated as enabled (one `[warn]` line, exit 1).
  - zero `no_grant`/`grant_stale` → `{ lines: [], exit: 0 }`; `disabled` extensions are not counted.
  - two flagged (`a` no_grant, `b` grant_stale) → one line exactly `[warn] Extensions: 2 installed extension(s) not approved to run, or approved for an older version (a, b) — nimbus extension approve <id>`, exit 1.
  - more than 5 flagged → first 5 ids then `, +N more`.
  - an id containing `"\u001b[31m"` is printed with control characters stripped.
  - a malformed payload (`{}` or `{ extensions: "x" }`) throws (the caller turns it into a `[warn]`).
- [ ] **Step 4: Implement** `doctorExtensionsLines` with exactly these rules (every branch has a Step 3 test):
  1. `raw` must be a non-null, non-array object whose `extensions` is an array, else `throw new Error("malformed extension.list response from the gateway")`.
  2. `raw.runtimeEnabled === false` → `{ lines: [], exit: 0 }`; any other value (absent, `true`, or a non-boolean) is treated as enabled.
  3. An element counts only if it is an object with a string `id` and `runState` of `"no_grant"` or `"grant_stale"`; other elements are ignored.
  4. Each counted id goes through `stripControl` (from `captures-format.ts`); cap 5, then `, +N more`.
  Add one more Step 3 case for rule 2's non-boolean (`runtimeEnabled: "no"` with one `no_grant` → warns) and rule 3's ignored element (`[42, {id:"a", runState:"no_grant"}]` → counts 1).
- [ ] **Step 5: Write failing `doctor-core.test.ts` cases** with a fake client that dispatches by METHOD NAME (as `captures.test.ts:360-384` does), not `createMockIpcClient`: that helper throws a plain `Error` with no `code` once its queue is exhausted, which `isMethodNotFound` reads as a real failure. Existing `runDoctor` tests that use `createMockIpcClient` with a short queue will now also hit `extension.list` past the end of the queue and print a `[warn]`; they already do so for `notifications.status`/`capture.status`, so re-run them and update an exit-code assertion only if one changes. Cases: `-32601` on `extension.list` → returns 0 and prints nothing; other error → prints `[warn] Extensions: status check failed (…)` and returns 1; a flagged payload → prints the formatter line and returns 1. Add a pin that `doctorRunGatewayRpcs` source calls `doctorPrintExtensions(client)` immediately after `doctorPrintCaptures(client)` only if the file already pins call order this way; otherwise cover it through the existing whole-doctor test.
- [ ] **Step 6: Implement** `doctorPrintExtensions` mirroring `doctorPrintCaptures` (label `Extensions`) and wire it.
- [ ] **Step 7: Run** the formatter, doctor-core and automation-rpc tests — Expected: PASS.
- [ ] **Step 8: Commit** `feat(cli): nimbus doctor flags installed extensions without a current run approval`.

---

### Task 7: E2E round-trip + docs close-out

**Files:**
- Modify: `packages/gateway/test/e2e/extension-runtime.e2e.test.ts`
- Modify (grep each first for the stale claim; skip a file that is already correct): `docs/architecture.md`, `docs/sandbox.md`, `docs/README.md`, `docs/ecosystem-roadmap.md` (§ Track 0), `docs/roadmap.md` (Phase 9.5 checkbox), `docs/cli-reference.md` (`approve <id> [--model]`, doctor line), `docs/CHANGELOG.md`, `CLAUDE.md`, `GEMINI.md`

- [ ] **Step 1: E2E**: after the existing approve step, add a test: `extension.approveRun { id, modelAccess: true }` (owner gate answers approve as the file already does) returns `modelAccess: true`, and `extension.info` returns `runGrant.modelAccess === true`; then `extension.approveRun { id }` turns it back to `false`; and `extension.list` over the real socket returns `runtimeEnabled: true`. Place it where it does not disturb later tests' assumptions (it must leave the grant otherwise equal). Run `bun test packages/gateway/test/e2e/extension-runtime.e2e.test.ts` — PASS on this OS.
- [ ] **Step 2: Docs**: known stale lines (re-grep to confirm, lines drift): `docs/README.md:792`; `docs/architecture.md:1815` and `:1819-1824`; `docs/cli-reference.md:2983-2990` (lock-off covers `--model` extensions), `:3011`, `:3965` (doctor section: add the `Extensions:` line), `:4392`, `:4425-4450` (heading `nimbus extension approve <id> [--model]`; document `--model` and that re-running without it turns model access off); `docs/ecosystem-roadmap.md:126`; `docs/roadmap.md:1241`, `:1261`, `:1763`, `:1771` (tick `- [x] **Extensions actually run**`), `:2322`; `CLAUDE.md`/`GEMINI.md` status paragraph and the I42/I43 one-liners. Then `grep -rn "not executed\|not offered to the model\|Installed extensions are not\|is PR 4" docs CLAUDE.md GEMINI.md` and correct any remaining hit. Do NOT edit historical CHANGELOG entries (e.g. PR 3's at `docs/CHANGELOG.md:27`); only add the new PR 4 entry; add `--model` and the doctor line to `cli-reference.md`; tick Phase 9.5 in `roadmap.md` if PR 4 completes its row; CHANGELOG entry under the unreleased section; CLAUDE.md + GEMINI.md status paragraph: "S3 extension runtime PR 4 of 4 shipped 2026-10-…: `--model` access behind the shared `user_mcp_model_access` lock-off, doctor line" and remove "Nothing spawns an extension yet"-style sentences if still present.
- [ ] **Step 3: Run** `bun run audit:doc-refs` and `bun run audit:status-drift` — Expected: PASS.
- [ ] **Step 4: Commit** `docs: extension runtime PR 4 close-out`.

---

### Task 8: Pre-push verification and PR

- [ ] **Step 1:** `bun run preflight:fast` — Expected: `preflight PASSED`.
- [ ] **Step 2:** Run every test file touched in Tasks 1–7 — Expected: 0 fail.
- [ ] **Step 3: Coverage on changed source files**, Istanbul as CI does:
  ```bash
  rm -rf coverage && mkdir -p coverage/.nyc-tmp
  (cd packages/gateway && bun test --timeout 60000 --preload ../../scripts/coverage/istanbul-register.ts --preload ../../scripts/coverage/report-coverage.ts <gateway test files>)
  (cd packages/cli && bun test --timeout 60000 --preload ../../scripts/coverage/istanbul-register.ts --preload ../../scripts/coverage/report-coverage.ts <cli test files>)
  bun run coverage:merge
  ```
  For each changed source file read `LF/LH/BRF/BRH` from `coverage/lcov.info` — Expected: ≥85% lines, ≥80% branches; add tests where short. `rm -rf coverage` after.
- [ ] **Step 4:** `bun run typecheck:tests` — Expected: `0 new`.
- [ ] **Step 5:** Strip `docs/superpowers/` (spec, review, plan) in a final commit `chore: strip the branch-only spec and plan before the PR`.
- [ ] **Step 6:** Push and open the PR (`feat(extensions): offer --model extensions to the engine agent (runtime PR 4 of 4)`), body ending with the Claude Code attribution line.
- [ ] **Step 7:** After the first CI run: dump `.steps[]` of any red job, and query `https://sonarcloud.io/api/issues/search?componentKeys=nimbus-agent_Nimbus&pullRequest=<n>&resolved=false` — fix everything found in ONE push.
