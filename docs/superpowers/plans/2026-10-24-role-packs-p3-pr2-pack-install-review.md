# Review: Role Packs P3 — PR 2 (Pack Install, Remove, Gate, CLI & Bundled Packs)

**Reviewed plan:** [2026-10-24-role-packs-p3-pr2-pack-install.md](file:///C:/gitrep/Nimbus/.claude/worktrees/role-packs/docs/superpowers/plans/2026-10-24-role-packs-p3-pr2-pack-install.md)  
**Parent spec:** [2026-10-24-role-packs-p3-the-pack-design.md](file:///C:/gitrep/Nimbus/.claude/worktrees/role-packs/docs/superpowers/specs/2026-10-24-role-packs-p3-the-pack-design.md) §§ 5.3–5.8, 5.10  
**Date:** 2026-10-24  

---

## Executive Summary

PR 2 delivers the operational core of Role Packs Phase 3:
1. **Store Evolution:** Record sidecar (`<id>.pack.json`), non-writing pre-flight check (`checkPackLayer`), and raw layer text reader in `packages/gateway/src/packs/pack-layer-store.ts`.
2. **Bundled Packs & Content Validation:** Bundled `pm` and `devops` JSON definitions embedded statically, record round-trip parsing (`pack-record.ts`), and catalog content validation (`pack-validate.ts`).
3. **Pure Prompt & Diff Renderer:** Verbatim `defaults` rendering, invisible text escaping via `mcp-sink` ranges, and fine-grained manifest diffing for updates and repairs (`pack-prompt.ts`).
4. **Security Invariant I47 & Static Rule D36:** Addition of `pack.install` to the `HITL_REQUIRED` frozen set in `engine/executor.ts`, non-delegable fallback (I20), `NULL_EGRESS_SINK` gate-only execution, audit scrubbing of prompt text, demo/LAN denial, and source-level restriction confining `setPackLayer`/`removePackLayer` strictly to `pack-install.ts`.
5. **Gateway Routing & CLI:** Thin RPC dispatcher `pack-rpc.ts`, unicast consent plumbing via `buildExtensionGateExecutor`, and terminal-enforced CLI (`nimbus pack list|show|install|remove`).

The plan is exceptionally thorough and architecturally sound. Cross-referencing against the live codebase (including `engine/executor.ts`, `pack-layer-store.ts`, `dispatchers.ts`, and `with-gateway-ipc.ts`) highlights **5 critical implementation traps / edge cases to guard against**, **4 open questions / design clarifications**, and **4 concrete implementation refinements**.

---

## 1. Implementation Traps & Edge Cases to Guard Against (Must-Address)

### 1.1 Manifest Parse vs. ID Reservation Check Ordering (Task 5)

In Task 5 Step 1:
> *"The fixed order of spec § 5.5. Each case asserts which step refused and that the gate was never called (call count 0) and no file was written:  
> 1. an unknown id → `ERR_PACK_NOT_FOUND`;  
> 2. a `fileText` while `isProduction()` is true → `ERR_PACK_LOCAL_FILE_PRODUCTION`;  
> 3. a file pack with id `pm` → `ERR_PACK_ID_RESERVED`;  
> 4. a manifest parse failure → `ERR_PACK_INVALID`;  
> 5. a non-empty `members` → `ERR_PACK_MEMBERS_UNSUPPORTED`; ..."*

**The Trap:**
- For a local file request (`{ fileText, filePath }`), you **cannot** evaluate whether the ID is reserved (`pm` / `devops` in step 3) before parsing the manifest (step 4).
- If `fileText` contains invalid JSON or schema violations, attempting to read `m.id` prior to `parseRolePackManifest(fileText)` would either require a brittle regex on raw unvalidated text or throw an unhandled error.

**Recommendation:**
Explicitly structure the resolution flow in `installPack`:
1. If request is `{ id }`:
   - If `!deps.bundled.has(req.id)`, throw `new PackError("ERR_PACK_NOT_FOUND", ...)`.
   - `manifest = deps.bundled.get(req.id)!`. Source is `{ kind: "bundled" }`.
2. If request is `{ fileText, filePath }`:
   - If `deps.isProduction()`, throw `new PackError("ERR_PACK_LOCAL_FILE_PRODUCTION", ...)`.
   - Parse manifest: `try { manifest = parseRolePackManifest(req.fileText); } catch (e) { throw new PackError("ERR_PACK_INVALID", (e as Error).message); }`.
   - Check reserved ID: `if (deps.bundled.has(manifest.id)) throw new PackError("ERR_PACK_ID_RESERVED", `pack id "${manifest.id}" is reserved for bundled packs`);`.
   - Source is `{ kind: "file", path: req.filePath }`.
3. Check `members`: `if (manifest.members.length > 0) throw new PackError("ERR_PACK_MEMBERS_UNSUPPORTED", "member extensions are not supported");`.
4. Validate content (`validatePackContent`) and run `checkPackLayer`.

---

### 1.2 `withGatewayIpc` and the Terminal Prompt Guard (Task 7)

In Task 7 Step 3:
> *"install registers `registerConsentPromptHandler(client)` directly (never `registerConsentFor`, which honours `NIMBUS_SCRIPT_CONSENT_SOURCE`), exactly as `runExtensionApprove` does. Use `withGatewayIpc(..., paths, { requestTimeoutMs: BATCH_RPC_TIMEOUT_MS })` for install."*

**The Trap:**
- In `packages/cli/src/lib/with-gateway-ipc.ts:90`:
  ```ts
  registerConsentFor(client, opts.consent ?? { kind: "prompt" });
  ```
- If `withGatewayIpc` is invoked with `{ requestTimeoutMs: BATCH_RPC_TIMEOUT_MS }`, it automatically calls `registerConsentFor(client, { kind: "prompt" })` **before** the provided callback `fn(client)` is executed.
- If `NIMBUS_SCRIPT_CONSENT_SOURCE` happens to be set in the environment, `registerConsentFor` will read it and bind `registerScriptConsentHandler`, which could answer or fail before `fn` ever gets a chance to call `registerConsentPromptHandler(client)`!
- In `packages/cli/src/commands/extension.ts:986-989`, `runExtension` deliberately connects its own `IPCClient` directly rather than using `withGatewayIpc` to completely prevent environment-variable script consent for `extension approve`.

**Recommendation:**
Either:
1. Follow `runExtension` in `packages/cli/src/commands/pack.ts`: construct `createIpcClient` directly, connect, and call `registerConsentPromptHandler(client)`.
2. Or add a variant `{ kind: "terminal_only" }` to `ConsentChoice` in `interactive-ipc-handlers.ts` that strictly binds `registerConsentPromptHandler(client)` without inspecting `NIMBUS_SCRIPT_CONSENT_SOURCE`.

---

### 1.3 `active.json` Unreadable Error Mapping (Task 1 & Task 5)

In Task 5 Step 1:
> *"8. an unreadable `active.json` → refused with its list error (Review Focus 2)."*

**The Trap:**
- `checkPackLayer` aggregates `readDetailed(profile).listError` into its returned `problems: readonly string[]`.
- In `installPack`, problems from `checkPackLayer` must be thrown as `PackError`.
- `PackErrorCode` is defined as:
  `"ERR_PACK_NOT_FOUND" | "ERR_PACK_ID_RESERVED" | "ERR_PACK_LOCAL_FILE_PRODUCTION" | "ERR_PACK_MEMBERS_UNSUPPORTED" | "ERR_PACK_CONFLICT" | "ERR_PACK_INVALID" | "ERR_PACK_INSTALL_NOT_APPROVED"`.
- If `active.json` is corrupted, is the error code `ERR_PACK_INVALID` or something else?

**Recommendation:**
Clarify that any refusal originating from `checkPackLayer` where `listError !== undefined` throws `new PackError("ERR_PACK_INVALID", listError)`. If `clash.length > 0`, throw `new PackError("ERR_PACK_CONFLICT", clash.join("; "))`.

---

### 1.4 Atomic Write Ordering & Rollback on Re-install Failures (Task 1)

In Task 1 Step 3:
> *"Record path: `<profileDir>/<id>.pack.json`. Write order: toml → record (only when given) → `active.json` (only when not listed)."*

**The Trap:**
- For a **new install**, if writing `<id>.pack.json` fails, `<id>.toml` is left on disk but `active.json` is not updated. The pack remains unlisted and inert.
- For an **update** or **repair**, `packId` is **already listed** in `active.json`.
  - If `<id>.toml` is written first, and then writing `<id>.pack.json` fails (e.g. disk full, permission issue), the store now has the *new* `defaults` active on disk with the *old* (or missing) record!
  - The running reader would pick up the new TOML while `pack list` would report `versionUnknown`.

**Recommendation:**
In `setPackLayer`:
- Use `writeUtf8FileAtomicReplace` for both `<id>.toml` and `<id>.pack.json`.
- On an update/repair, if writing `<id>.pack.json` throws, log or handle the partial write, or write `<id>.pack.json` before `<id>.toml` when `ids.includes(packId)`. However, keeping the uniform order `toml → record → active.json` with `writeUtf8FileAtomicReplace` matches spec § 5.4; ensure tests assert atomic replacement semantics.

---

### 1.5 Job Overrides & User Replaces Detection (Task 3 & Task 5)

In Task 5 Step 3:
> *"userReplaces for jobs comes from `explainConfig(...,"fleet.job")` blocks in a base/profile layer with the same name."*

**The Trap:**
- In `packages/gateway/src/config/layered-merge.ts:52`:
  `[[fleet.job]]` merges by `name`: a higher layer's job replaces a lower layer's same-named one.
- When `explainConfig(layeredConfig, "fleet.job.<name>")` or `explainConfig(layeredConfig, "fleet.job")` is queried, it returns effective entries and notes.
- If the pack being installed introduces a job named `pm-decisions-nightly`, but the user has already configured `[[fleet.job]] name = "pm-decisions-nightly"` in `nimbus.toml` (`base` layer) or in their active profile TOML (`profile` layer), the pack's job will be shadowed by the user's job.
- If `explainConfig` is called before the pack is installed, the pack's job doesn't exist in `layeredConfig` yet! You cannot look for the pack's job in `explainConfig` prior to installation.

**Recommendation:**
Determine `userReplaces` directly by inspecting the current `layeredConfig`:
```ts
const snapshot = getLayeredConfig(deps.configDir).snapshot();
const userJobNames = new Set(
  snapshot.doc.sections
    .filter((s) => s.isArray && s.header === "fleet.job" && (s.layer?.kind === "base" || s.layer?.kind === "profile"))
    .map((s) => s.entries.find((e) => e.key === "name")?.valRaw ? parseString(s.entries.find((e) => e.key === "name")!.valRaw) : undefined)
    .filter((name): name is string => name !== undefined)
);

const jobInputs = packJobs.map((j) => ({
  name: j.name,
  agent: j.agent,
  intervalSeconds: j.interval_seconds,
  userReplaces: userJobNames.has(j.name),
}));
```
This is pure, synchronous, and does not depend on hypothetical post-install `explainConfig` output.

---

## 2. Design Clarifications & Open Questions

### 2.1 Updating a Local-File Pack by ID Alone

- When a pack is installed via `nimbus pack install --file ./my-pack.json`, its installed record records `source: { kind: "file", path: "/abs/path/to/my-pack.json" }`.
- **Question:** If the owner subsequently runs `nimbus pack install my-pack` (without `--file`), should the gateway:
  1. Refuse with `ERR_PACK_NOT_FOUND` (since it is not bundled)?
  2. Or look up the installed record's `source.path` and re-read the file if present?
- **Analysis:** Spec § 5.3 states: *"Where packs come from: Bundled... Local file: nimbus pack install --file <path>"*.
  And Task 5 Step 1 states: *"1. an unknown id → `ERR_PACK_NOT_FOUND`"*.
- **Confirmation:** Local-file packs must always specify `--file <path>` to install or update. Running `nimbus pack install <id>` applies strictly to bundled packs.

---

### 2.2 Suggestions-Only Packs (Empty `defaults`)

- Spec § 5.1 and PR 1 allow `defaults: ""` (a suggestions-only pack).
- **Question:** In Task 3, how does `renderPackPrompt` format a pack with `defaults === ""`?
- In Task 3 Step 1:
  - *"Config defaults — each section printing 'none' when empty"*.
  - *"prints the full defaults text verbatim after the summary: one exact block"*.
- **Suggestion:** When `defaults === ""`, the config defaults, visible agents, and overnight jobs sections each print `none`, and the verbatim defaults block renders as `(empty)` or an empty fenced block.

---

### 2.3 Bundled Pack Fleet Jobs Parameter Requirement Verification

- Task 2 Step 1 notes:
  > *"If `checkPackFleetJobs` requires a param for `decisions` or `changelog`, add the minimal param it names, and ledger a ruling."*
- **Investigation:** Inspecting `packages/gateway/src/fleet/fleet-sweep-support.ts:87-108`:
  `fleetSweepProblem(job)` checks sweeps and federation parameters (`namespace`/`namespaces`). Neither `pm-decisions-nightly` nor `devops-changelog-nightly` configures `sweep = ...` or federation namespaces. Furthermore, both `decisions` and `changelog` have status `"eligible"` in `FLEET_ELIGIBILITY` (`ipc/agents-rpc.ts`).
- **Conclusion:** Neither job requires additional parameters. Both bundled packs validate cleanly with the exact TOML blocks specified in spec § 5.10.

---

### 2.4 D36 Static Rule Verification Across All Existing Files

- The static rule D36 specifies:
  `\bsetPackLayer\b and \bremovePackLayer\b may be named in non-test files under packages/gateway/src/ only by packs/pack-layer-store.ts and packs/pack-install.ts.`
- An audit of `packages/gateway/src/` confirms that `setPackLayer` and `removePackLayer` are currently named **only** in `packages/gateway/src/packs/pack-layer-store.ts` (and test files).
- `assemble.ts` calls only `createPackLayerStore(...)`.
- **Conclusion:** D36 is completely clean; no existing non-test files will trigger false positives.

---

## 3. Concrete Implementation Refinements

### 3.1 Structure of `PackListResult.available`

In Task 5:
```ts
export type PackListResult = {
  readonly profile: string;
  readonly installed: readonly {
    id: string; name: string; version: string; source: "bundled" | "file";
    updateAvailable: boolean; bundledVersion?: string; versionUnknown?: true;
  }[];
  readonly available: readonly { id: string; name: string; version: string; description: string }[];
  readonly skipped: readonly SkippedPack[];
  readonly listError?: string;
};
```
- Ensure `available` is derived as:
  ```ts
  const installedIds = new Set(installed.map((p) => p.id));
  const available = [...deps.bundled.values()]
    .filter((b) => !installedIds.has(b.id))
    .map((b) => ({ id: b.id, name: b.name, version: b.version, description: b.description }));
  ```
  This guarantees installed bundled packs do not appear under `available`.

---

### 3.2 Audit Log Payload Stripping for `pack.install`

In Task 4:
In `packages/gateway/src/engine/executor.ts`:
```ts
function auditPayload(
  action: PlannedAction,
  extras: { hitlRejectReason?: string } | undefined,
): string {
  let auditedAction = action;
  if (action.type === "pack.install" && action.payload !== undefined) {
    const { promptText: _dropped, ...rest } = action.payload;
    auditedAction = { ...action, payload: rest };
  }
  return redactAuditPayload(extras === undefined ? { action: auditedAction } : { action: auditedAction, ...extras });
}
```
And similarly in `consentDisplayPayload`:
```ts
if (action.type === "pack.install" && action.payload !== undefined) {
  const { promptText: _dropped, ...rest } = action.payload;
  return redactPayloadForConsentDisplay(rest) as Record<string, unknown>;
}
```
This ensures the multi-kilobyte `promptText` (which contains `defaults` verbatim) never clutters the SQLite audit table.

---

### 3.3 Safe Terminal Printing in `nimbus pack`

In Task 7 Step 1:
> *"Every gateway-sourced string printed passes through `stripControlChars`."*
- Ensure `stripControlChars` (from `packages/cli/src/lib/format-helpers.ts` or local equivalent) is applied to `manifest.name`, `manifest.description`, `manifest.version`, `packId`, and status strings before outputting to terminal stdout/stderr.

---

### 3.4 Invariant Ceiling Bump (Task 6)

In Task 6 Step 3:
- Invariant range updates: `I1–I46` → `I1–I47`.
- Static rule range updates: `D10–D35` → `D10–D36`.
- Verify every document checked by `bun run audit:status-drift`:
  - `docs/SECURITY-INVARIANTS.md`
  - `docs/architecture.md`
  - `docs/README.md`
  - `.github/SECURITY.md`
  - `CLAUDE.md`
  - `GEMINI.md`
  - `.claude/commands/nimbus-file-map.md`
  - `.claude/commands/nimbus-tool-output-envelope.md`
  - `.claude/commands/nimbus-tauri-allowlist.md`

---

## 4. Test Matrix & Verification Checklist

| Phase | Test Command | Verification Focus |
|---|---|---|
| **Task 1** | `bun test packages/gateway/src/packs/pack-layer-store.test.ts` | Record sidecar write order (`toml → record → active.json`), non-writing `checkPackLayer`, ENOENT tolerance |
| **Task 2** | `bun test packages/gateway/src/packs/bundled-packs.test.ts packages/gateway/src/packs/pack-record.test.ts packages/gateway/src/packs/pack-validate.test.ts` | Static bundled pack embedding, record parsing/serialization, validation against live catalog connector/agent sets |
| **Task 3** | `bun test packages/gateway/src/packs/pack-prompt.test.ts` | `visibleText` escaping, prompt sections ("none" when empty), verbatim defaults, `diffPacks` (scalars, visible agents, job blocks) |
| **Task 4** | `bun test packages/gateway/src/engine/executor.test.ts packages/gateway/src/ipc/server/demo-gate.test.ts packages/gateway/src/ipc/lan-rpc.test.ts` | `pack.install` in `HITL_REQUIRED`, delegate fallback, audit payload scrubbing, demo denial for install/remove, LAN denial for `pack.*` |
| **Task 5** | `bun test packages/gateway/src/packs/pack-install.test.ts packages/gateway/src/ipc/pack-rpc.test.ts packages/gateway/test/e2e/pack.e2e.test.ts` | Install refusal ordering, gate approval/denial, repair mode on tampered TOML, update mode diff, RPC method dispatch & error codes |
| **Task 6** | `bun run audit:invariants && bun test packages/gateway/src/security-invariants.test.ts -t I47` | D36 static rule enforcement, I47 invariant triple rule validation |
| **Task 7** | `bun test packages/cli/src/commands/pack.test.ts` | TTY enforcement, no `--yes` enforcement, stat size pre-check (128 KiB), human vs `--json` output |
| **Task 8** | `bun run preflight:fast` | Full typecheck, Biome linting, boundary checks, doc-refs |

---

## Conclusion

The plan for PR 2 is comprehensive, precise, and rigorously engineered. Addressing the order of manifest parsing for local file checks, ensuring terminal consent isolation in `pack.ts`, and computing job overrides directly against current config will guarantee a clean, reliable, and secure implementation.
