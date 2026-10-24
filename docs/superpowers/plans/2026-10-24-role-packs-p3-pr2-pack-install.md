# Role packs P3 PR 2: install, remove, the `pack.install` gate, the CLI and the bundled packs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `nimbus pack list | show | install | remove` over CLI-only `pack.*` IPC methods. `install`
is one owner approval (new HITL type `pack.install`, invariant I47, static rule D36) that shows
everything the pack changes, plus the exact `defaults` text. The `pm` and `devops` packs ship bundled.

**Architecture:** Pure pieces first:
- **Store:** `pack-layer-store.ts` gains a record sidecar and a non-writing `checkPackLayer`.
- **Bundled packs and validation:** `packs/bundled-packs.ts` and `packs/pack-validate.ts`.
- **Prompt and diff rendering:** `packs/pack-prompt.ts`.

Then one orchestration module, `packs/pack-install.ts`, which is the only caller of the store's
write methods (D36). It sits behind a thin `ipc/pack-rpc.ts`, which is routed from `server.ts` the
way `registry.*` is, because it needs the caller's `clientId` for the unicast consent prompt. The
executor gains the `pack.install` type in I2, the I20 delegate fallback, a type-keyed prompt branch,
and audit stripping of the prompt text.

**Tech Stack:** TypeScript 7 strict, Bun test, `@nimbus-dev/registry-format` (PR 1:
`parseRolePackManifest`, `parseRolePackManifestValue`, `rolePackDigest`, `RolePackManifest`,
`ROLE_PACK_ID_RE`).

**Spec:** `docs/superpowers/specs/2026-10-24-role-packs-p3-the-pack-design.md` §§ 5.3–5.8 and 5.10
(branch `dev/asaf/role-packs` only).

**Out of this PR (PR 3):**
- `[oncall.push] enabled` becomes pack-settable and live; the DevOps pack gains that line.
- `nimbus doctor` `[info]` for an available update.
- Docs for those two.

**Deferred with a reason (ledger it, do not build):** the spec's § 5.2 `nimbus registry list` note
for a dropped `packs` map. `registry.list` reads only the database, so the note would need a new
persisted column (a schema migration), and no registry publishes packs before the trust-layer
project. That project adds it.

## Global Constraints

- **Code rules:**
  - No `any`; external data is `unknown` and narrowed.
  - Paths via `node:path`; no hardcoded separators.
  - Biome clean.
- **Coverage:** every new or changed source file needs ≥ 85 % lines and ≥ 80 % branches
  (`audit:coverage-floor`, CI-Linux-authoritative).
- **Branch:** create `dev/asafgolombek/role-packs-p3-install` from current `main`. The spec and
  this plan never land on `main`.
- **Gateway → CLI over IPC only:** the CLI declares its own result types; it never imports gateway
  source.
- **Error wire shape:** `RpcMethodError(-32000, "<CODE>: <detail>")`; invalid params are
  `RpcMethodError(-32602, "ERR_INVALID_PARAMS: ...")`.
- **Codes:**
  - `ERR_PACK_NOT_FOUND`, `ERR_PACK_ID_RESERVED`, `ERR_PACK_LOCAL_FILE_PRODUCTION`,
    `ERR_PACK_MEMBERS_UNSUPPORTED`, `ERR_PACK_CONFLICT`, `ERR_PACK_INVALID`.
  - `ERR_PACK_INSTALL_NOT_APPROVED`, which mirrors `ERR_REGISTRY_ADD_NOT_APPROVED`, the code
    `registry.add` returns for the same outcome.
  - `ERR_DEMO_FORBIDDEN` (existing).
- **Gate payload keys must not contain `key`, `auth` or `token`.** `SENSITIVE_PAYLOAD_KEY` redacts by
  substring. Use `packId`, `version`, `source`, `digest`, `promptText`.
- **Invariant triple rule:** I47's wiring, its `docs/SECURITY-INVARIANTS.md` entry and its
  `security-invariants.test.ts` block land in the SAME commit (Task 6). The invariant ceiling
  becomes I1–I47 and the static rules D10–D36 on every surface `audit:status-drift` reads.
- **Bundled pack content** is fixed in Task 2 and taken from spec § 5.10. The DevOps pack carries
  NO `[oncall.push]` line in this PR (that key is not pack-settable until PR 3).

## Review Focus

1. **A damaged install** (the owner deleted or hand-edited `<id>.toml`): re-install with an identical
   digest prompts as a **repair** and rewrites it. It is never "already installed".
2. **`active.json` unreadable or invalid:** install is refused **before** any prompt, naming the
   store's list error. Remove of a listed pack also refuses rather than guessing.
3. **The owner's file already sets a key the pack sets:** the prompt marks it
   `(your file overrides this)`, the install still succeeds, and the effective value is unchanged.
4. **Invisible or control characters in a local-file pack's `name`/`description`/`defaults`:** they
   appear **visibly escaped** (`‮`) in the prompt, never raw.
5. **Removing a pack that is not installed** returns `removed: false` with no error, and touches no
   file.

Each has its test in the owning task.

---

### Task 1: Store record sidecar and the non-writing check

**Files:**
- Modify: `packages/gateway/src/packs/pack-layer-store.ts`
- Test: `packages/gateway/src/packs/pack-layer-store.test.ts`

**Interfaces:**
- Produces (extending `PackLayerStore`):
  ```ts
  setPackLayer(profile: string, packId: string, fragment: string,
               opts?: { readonly record?: string }): PackWriteResult;
  checkPackLayer(profile: string, packId: string, fragment: string): readonly string[];
  readPackRecord(profile: string, packId: string): string | undefined; // undefined on ENOENT or unreadable
  readPackLayerText(profile: string, packId: string): string | undefined; // the on-disk <id>.toml, raw
  // removePackLayer unchanged in signature; it now also unlinks <id>.pack.json
  ```

- [ ] **Step 1: Write failing tests** (`describe("record sidecar and checkPackLayer")`):
  - `checkPackLayer returns the same problems setPackLayer would throw, and writes nothing`:
    a conflict case, a non-allowlisted key, a bad pack id and an invalid profile. For each, the
    profile dir has no new file.
  - `checkPackLayer reports an unreadable active.json` (Review Focus 2): write `active.json` =
    `"{"`, and expect `["active.json is not valid JSON"]`.
  - `setPackLayer with a record writes toml, then record, then active.json`: assert all three files
    exist, and `readPackRecord` returns the record text verbatim.
  - `write order: a failure writing the record leaves the pack unlisted`: inject the failure by
    making `<id>.pack.json` a directory. `setPackLayer` throws, and `active.json` does not list the
    id.
  - `removePackLayer deletes the record too, delisting first`.
  - `removePackLayer on an id that is not installed returns removed false and touches nothing`
    (Review Focus 5): no `active.json` is created.
  - `readPackLayerText returns the raw on-disk text, undefined when absent`.
  - `setPackLayer without opts.record behaves as before` (existing tests stay green).

- [ ] **Step 2:** `bun test packages/gateway/src/packs/pack-layer-store.test.ts`. Expected: FAIL
  (`checkPackLayer is not a function`).

- [ ] **Step 3: Implement.**
  - `checkPackLayer` = `assertNames` problems (caught, not thrown) + the `readDetailed` `listError`
    + `checkPackFragment` problems + `conflicts`.
  - `setPackLayer` calls `checkPackLayer` and throws `PackLayerRefusedError` on a non-empty result,
    so there is ONE check.
  - Record path: `<profileDir>/<id>.pack.json`. Write order: toml → record (only when given) →
    `active.json` (only when not listed).
  - `removePackLayer` unlinks toml then record, ENOENT-tolerant, after delisting.
  - Every message keeps passing through `safe()`.

- [ ] **Step 4:** the same command. Expected: PASS.

- [ ] **Step 5: Commit**
  `feat(packs): a pack record sidecar and a non-writing layer check`.

### Task 2: Bundled packs, record parsing and content validation

**Files:**
- Create: `packages/gateway/src/packs/bundled/pm.json`, `packages/gateway/src/packs/bundled/devops.json`
- Create: `packages/gateway/src/packs/bundled-packs.ts`, `packages/gateway/src/packs/pack-record.ts`,
  `packages/gateway/src/packs/pack-validate.ts`
- Modify: `packages/gateway/src/catalog/catalog-list.ts` (export the built-in connector id list it
  already derives)
- Test: `bundled-packs.test.ts`, `pack-record.test.ts`, `pack-validate.test.ts` (same directory)

**Interfaces:**
- Consumes: Task 1; registry-format PR 1 exports; `checkPackFragment`, `checkPackFleetJobs`
  (`config/pack-settable.ts`, `packs/pack-job-check.ts`); `CATALOG_AGENT_NAMES`
  (`catalog/agent-catalog.ts`); `normaliseAgentName` (`catalog/agent-visibility.ts`).
- Produces:
  ```ts
  // catalog-list.ts (no behaviour change; buildCatalogList uses it)
  export function builtinCatalogConnectorIds(): readonly string[];
  // bundled-packs.ts — parsed with parseRolePackManifestValue at module load; throws on a bad file
  export const BUNDLED_PACKS: ReadonlyMap<string, RolePackManifest>;
  // pack-record.ts
  export type PackSource = { readonly kind: "bundled" } | { readonly kind: "file"; readonly path: string };
  export type InstalledPackRecord = {
    readonly manifest: RolePackManifest; readonly digest: string;
    readonly source: PackSource; readonly installedAt: string; // ISO-8601
  };
  export function serializePackRecord(r: InstalledPackRecord): string;
  export function parsePackRecord(text: string): InstalledPackRecord | undefined; // never throws
  // pack-validate.ts — problems only; members are NOT checked here (Task 5 has its own code)
  export function validatePackContent(
    m: RolePackManifest,
    deps: { readonly connectorIds: ReadonlySet<string>; readonly agentNames: ReadonlySet<string> },
  ): readonly string[];
  ```

- [ ] **Step 1: Write the two bundled files exactly (spec § 5.10).**
  - `pm.json`:
    - `id: "pm"`, `name: "Product"`, `version: "1.0.0"`,
      `description: "Decisions, glossary and catch-up for product work."`, `roles: ["product"]`;
    - `suggestedConnectors: ["slack", "jira", "notion", "google_drive"]`, `members: []`;
    - `defaults`:
      ```
      [agents]
      visible = ["decisions", "glossary", "catchup"]

      [fleet]
      enabled = true

      [[fleet.job]]
      name = "pm-decisions-nightly"
      agent = "decisions"
      interval_seconds = 86400
      ```
  - `devops.json`:
    - `id: "devops"`, `name: "DevOps"`, `version: "1.0.0"`,
      `description: "On-call and delivery: incidents, what changed, and who owns it."`,
      `roles: ["devops", "sre"]`;
    - `suggestedConnectors: ["pagerduty", "github", "github_actions", "slack", "sentry"]`,
      `members: []`;
    - `defaults`: `[agents] visible = ["oncall", "why", "impact", "ownership", "catchup",
      "changelog", "standup"]`, `[fleet] enabled = true`, and one job `devops-changelog-nightly`,
      agent `changelog`, `interval_seconds = 86400`.
  - If `checkPackFleetJobs` requires a param for `decisions` or `changelog`, add the minimal param
    it names, and ledger a ruling.

- [ ] **Step 2: Write failing tests:**
  - **bundled-packs:**
    - `BUNDLED_PACKS holds pm and devops`.
    - `every bundled pack passes checkPackFragment with checkPackFleetJobs`.
    - `every bundled pack passes validatePackContent against the live catalog`.
    - `pm and devops install into one temp profile without conflict` — real `createPackLayerStore`
      over a temp dir, `setPackLayer` both.
  - **pack-record:**
    - `round-trips`.
    - `parsePackRecord refuses`: bad JSON, a missing field, a manifest that fails
      `parseRolePackManifestValue`, a `digest` not equal to `rolePackDigest(manifest)`, and a
      `source.kind` of `"registry"`. Each returns `undefined`.
  - **pack-validate:** problems for an unknown connector (`"nope"`), an unknown agent in
    `[agents] visible` (`"owners"`), and `"agents.oncall"` accepted (normalised). A clean bundled
    pack returns `[]`.

- [ ] **Step 3:** `bun test packages/gateway/src/packs packages/gateway/src/catalog`. Expected: FAIL
  (modules missing).

- [ ] **Step 4: Implement.**
  - `bundled-packs.ts` imports the two JSON files statically (`import pm from "./bundled/pm.json"
    with { type: "json" }`, or the repo's existing JSON-import form), so `bun build --compile`
    embeds them.
  - `validatePackContent` reads `[agents] visible` through `checkPackFragment(...).lists`.

- [ ] **Step 5:** the same command. Expected: PASS.

- [ ] **Step 6: Commit**
  `feat(packs): bundled pm and devops packs, the install record, content validation`.

### Task 3: The prompt and the update diff (pure)

**Files:**
- Create: `packages/gateway/src/packs/pack-prompt.ts`
- Test: `packages/gateway/src/packs/pack-prompt.test.ts`

**Interfaces:**
- Consumes: Task 2 types; `FORMAT_INVISIBLE_RANGES` and `rangesRegExp`
  (`mcp-sink/invisible-text.ts`).
- Produces:
  ```ts
  export function visibleText(s: string): string; // C0 except LF/TAB + FORMAT_INVISIBLE_RANGES → \uXXXX / \u{X}
  export type PromptScalar = {
    readonly key: string;             // "fleet.enabled"
    readonly packValue: string;
    readonly current: string | undefined;
    readonly currentLayer: string | undefined; // e.g. "pack devops", "nimbus.toml", "default"
    readonly userOverrides: boolean;
  };
  export type PackDiff = {
    readonly scalars: { readonly added: string[]; readonly removed: string[]; readonly changed: string[] };
    readonly visible: { readonly added: string[]; readonly removed: string[] };
    readonly jobs: { readonly added: string[]; readonly removed: string[]; readonly changed: string[] };
    readonly connectors: { readonly added: string[]; readonly removed: string[] };
    readonly metadataOnly: boolean;  // defaults text byte-identical
  };
  export function diffPacks(prev: RolePackManifest, next: RolePackManifest): PackDiff;
  export type PackPromptInput = {
    readonly manifest: RolePackManifest;
    readonly source: PackSource;
    readonly mode: "install" | "update" | "repair";
    readonly diff?: PackDiff;                          // required when mode === "update"
    readonly scalars: readonly PromptScalar[];
    readonly visibleAgents: readonly string[];
    readonly jobs: readonly { readonly name: string; readonly agent: string; readonly intervalSeconds: number; readonly userReplaces: boolean }[];
    readonly connectors: readonly { readonly id: string; readonly configured: boolean }[];
  };
  export function renderPackPrompt(input: PackPromptInput): string;
  ```

- [ ] **Step 1: Write failing tests:**
  - `install prompt has every section, each printing "none" when empty`: the header names name, id,
    version and source (`bundled` / `local file <path>`), then the sections Config defaults,
    Visible agents, Overnight jobs and Suggested connectors.
  - `marks a user override` (Review Focus 3): `(your file overrides this)`.
  - `marks a job the owner replaces`: `(replaced by your own job of this name)`.
  - `connectors read configured / not configured`, in manifest order.
  - `prints the full defaults text verbatim after the summary`: one exact block.
  - `closing line`, with this exact copy: `This pack changes no credentials, no network reach and no
    approvals, and your nimbus.toml is not edited. Undo it with: nimbus pack remove <id>`.
  - `escapes invisible and control characters` (Review Focus 4): a name containing `‮` renders
    as the literal `‮`; a `\u0007` in `defaults` renders as `\u0007`; LF and TAB survive.
  - `update mode lists only the diff, then the full new text`.
  - `metadata-only update says "no config changes"`.
  - `repair mode says the on-disk layer no longer matches and shows the full text`.
  - **`diffPacks`:**
    - scalar added, removed and changed;
    - a visible agent added and removed;
    - a job added, removed and changed (same name, different block text);
    - connectors added and removed;
    - `metadataOnly` true only for byte-identical `defaults`.

- [ ] **Step 2:** `bun test packages/gateway/src/packs/pack-prompt.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.**
  - Diff jobs by splitting `defaults` into `[[fleet.job]]` blocks keyed by their `name = "..."`
    line: a private `jobBlocks(text): Map<string, string>`, where a block runs from its header to
    the next `[`-header or EOF. A job is "changed" when its block text differs.
  - Diff scalars and visible agents from `checkPackFragment(...).scalars/.lists` of each side.
  - All manifest-sourced strings pass through `visibleText` before rendering.

- [ ] **Step 4:** the same command. Expected: PASS.

- [ ] **Step 5: Commit** `feat(packs): the pack.install prompt and update diff`.

### Task 4: The executor's `pack.install` type, demo and LAN refusals

**Files:**
- Modify: `packages/gateway/src/engine/executor.ts`, `packages/gateway/src/ipc/server/demo-gate.ts`,
  `packages/gateway/src/ipc/lan-rpc.ts`
- Test: `engine/executor.test.ts` (or its nearest existing consent-prompt test file),
  `ipc/server/demo-gate.test.ts`, `ipc/lan-rpc.test.ts`

**Interfaces:**
- Produces:
  - `"pack.install"` in `HITL_REQUIRED`, with a comment naming the gate site
    (`packs/pack-install.ts`, through the gate-only executor `ipc/server/dispatchers.ts` builds per
    call) and "Never delegable".
  - `tryDelegatedApproval` returns `"fallback"` for `pack.install`.
  - `formatConsentPrompt`: when `action.type === "pack.install"` and `payload.promptText` is a
    string, the prompt is `Action requires your approval\n\nType: pack.install\n\n<promptText>`, and
    no `Details:` line.
  - `consentDisplayPayload` and `auditPayload` drop `promptText` for `pack.install` only.
  - `demo-gate.ts`: `"pack.install"` and `"pack.remove"` in `DEMO_REFUSED_METHODS`.
  - `lan-rpc.ts`: `"pack"` in `FORBIDDEN_OVER_LAN`, with a one-line comment.

- [ ] **Step 1: Write failing tests:**
  - `pack.install is HITL-required` (via the module's existing frozen-set accessor or behaviour test).
  - `a delegate never approves pack.install`: delegation configured, and the gate still asks the
    local owner (mirror the `registry.add` test).
  - `pack.install prompt prints promptText, not a Details JSON line`.
  - `another action type with a promptText payload still gets the generic Details line`.
  - `the pack.install audit row carries packId/version/source/digest and no promptText` (read the
    recorded `actionJson`).
  - `demoRefusal refuses pack.install and pack.remove, allows pack.list and pack.show`.
  - `pack.list is forbidden over LAN`.

- [ ] **Step 2:** run the three test files. Expected: FAIL.

- [ ] **Step 3: Implement** as the Produces block says.

- [ ] **Step 4:** run the three test files. Expected: PASS.

- [ ] **Step 5: Commit**
  `feat(engine): the pack.install HITL type, never delegable, refused on demo and LAN`.

### Task 5: Install orchestration, `pack.*` RPC, routing and wiring

**Files:**
- Create: `packages/gateway/src/packs/pack-install.ts`, `packages/gateway/src/ipc/pack-rpc.ts`
- Modify: `packages/gateway/src/ipc/server/dispatchers.ts` (`tryDispatchPackRpc`),
  `packages/gateway/src/ipc/server/server.ts` (call it right after `tryDispatchRegistryRpc`),
  `packages/gateway/src/ipc/server/options.ts` (`packLayerStore?: PackLayerStore`),
  `packages/gateway/src/platform/assemble.ts` (build the store ONCE; pass it to `initLayeredConfig`
  and to the IPC options)
- Test: `packages/gateway/src/packs/pack-install.test.ts`, `packages/gateway/src/ipc/pack-rpc.test.ts`,
  `packages/gateway/test/e2e/pack.e2e.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4; `isProductionRuntime` (`platform/runtime-layout.ts`); `isConnectorConfigured`
  (`sync/connector-configured.ts`); `getLayeredConfig` / `explainConfig`; `buildExtensionGateExecutor`
  (dispatchers.ts, unchanged).
- Produces:
  ```ts
  // pack-install.ts
  export type PackErrorCode = "ERR_PACK_NOT_FOUND" | "ERR_PACK_ID_RESERVED" | "ERR_PACK_LOCAL_FILE_PRODUCTION"
    | "ERR_PACK_MEMBERS_UNSUPPORTED" | "ERR_PACK_CONFLICT" | "ERR_PACK_INVALID" | "ERR_PACK_INSTALL_NOT_APPROVED";
  export class PackError extends Error { constructor(readonly code: PackErrorCode, readonly detail: string); }
  export type PackRequest = { readonly id: string } | { readonly fileText: string; readonly filePath: string };
  export type PackOwnerGate = (action: { type: "pack.install"; payload: Record<string, unknown> }) => Promise<boolean>;
  export type PackDeps = {
    readonly store: PackLayerStore;
    readonly configDir: string;            // for getLayeredConfig/explainConfig and the profile
    readonly bundled: ReadonlyMap<string, RolePackManifest>;
    readonly isProduction: () => boolean;
    readonly isConfigured: (serviceId: string) => Promise<boolean>;
    readonly connectorIds: ReadonlySet<string>;
    readonly agentNames: ReadonlySet<string>;
    readonly now: () => Date;
  };
  export type InstallOutcome = "installed" | "updated" | "repaired" | "already_installed";
  export async function installPack(req: PackRequest, deps: PackDeps, gate: PackOwnerGate):
    Promise<{ outcome: InstallOutcome; id: string; version: string; snapshotVersion: number | null }>;
  export async function previewPack(req: PackRequest, deps: PackDeps):
    Promise<{ prompt: string; mode: "install" | "update" | "repair" | "already_installed" }>;
  export function removePack(id: string, deps: PackDeps): { removed: boolean; snapshotVersion: number | null };
  export function listPacks(deps: PackDeps): PackListResult;
  export type PackListResult = {
    readonly profile: string;
    readonly installed: readonly { id: string; name: string; version: string; source: "bundled" | "file";
      updateAvailable: boolean; bundledVersion?: string; versionUnknown?: true }[];
    readonly available: readonly { id: string; name: string; version: string; description: string }[];
    readonly skipped: readonly SkippedPack[];
    readonly listError?: string;
  };
  // pack-rpc.ts
  export async function dispatchPackRpc(method: string, params: unknown, deps: PackDeps,
    gate: PackOwnerGate | undefined): Promise<{ kind: "hit"; value: unknown } | { kind: "skip" }>;
  ```
  Methods and params:
  - `pack.list`: no params.
  - `pack.show`: `{ id } | { fileText, filePath }`.
  - `pack.install`: `{ id } | { fileText, filePath }`.
  - `pack.remove`: `{ id }`.

  `PackError` maps to `RpcMethodError(-32000, "<code>: <detail>")`. `pack.install` without a gate is
  `-32603`, which mirrors registry.

- [ ] **Step 1: Write failing tests** for `pack-install.test.ts`. Use a temp `configDir` with a real
  store, a real `LayeredConfig` (`initLayeredConfig(dir, { packs: store })`) and a recording fake
  gate.
  - **The fixed order** of spec § 5.5. Each case asserts which step refused and that the
    **gate was never called** (call count 0) and no file was written:
    1. an unknown id → `ERR_PACK_NOT_FOUND`;
    2. a `fileText` while `isProduction()` is true → `ERR_PACK_LOCAL_FILE_PRODUCTION`;
    3. a file pack with id `pm` → `ERR_PACK_ID_RESERVED`;
    4. a manifest parse failure → `ERR_PACK_INVALID`;
    5. a non-empty `members` → `ERR_PACK_MEMBERS_UNSUPPORTED`;
    6. an unknown connector or agent, or a non-allowlisted key → `ERR_PACK_INVALID`;
    7. a scalar conflict with another installed pack → `ERR_PACK_CONFLICT`, naming the key;
    8. an unreadable `active.json` → refused with its list error (Review Focus 2).
  - **Approval:**
    - approved → `installed`: the layer and record are written, the snapshot version advances,
      and `config explain fleet.enabled` names the pack layer;
    - denied → `ERR_PACK_INSTALL_NOT_APPROVED` and nothing written.
  - **The gate payload:** `{ packId, version, source, digest, promptText }`. `promptText` contains
    the full `defaults` text.
  - **Re-installs:**
    - an identical digest with an intact layer → `already_installed` and NO gate call;
    - an identical digest with the layer deleted or edited → mode `repair`, one gate call, rewritten
      (Review Focus 1);
    - a changed bundled manifest (inject a `bundled` map with v1.1.0) → `updated`, and the prompt
      shows the diff.
  - **List and show:**
    - `listPacks`: available bundled packs, an installed pack, `updateAvailable` true against a
      newer bundled map, `versionUnknown` for a listed pack without a record, and the store's
      `skipped` passed through;
    - `previewPack` with `fileText` returns the prompt and never calls a gate.
  - **Remove:** `removePack` of an installed pack restores `config explain fleet.enabled` to its
    pre-install layer. Remove of an unknown id → `removed: false` (Review Focus 5).

  For `pack-rpc.test.ts`:
  - param validation for each method: wrong shapes → `-32602`;
  - each method routes to its function;
  - `pack.install` with no gate → `-32603`.

  `pack.e2e.test.ts` uses `startRealGateway` and `TinyIpcClient`, as
  `test/e2e/catalog-list.e2e.test.ts` does:
  - `pack.list` over a real socket lists `pm` and `devops` as available;
  - `pack.remove {id:"pm"}` returns `{ removed: false }`;
  - `pack.install {id:"nope"}` returns the `ERR_PACK_NOT_FOUND` message.

  This proves the outer routing. The approval path is covered in-process above.

- [ ] **Step 2:** `bun test packages/gateway/src/packs packages/gateway/src/ipc/pack-rpc.test.ts`.
  Expected: FAIL.

- [ ] **Step 3: Implement.**
  - `installPack` follows the numbered order above.
  - Scalar rows come from `explainConfig(getLayeredConfig(configDir), "<section>.<key>")`, using its
    winning entry's `source`. `userOverrides` is true when that layer kind is `base` or `profile`.
  - `userReplaces` for jobs comes from `explainConfig(...,"fleet.job")` blocks in a
    `base`/`profile` layer with the same `name`.
  - Update mode compares the record's manifest (`parsePackRecord(store.readPackRecord(...))`) with
    the new one.
  - On approval: `store.setPackLayer(profile, id, defaults, { record: serializePackRecord(...) })`.
  - `removePack` calls `store.removePackLayer`.
  - `tryDispatchPackRpc(ctx, clientId, method, params)`:
    - it skips unless the method starts with `pack.`, and requires `ctx.options.packLayerStore`
      and `configDir`, otherwise `-32603`;
    - it builds `PackDeps` with `isConfigured` bound to `ctx.options.vault` (async
      `isConnectorConfigured(vault, id)`);
    - for `pack.install` it builds the gate from `buildExtensionGateExecutor(ctx, localIndex,
      clientId)`, exactly as `tryDispatchRegistryRpc` does.
  - `assemble.ts`: `const packLayerStore = createPackLayerStore({ configDir: paths.configDir })`,
    used by `initLayeredConfig` AND passed to the IPC server options. That is one store, so its
    `onChange` bumps the running reader.

- [ ] **Step 4:** the Step 2 command plus `bun test packages/gateway/test/e2e/pack.e2e.test.ts`.
  Expected: PASS. If a local `dist/` exists, move it aside first: a stale gateway binary shadows
  source in e2e runs.

- [ ] **Step 5: Commit**
  `feat(packs): pack.list/show/install/remove behind the owner's pack.install approval`.

### Task 6: I47, D36 and the invariant docs (triple rule, one commit)

**Files:**
- Modify: `scripts/structure-audit/check-nimbus-invariants.ts` (+ its test file for rule unit tests),
  `packages/gateway/src/security-invariants.test.ts`, `docs/SECURITY-INVARIANTS.md`,
  `CLAUDE.md`, `GEMINI.md`, `docs/architecture.md`, `docs/README.md`, `.github/SECURITY.md`,
  `.claude/commands/nimbus-file-map.md`, `.claude/commands/nimbus-tool-output-envelope.md`,
  `.claude/commands/nimbus-tauri-allowlist.md`, and any other file
  `rg "I1[–-]I46|D10[–-]D35"` finds outside `docs/CHANGELOG.md`.

**Interfaces:**
- **D36 (`pack-layer-writers`):**
  - `\bsetPackLayer\b` and `\bremovePackLayer\b` may be named in non-test files under
    `packages/gateway/src/` only by `packs/pack-layer-store.ts` and `packs/pack-install.ts`.
  - Scan after `stripStringLiterals(stripComments(...))`, the same shape as `checkRunGrantWriters`
    (D33(c)).
  - Register it in the `binary-only`/`all` block with an `::error ...::D36 ...` line.
- **I47 wording** (SECURITY-INVARIANTS entry and the CLAUDE.md/GEMINI.md bullet): a role-pack layer
  is written only by `packs/pack-install.ts`, after the LOCAL owner approved `pack.install`. The
  approval comes over a prompt that showed the pack's exact `defaults` text. The type is in the I2
  frozen set, never delegable (I20), refused on a demo-rooted gateway (I41), LAN-forbidden, and
  executed gate-only with `NULL_EGRESS_SINK` (I29).
  - Removal is ungated.
  - Bounds: the TTY requirement on `nimbus pack install` is a CLI-side guard; a pack can set only
    allowlisted keys; a member-extension pack is refused for every caller; static D36 sees only a
    named call.
  - Sites: `packs/pack-install.ts`, `packs/pack-layer-store.ts`, `ipc/pack-rpc.ts`,
    `ipc/server/dispatchers.ts`, `engine/executor.ts`.

- [ ] **Step 1: Write the failing tests.**
  - The D36 rule unit test: a fixture file naming `setPackLayer` outside the allow-list is a
    violation, and the two allowed files are not.
  - The `security-invariants.test.ts` block
    `describe("I47 — a role-pack layer is written only after the owner approved pack.install over its exact text")`:
    - `pack.install is in the frozen HITL set and falls back past a delegate`;
    - `a denied approval writes no layer, record or active.json` (drive `installPack` with a
      denying gate over a temp dir);
    - `the approved prompt contained the defaults text verbatim, and the audit row does not`;
    - `a member-extension pack and a production local file are refused before the gate`;
    - `pack.install and pack.remove are demo-refused; the pack namespace is LAN-forbidden`;
    - `only pack-install.ts and the store name setPackLayer/removePackLayer` (a source-grep pin
      over `packages/gateway/src`, the D33(c) style).

- [ ] **Step 2:** `bun run audit:invariants` and
  `bun test packages/gateway/src/security-invariants.test.ts -t I47`. Expected: the new tests FAIL
  until the rule is registered.

- [ ] **Step 3: Implement the rule and write the docs.**
  - Add the I47 section in `docs/SECURITY-INVARIANTS.md`, set its ceiling to I1–I47 and D10–D36,
    with D36 named as its static rule (so I47 does NOT join the "no static rule of its own" list).
  - Add the I47 bullet after I46 in CLAUDE.md and GEMINI.md, plus a D36 sentence in the
    "Static complement" paragraph.
  - Update every `I1–I46` / `D10–D35` range.
  - Update CLAUDE.md/GEMINI.md line 8 `Invariants I1–I46` → `I1–I47`.

- [ ] **Step 4:** `bun run audit:invariants`, `bun run audit:status-drift`, `bun run audit:doc-refs`,
  and `bun test packages/gateway/src/security-invariants.test.ts`. Expected: all pass.

- [ ] **Step 5: Commit** (one commit, triple rule)
  `feat(security): I47 — role-pack layers are written only behind the owner's pack.install approval`.

### Task 7: The CLI `nimbus pack`

**Files:**
- Create: `packages/cli/src/commands/pack.ts`, `packages/cli/src/commands/pack.test.ts`
- Modify: `packages/cli/src/commands/index.ts`, `packages/cli/src/index.ts` (`pack: runPack` in
  `COMMAND_HANDLERS`), `docs/cli-reference.md`, `docs/CHANGELOG.md`, and the `nimbus-commands`
  skill (`.claude/commands/nimbus-commands.md`)

**Interfaces:**
- Produces: `export async function runPack(args: string[]): Promise<void>`, plus a testable
  `runPackWith(args, io: PackIo, call: <T>(method: string, params: unknown) => Promise<T>)`.
  `PackIo` = `{ stdinIsTty, stdoutIsTty, readFile(path): string, statSize(path): number, out(s), err(s) }`.
  Its own structural result types, never gateway imports.
- Subcommands:
  - `list [--json]`
  - `show <id> | --file <path> [--json]`
  - `install <id> | --file <path>`
  - `remove <id>`
  - Unknown → usage, exit 2.

- [ ] **Step 1: Write failing tests** (DI, no `mock.module`):
  - `install refuses non-TTY` with copy `Refusing to install a pack in non-TTY mode: the approval
    must be answered at a terminal.`, and makes no IPC call.
  - `install has no --yes`, refused, and makes no call.
  - `install --file refuses a file over 131072 bytes before reading it` (statSize).
  - `install --file sends { fileText, filePath }` with the absolute path.
  - `list prints installed and available, marks "update available"`; `--json` prints the raw result.
  - `remove prints "removed"` / `"not installed"`.
  - `an ERR_PACK_* error prints its message and exits 1`.
  - Every gateway-sourced string printed passes through `stripControlChars`.

- [ ] **Step 2:** `bun test packages/cli/src/commands/pack.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.**
  - `install` registers `registerConsentPromptHandler(client)` directly (never `registerConsentFor`,
    which honours `NIMBUS_SCRIPT_CONSENT_SOURCE`), exactly as `runExtensionApprove` does.
  - Use `withGatewayIpc(..., paths, { requestTimeoutMs: BATCH_RPC_TIMEOUT_MS })` for install.
  - `docs/cli-reference.md`: a `nimbus pack` section (the four verbs, TTY-only install, that it acts
    on the active profile, and what it never changes).
  - `docs/CHANGELOG.md`: a dated entry.

- [ ] **Step 4:** the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit** `feat(cli): nimbus pack list, show, install, remove`.

### Task 8: Verify and open the PR

- [ ] **Step 1:** `bun run preflight:fast`. Expected: PASS.
- [ ] **Step 2:** `bun test packages/gateway/src/packs packages/gateway/src/ipc packages/gateway/src/engine packages/cli/src/commands/pack.test.ts packages/gateway/test/e2e/pack.e2e.test.ts packages/gateway/src/security-invariants.test.ts`.
  Expected: 0 fail.
- [ ] **Step 3:** Coverage. Every new source file is ≥ 85 % lines in
  `bun test <its tests> --coverage --coverage-reporter=text`. Add tests for any uncovered branch.
- [ ] **Step 4:** `git diff --name-only origin/main...HEAD | grep superpowers` prints nothing.
- [ ] **Step 5:** Push and open the PR titled
  `feat(packs): install and remove role packs behind the owner's pack.install approval`. The body
  states:
  - what ships;
  - I47/D36;
  - the bundled packs;
  - that PR 3 adds `[oncall.push] enabled`;
  - the deferred `registry list` note and why;
  - the attribution line.
