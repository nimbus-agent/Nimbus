# Design Review: Role Packs — Project 3: The Pack Itself (`2026-10-24-role-packs-p3-the-pack-design.md`)

**Reviewed document:** `docs/superpowers/specs/2026-10-24-role-packs-p3-the-pack-design.md`  
**Companion documents:**
- `docs/superpowers/specs/2026-10-21-role-packs-overview-design.md` (overview)
- `docs/superpowers/specs/2026-10-22-role-packs-p1-foundations-design.md` (Project 1 foundations)
- `docs/superpowers/specs/2026-10-22-role-packs-p1-foundations-design-review.md` (Project 1 review)

**Review date:** 2026-10-24

---

## Overall Assessment

The Project 3 specification is well-architected, tightly aligned with the Programme Overview (§ 5 Project 3), and makes excellent use of the foundations shipped in Project 1 (the `PackLayerStore`, allowlist checking via `checkPackFragment`, keyed fleet job checks via `checkPackFleetJobs`, scalar conflict detection, and `[agents] visible`). 

Keeping packs purely declarative, separating the manifest format into `@nimbus-dev/registry-format`, making install a single owner-gated HITL transaction (`pack.install`), and refusing member extensions and registry distribution until Phase 9.5 are all the right calls.

Cross-checking the spec against the Gateway, CLI, and registry-format codebases surfaced **4 codebase mismatches to correct in the spec**, **10 concrete design improvements and failure modes to address**, and **5 open questions** for the author before implementation begins.

---

## 1. Codebase Mismatches to Correct in the Spec

### 1.1 `[oncall.push] enabled` live reload: `createOncallPushRunner` holds a stale `config` reference (§ 2, § 5.9)

- **Spec claim (§ 2, § 5.9):**  
  *"The push runtime must pick up a change without a restart: watch the layered snapshot version (the fleet supervisor's pattern) and, on a change, re-read `[oncall.push]` and call `reconcileEnabledState(enabled, now)`..."*
- **Actual code (`packages/gateway/src/oncall-push/push-runtime.ts:64, 101-104` & `push-runner.ts:178-180`):**
  1. In `assembleOncallPushRuntime`:
     ```ts
     const config = loadNimbusOncallPushFromConfigDir(deps.configDir);
     // ...
     const runner = createOncallPushRunner({
       db: deps.db,
       store,
       config, // <--- plain static object passed at boot
       // ...
     });
     ```
  2. In `createOncallPushRunner` (`push-runner.ts:178-180`):
     ```ts
     async function once(): Promise<PushRunSummary> {
       if (!deps.config.enabled) return { selected: 0, ok: 0, failed: 0, skipped: "disabled" };
       const enabledAt = deps.store.enabledAt();
       // ...
     ```
  3. If the supervisor / watcher re-reads `[oncall.push]` and calls `store.reconcileEnabledState(enabled, now)` but does not update `runner`'s config reference, `runner.run(serviceId)` will continue to check the stale `deps.config.enabled` object captured at boot and will immediately skip every run as `"disabled"`!
- **Correction:**  
  Update § 5.9 to specify that `deps.config` in `OncallPushRunnerDeps` must either be a live accessor (`config: () => NimbusOncallPushToml` or an `isEnabled(): boolean` getter), or `assembleOncallPushRuntime` must update `runner`'s config reference upon reconciling the layered snapshot change. Furthermore, the watcher timer must register its shutdown callback on `deps.sidecarStops` (matching `FleetSupervisor`), so it does not outlive gateway shutdown.

---

### 1.2 `ToolExecutor.gate()` renders generic JSON, not the rich multi-section prompt in § 5.6 (§ 5.5 step 4, § 5.6)

- **Spec claim (§ 5.5 step 4, § 5.6):**  
  *"4. Build the prompt (§ 5.6) and raise `pack.install` through the gate on the calling session."*  
  § 5.6 specifies a rich formatted prompt:
  ```text
  Header: pack name, id, version, source...
  - Config defaults — each scalar key...
  - Visible agents — the names...
  - Overnight jobs — each job...
  - Suggested connectors — marked connected/not connected...
  - Closing line: ...
  ```
- **Actual code (`packages/gateway/src/engine/executor.ts:291-297, 403` & `packages/cli/src/lib/interactive-ipc-handlers.ts:22-34`):**
  1. `ToolExecutor.gate` calls `resolveHitlApproval`, which calls:
     ```ts
     this.consent.requestApproval(formatConsentPrompt(action), details, action.type);
     ```
  2. `formatConsentPrompt` in `executor.ts:291-297` is currently generic:
     ```ts
     export function formatConsentPrompt(action: PlannedAction): string {
       const lines = [`Action requires your approval`, ``, `Type: ${action.type}`];
       if (action.payload !== undefined && Object.keys(action.payload).length > 0) {
         lines.push("", `Details: ${JSON.stringify(consentDisplayPayload(action))}`);
       }
       return lines.join("\n");
     }
     ```
  3. The CLI's consent notification handler (`interactive-ipc-handlers.ts:27-28`) simply passes `params.prompt` directly to `@clack/prompts` `confirm({ message })`.
  4. If `pack.install` passes structured data in `action.payload`, `formatConsentPrompt` will stringify the entire payload into a raw single-line JSON string `Details: {"configDefaults":...}`!
- **Correction:**  
  Clarify in § 5.5 and § 5.6 where prompt formatting occurs:
  - Either `formatConsentPrompt(action)` in `executor.ts` must delegate to a dedicated formatter for `pack.install` (or honour a formatted `action.payload.promptText` string), OR
  - `pack-install.ts` builds the formatted prompt string and passes it via `action.payload.promptText`, and `formatConsentPrompt` prints `action.payload.promptText` when present instead of `JSON.stringify(action.payload)`.

---

### 1.3 `PackLayerStore` lacks a public dry-run / conflict-check method (§ 5.5 step 3)

- **Spec claim (§ 5.5 step 3):**  
  *"3. Validate content against the live gateway: `checkPackFragment` + `checkPackFleetJobs` on `defaults`, connector ids against the catalog, conflict check against the profile's other active packs (the store's own check, run as a dry run so a conflict is refused **before** the prompt, with the conflicting keys named)."*
- **Actual code (`packages/gateway/src/packs/pack-layer-store.ts:55-58, 253-275`):**
  1. `PackLayerStore` currently exposes only:
     ```ts
     export type PackLayerStore = PackLayerSource & {
       setPackLayer(profile: string, packId: string, fragment: string): PackWriteResult;
       removePackLayer(profile: string, packId: string): PackWriteResult & { readonly removed: boolean };
     };
     ```
  2. `conflicts()` (`pack-layer-store.ts:253`) is an internal, unexported helper inside `createPackLayerStore`. Calling `setPackLayer` is the *only* way conflict checking is invoked today, and `setPackLayer` writes files immediately on success.
- **Correction:**  
  Extend `PackLayerStore` in `pack-layer-store.ts` with a public dry-run method:
  ```ts
  checkPackLayer(profile: string, packId: string, fragment: string): void;
  ```
  which runs `assertNames`, `checkPackFragment`, and `conflicts` and throws `PackLayerRefusedError` without modifying disk. `pack-install.ts` calls `store.checkPackLayer(...)` in step 3 before raising the gate.

---

### 1.4 `demoRefusal` in `ipc/server/demo-gate.ts` needs `pack.install` and `pack.remove` in `DEMO_REFUSED_METHODS` (§ 2, § 5.5, § 5.7)

- **Spec claim (§ 2, § 5.5, § 5.7):**  
  *"refused on a demo-rooted gateway (`ERR_DEMO_FORBIDDEN`, `ipc/server/demo-gate.ts`), I41."*
- **Actual code (`packages/gateway/src/ipc/server/demo-gate.ts:16-37` & `demo-gate.test.ts:52-67`):**
  1. `demoRefusal` checks:
     ```ts
     const refused =
       method.startsWith("registry.") ||
       (method.startsWith("connector.") && !DEMO_CONNECTOR_READS.has(method)) ||
       DEMO_REFUSED_METHODS.has(method);
     ```
  2. `DEMO_REFUSED_METHODS` is an explicit `Set<string>` listing mutating methods (`vault.set`, `extension.install`, `migration.accept`, etc.).
  3. Methods outside `connector.*` and `registry.*` are NOT blocked unless listed in `DEMO_REFUSED_METHODS` (or matching an explicit prefix).
- **Correction:**  
  Explicitly state in § 5.5 and § 5.7 that `pack.install` and `pack.remove` join `DEMO_REFUSED_METHODS` in `demo-gate.ts` (with tests in `demo-gate.test.ts`), while `pack.list` and `pack.show` remain permitted in demo mode so users can inspect bundled packs.

---

## 2. Design Improvements & Edge Cases by Area

### 2.1 Manifest Format & Hashing (`packages/registry-format/src/role-pack.ts`)

1. **Manifest byte size cap must exceed `MAX_MANIFEST_BYTES` (64 KiB):**
   - In `packages/registry-format/src/caps.ts`, `MAX_MANIFEST_BYTES` is `64 * 1024` (65,536 bytes).
   - In § 5.1, `defaults` alone is capped at 65,536 bytes (`PACK_FRAGMENT_MAX_BYTES`).
   - Because `defaults` is embedded as a JSON string property inside `nimbus.role-pack.json`, JSON string escaping (`\n`, `\"`, `\\`) plus the other top-level keys (`id`, `name`, `description`, `roles`, `suggestedConnectors`) will cause a valid 64 KiB fragment to produce a JSON document of ~70–90 KiB.
   - **Recommendation:** Define `MAX_ROLE_PACK_MANIFEST_BYTES = 128 * 1024` (131,072 bytes) in `caps.ts` specifically for role pack manifests, so valid fragments near 64 KiB parse without tripping an outer document limit.
2. **Deterministic `rolePackDigest` over canonical JSON:**
   - § 5.1 notes: *"BLAKE3 or SHA-256 hex of the canonical manifest bytes, whichever the package already uses for manifests."*
   - In `registry-format`, SHA-256 is the universal standard (`inspect.ts`, `validate-publish.ts`, `index-format.ts`).
   - When bundled manifests are statically imported in Bun (`import pmManifest from "./bundled/pm.json"`), Bun supplies an in-memory JS object, not the raw file string.
   - **Recommendation:** Define `rolePackDigest(manifest: RolePackManifest | string): string` as:
     `createHash("sha256").update(typeof manifest === "string" ? manifest : canonicalize(manifest)).digest("hex")`
     using `@nimbus-dev/sdk`'s `canonicalize`. This guarantees the digest is byte-deterministic across static imports, local files, and pretty-printed JSON formatting.
3. **Explicit character pattern for `suggestedConnectors`:**
   - § 5.1 states: *"each a connector-id shape; existence is checked by the gateway against the catalog, not by the format"*.
   - In `registry-format`, define `CONNECTOR_ID_SHAPE_RE = /^[a-z0-9][a-z0-9_]{0,63}$/` so the pure parser rejects invalid shapes (e.g. paths, spaces, uppercase, control characters) before the gateway queries `CATALOG_CONNECTOR_IDS`.
4. **Member extension ID validation:**
   - For `members: string[]`, specify that each element is checked against `assertSafeExtensionId` (`registry-format/src/extension-id.ts`) before the gateway refuses `manifest.members.length > 0` with `ERR_PACK_MEMBERS_UNSUPPORTED`.

---

### 2.2 Registry Index Entry (`index-format.ts`)

5. **Define the explicit TypeScript interfaces for `packs` in `RegistryIndex`:**
   - § 5.2 states: *"shaped like `extensions` (`id → versions → { manifest digest, size, url }`)"*.
   - Unlike extensions, a pack has no `.tgz` code package. To prevent divergent builder implementations, state the explicit type definition in § 5.2:
     ```ts
     export interface RegistryPackVersionEntry {
       name: string;
       manifest: string;          // relative URL/path to manifest JSON
       manifestSha256: string;    // 64-char hex SHA-256
       manifestSizeBytes: number; // positive integer <= MAX_ROLE_PACK_MANIFEST_BYTES
       publishedAt: string;       // ISO-8601 timestamp
     }

     export interface RegistryPackEntry {
       publisher: { id: string; key: string };
       versions: Readonly<Record<string, RegistryPackVersionEntry>>;
     }
     ```
   - Confirm whether `RegistryPackEntry` includes `publisher` (matching `RegistryExtensionEntry`). Since index signatures cover all top-level keys, validating this structure without executing it ensures Phase 9.5 compatibility.

---

### 2.3 Store & Sidecar Record (`<id>.pack.json`)

6. **Store `suggestedConnectors` in `<id>.pack.json` to enable update diffing:**
   - In § 5.4, `<id>.pack.json` is defined as `{ id, version, digest, source: "bundled" | "file", installedAt }`.
   - In § 5.4, updating an installed pack shows: *"suggested connectors added/removed"*.
   - However, when updating a bundled pack from v1.0.0 to v1.1.0, the gateway binary no longer contains v1.0.0's manifest, and `<id>.toml` contains only TOML defaults (`[agents]`, `[[fleet.job]]`).
   - If `<id>.pack.json` does not store the installed `suggestedConnectors`, the update prompt cannot compute which connectors were added or removed!
   - **Recommendation:** Store either the complete `manifest` or `{ suggestedConnectors: string[] }` inside `<id>.pack.json`:
     ```ts
     export type InstalledPackRecord = {
       id: string;
       version: string;
       digest: string;
       source: { kind: "bundled" } | { kind: "file"; path: string };
       suggestedConnectors: readonly string[];
       installedAt: string; // ISO-8601
     };
     ```
7. **Atomic sidecar deletion in `removePackLayer`:**
   - Today, `PackLayerStore.removePackLayer` (`pack-layer-store.ts:316`) unlinks only `<id>.toml`.
   - If `<id>.pack.json` is written alongside it, `removePackLayer` must unlink `<id>.pack.json` as well.
   - Maintain the safe write order:
     - On install: write `<id>.toml` → write `<id>.pack.json` → write `active.json`.
     - On remove: write `active.json` (delisting) → unlink `<id>.toml` → unlink `<id>.pack.json`.
     A crash at any point leaves unlisted/inert files, preserving the crash-safety invariant.

---

### 2.4 Prompt & Conflict Detection Edge Cases

8. **Connector status check in `pack.install` prompt generation:**
   - § 5.6 states: *"- Suggested connectors — in order, marked `connected` / `not connected`."*
   - To render this, `pack-install.ts` needs to know which suggested connectors have active sync rows or stored credentials.
   - In `ipc/server/dispatchers.ts`, ensure `packRpcOptions` passes `localIndex` (or `db`) so the handler can query `sync_state` / connector health to distinguish `connected` vs `not connected`.
9. **Update diffing against active user overrides:**
   - When a pack is re-installed with changed defaults, what if the user's `nimbus.toml` overrides one of the changed keys?
   - Ensure the diffing engine notes `(your file overrides this)` for updated keys, exactly as initial install does, so the owner isn't led to believe an update will alter a setting their own config pins.

---

### 2.5 CLI Usability & Consistency

10. **Consistent error codes across all refusal paths:**
    - Explicitly catalog all error codes in § 5.8:
      - `ERR_PACK_NOT_FOUND`: named pack id is not in bundled packs or active profile.
      - `ERR_PACK_ID_RESERVED`: local file pack id collides with a bundled pack id.
      - `ERR_PACK_LOCAL_FILE_PRODUCTION`: `--file` used in a production runtime.
      - `ERR_PACK_MEMBERS_UNSUPPORTED`: manifest carries non-empty `members`.
      - `ERR_PACK_CONFLICT`: scalar key or fleet job name conflicts with another active pack.
      - `ERR_PACK_VALIDATION_FAILED`: invalid TOML fragment, unknown agent, or unknown connector.
      - `ERR_PACK_INSTALL_NOT_APPROVED`: owner declined or timed out the consent prompt.
      - `ERR_DEMO_FORBIDDEN`: `pack.install` or `pack.remove` called on a demo gateway.

---

## 3. Open Questions for the Author

1. **Re-installing with identical digest:**
   - § 5.4 states: *"An identical digest is a no-op with "already installed", no prompt."*
   - What if the user hand-edited or accidentally deleted `<id>.toml` on disk, or wants to force re-evaluation of defaults? Should `nimbus pack install <id> --force` be supported, or should the user run `nimbus pack remove <id> && nimbus pack install <id>`?
   - *(Recommendation: keeping removal + install as the recovery path keeps the CLI flag-free and simple in P3).*
2. **`nimbus doctor` update warning severity and exit code:**
   - § 5.4 states: *"nimbus doctor warns once per profile with an update available."*
   - Does this warning cause `nimbus doctor` to return exit code `1` (like skipped packs or dropped fleet jobs), or exit code `0` with an `[info]` / `[advisory]` message?
   - *(Recommendation: use `[info]` with exit code `0` for update available, reserving `exit = 1` for broken/skipped packs, so an available update does not fail CI / doctor health checks before the owner chooses to run it).*
3. **`pack.show` for local files:**
   - Can an owner inspect a local file before installing it (e.g. `nimbus pack show --file <path>`)?
   - Supporting `nimbus pack show --file <path>` in the CLI allows reviewing a local pack's manifest and defaults safely before triggering the install gate.
4. **Behavior when suggested connectors are missing at install time:**
   - If DevOps pack suggests `pagerduty` and `github`, but neither is connected, does `pack.install` succeed and simply show them as `not connected`?
   - *(The spec implies yes — "Display only; the pack connects nothing" — which is the right model; verifying this in the test matrix confirms onboarding is frictionless).*
5. **Short agent names in `[agents] visible`:**
   - PM sets `[agents] visible = ["decisions", "glossary", "catchup"]`.
   - Confirm whether `CATALOG_AGENT_NAMES` (the 17 short names) is the single canonical representation for `[agents] visible`, and that `parseAgentNameList` normalizes any user `"agents.<name>"` input to short `<name>`.
