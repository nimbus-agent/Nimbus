# Antigravity review — P5 PR 2 plan (2026-10-25)

Reviewer: Google Antigravity CLI (`agy --mode plan`), read-only bundle of the PR 1 branch HEAD + spec + plan. Verbatim below; checked against the code as built.

Here is the detailed review of the implementation plan [plan/2026-10-25-role-packs-p5-pr2-desktop.md](file:///C:/Users/asafg/AppData/Local/Temp/claude/C--gitrep-Nimbus/a6e3bf10-4f9f-4ee2-ab4f-2f9b6686707b/scratchpad/p2-agy-bundle-plan2/plan/2026-10-25-role-packs-p5-pr2-desktop.md) evaluated against the specification [plan/2026-10-25-role-packs-p5-onboarding-design.md](file:///C:/Users/asafg/AppData/Local/Temp/claude/C--gitrep-Nimbus/a6e3bf10-4f9f-4ee2-ab4f-2f9b6686707b/scratchpad/p2-agy-bundle-plan2/plan/2026-10-25-role-packs-p5-onboarding-design.md) and the Nimbus codebase.

---

### Finding 1: `decisions.status` Dispatched After `refresher === undefined` Guard Causes IPC -32601 When Disabled
- **Severity**: Critical
- **Evidence**:
  - Spec § 7.1: *"decisions.status is answered even when the decisions pass is disabled (`enabled: false`), so the dispatcher handles it before its 'no refresher -> skip' check."*
  - Plan Task 1 lines 25–26: Mentions dispatching `decisions.status`, but fails to specify modifying the dispatcher guard.
  - Gateway Dispatcher: [packages/gateway/src/ipc/server/dispatchers.ts#L1651-L1655](file:///C:/gitrep/Nimbus/packages/gateway/src/ipc/server/dispatchers.ts#L1651-L1655):
    ```ts
    export async function tryDispatchDecisionsRpc(ctx: ServerCtx, method: string, params: unknown): Promise<unknown> {
      if (!method.startsWith("decisions.")) return phase4RpcSkipped;
      const refresher = ctx.options.decisionsRefresher;
      if (refresher === undefined) return phase4RpcSkipped;
    ```
- **Failure Scenario**: When decisions are disabled or during Gateway test runs where `decisionsRefresher` is omitted from server options (such as [allowlist-resolves.test.ts#L80-L109](file:///C:/gitrep/Nimbus/packages/gateway/src/ipc/allowlist-resolves.test.ts#L80-L109)), `tryDispatchDecisionsRpc` returns `phase4RpcSkipped`. The RPC server falls through to `-32601 Method not found`.
- **Fix**: Update Task 1 to intercept `if (method === "decisions.status")` in `tryDispatchDecisionsRpc` *before* the `ctx.options.decisionsRefresher === undefined` check, returning `{ enabled: false, running: false, lastRunMs: null, itemCount: 0, error: null }` when `refresher` is undefined.

---

### Finding 2: `allowlist-resolves.test.ts` Breaks When `decisions.status` is Added to Tauri Allowlist
- **Severity**: Critical
- **Evidence**:
  - Test fixture: [packages/gateway/src/ipc/allowlist-resolves.test.ts#L80-L115](file:///C:/gitrep/Nimbus/packages/gateway/src/ipc/allowlist-resolves.test.ts#L80-L115) and [L135-L149](file:///C:/gitrep/Nimbus/packages/gateway/src/ipc/allowlist-resolves.test.ts#L135-L149).
- **Failure Scenario**: `allowlist-resolves.test.ts` reads `ALLOWED_METHODS` directly from `gateway_bridge.rs` and fires each method over an IPC socket against a test `ServerCtx`. Because its test `ServerCtx` does not supply a `decisionsRefresher`, adding `decisions.status` to `ALLOWED_METHODS` without Finding 1's fix causes this socket probe test to fail with method not found.
- **Fix**: In Task 1, explicitly list `allowlist-resolves.test.ts` as a verification target ensuring `decisions.status` returns a valid JSON-RPC response (or error other than `-32601`) with dummy options.

---

### Finding 3: `security-invariants.test.ts` Hardcoded Regex Expecting Exactly 116 Methods
- **Severity**: Critical
- **Evidence**:
  - Plan Task 1 lines 32–33: Mentions bumping `gateway_bridge.rs` to 118, but does not update the static invariant test regex.
  - Test file: [packages/gateway/src/security-invariants.test.ts#L1426-L1429](file:///C:/gitrep/Nimbus/packages/gateway/src/security-invariants.test.ts#L1426-L1429):
    ```ts
    test("allowlist_exact_size assertion is 116", async () => {
      const rust = await read("packages/ui/src-tauri/src/gateway_bridge.rs");
      expect(rust).toMatch(/assert_eq!\s*\(\s*ALLOWED_METHODS\.len\(\),\s*116\s*\)/);
    });
    ```
- **Failure Scenario**: Bumping `gateway_bridge.rs` to 118 immediately fails `security-invariants.test.ts` on CI.
- **Fix**: Update Task 1 to update `security-invariants.test.ts:1426-1429` test name and regex expectation from `116` to `118`.

---

### Finding 4: Security Invariants Role Packs Allowlist Alphabetical Sorting Regression
- **Severity**: Critical
- **Evidence**:
  - Test file: [packages/gateway/src/security-invariants.test.ts#L1432-L1444](file:///C:/gitrep/Nimbus/packages/gateway/src/security-invariants.test.ts#L1432-L1444):
    ```ts
    const packMethods = rust
      .split("\n")
      .map((l) => l.match(/"(pack\.[a-z]+)"/i)?.[1])
      .filter((m): m is string => Boolean(m));
    expect(packMethods).toEqual(["pack.list"]);
    ```
  - Plan Task 1 line 33: *"the 'role packs desktop' allowlist test now names pack.install."*
  - Rust Allowlist: [packages/ui/src-tauri/src/gateway_bridge.rs#L144-L146](file:///C:/gitrep/Nimbus/packages/ui/src-tauri/src/gateway_bridge.rs#L144-L146).
- **Failure Scenario**: In `ALLOWED_METHODS`, methods are alphabetical. `"pack.install"` precedes `"pack.list"`. The regex slice in `security-invariants.test.ts` extracts `["pack.install", "pack.list"]`. If the test expectation is updated out of order (or if the alphabetical position in `gateway_bridge.rs` is wrong), the test fails.
- **Fix**: Clarify in Task 1 that `packMethods` expectation in `security-invariants.test.ts` must be `["pack.install", "pack.list"]`, and `ALLOWED_METHODS` in `gateway_bridge.rs` must insert `"pack.install"` immediately before `"pack.list"`.

---

### Finding 5: Missing Rust Test Update `no_timeout_methods_contains_expected_seven`
- **Severity**: Critical
- **Evidence**:
  - Rust test suite: [packages/ui/src-tauri/src/gateway_bridge.rs#L929-L939](file:///C:/gitrep/Nimbus/packages/ui/src-tauri/src/gateway_bridge.rs#L929-L939):
    ```rust
    #[test]
    fn no_timeout_methods_contains_expected_seven() {
        for m in [
            "fleet.prompt",
            "fleet.plan",
            ...
        ] {
            assert!(NO_TIMEOUT_METHODS.contains(&m));
        }
    }
    ```
  - Plan Task 1 line 32: Only states *"no_timeout_methods_exact_size (7 -> 8)"*.
- **Failure Scenario**: `cargo test` fails because `no_timeout_methods_contains_expected_seven` is hardcoded to assert only 7 methods and will not check `pack.install`, or its successor test fails.
- **Fix**: In Task 1, rename `no_timeout_methods_contains_expected_seven` to `no_timeout_methods_contains_expected_eight` and add `"pack.install"` to the tested slice.

---

### Finding 6: Missing Rust Test Update `allowlist_pack_list_only`
- **Severity**: Critical
- **Evidence**:
  - Rust test suite: [packages/ui/src-tauri/src/gateway_bridge.rs#L826-L842](file:///C:/gitrep/Nimbus/packages/ui/src-tauri/src/gateway_bridge.rs#L826-L842):
    ```rust
    #[test]
    fn allowlist_pack_list_only() {
        ...
        assert!(!is_method_allowed("pack.install"), "pack.install must not be exposed to the renderer");
    }
    ```
- **Failure Scenario**: This test explicitly asserts `!is_method_allowed("pack.install")`. When `pack.install` is added to `ALLOWED_METHODS`, `cargo test` in `ui/src-tauri` will fail.
- **Fix**: Update Task 1 to rename `allowlist_pack_list_only` to `allowlist_pack_list_and_install_only` and replace `assert!(!is_method_allowed("pack.install"))` with `assert!(is_method_allowed("pack.install"))`.

---

### Finding 7: Atlassian Auth Parameter Key Mismatches in `connector.auth`
- **Severity**: Important
- **Evidence**:
  - Plan Task 4 line 77: Proposes `connector.auth` call with `{ service, atlassianEmail, apiToken, apiBaseUrl }`.
  - RPC Parser: [packages/gateway/src/ipc/connector-rpc-shared.ts#L122-L142](file:///C:/Users/asafg/AppData/Local/Temp/claude/C--gitrep-Nimbus/a6e3bf10-4f9f-4ee2-ab4f-2f9b6686707b/scratchpad/p2-agy-bundle-plan2/packages/gateway/src/ipc/connector-rpc-shared.ts#L122-L142):
    - Email accepts: `atlassianEmail` or `email`
    - Token accepts: `personalAccessToken`, `token`, or `apiToken`
    - Base URL accepts: `apiBaseUrl` or `baseUrl`
  - Auth Handler: [packages/gateway/src/ipc/connector-rpc-handlers/auth.ts#L846-L879](file:///C:/gitrep/Nimbus/packages/gateway/src/ipc/connector-rpc-handlers/auth.ts#L846-L879): Requires URL to be valid HTTP/HTTPS without trailing slashes.
- **Failure Scenario**: If the UI submits a URL with trailing slashes, or if the form fields differ between Jira and Confluence, `parseAtlassianSiteCredentials` throws `-32602`.
- **Fix**: In Task 4, specify that the Atlassian inline form normalizes `apiBaseUrl` via `.trim().replace(/\/+$/, "")` before invoking `connector.auth`, and strictly adheres to `{ service: "jira" | "confluence", atlassianEmail, apiToken, apiBaseUrl }`.

---

### Finding 8: `BriefRun.tsx` Presets Drop `sinceMs=31536000000` (1 Year) Window
- **Severity**: Important
- **Evidence**:
  - Spec § 7.2 & Plan Task 5 line 89: *"Widen the window (opens /briefs/decisions?sinceMs=31536000000)"*.
  - Brief Form presets: [packages/ui/src/briefs/brief-form.ts#L15-L21](file:///C:/gitrep/Nimbus/packages/ui/src/briefs/brief-form.ts#L15-L21):
    ```ts
    export const SINCE_PRESETS = [
      { label: "Default", ms: 0 },
      { label: "Last 24 hours", ms: 24 * 60 * 60 * 1000 },
      { label: "Last 7 days", ms: 7 * 24 * 60 * 60 * 1000 },
      { label: "Last 30 days", ms: 30 * 24 * 60 * 60 * 1000 },
      { label: "Last 90 days", ms: 90 * 24 * 60 * 60 * 1000 },
    ];
    ```
  - Brief UI Form: [packages/ui/src/pages/BriefRun.tsx#L281-L295](file:///C:/Users/asafg/AppData/Local/Temp/claude/C--gitrep-Nimbus/a6e3bf10-4f9f-4ee2-ab4f-2f9b6686707b/scratchpad/p2-agy-bundle-plan2/packages/ui/src/pages/BriefRun.tsx#L281-L295): Only renders `<option>` elements from `SINCE_PRESETS`.
- **Failure Scenario**: When `/briefs/decisions?sinceMs=31536000000` opens, `BriefRun.tsx` sets `values["sinceMs"] = "31536000000"`. Because there is no matching `<option value="31536000000">`, standard HTML `<select>` drops the value back to the first option (`"0"`), completely discarding the query parameter.
- **Fix**: Update Task 5 to add `{ label: "Last 1 year", ms: 365 * 24 * 60 * 60 * 1000 }` (or `31_536_000_000`) to `SINCE_PRESETS` in `packages/ui/src/briefs/brief-form.ts`.

---

### Finding 9: Existing UI Tests in `OnboardingConnect.test.tsx` Will Fail
- **Severity**: Important
- **Evidence**:
  - Test file: [packages/ui/test/pages/OnboardingConnect.test.tsx#L28-L34](file:///C:/gitrep/Nimbus/packages/ui/test/pages/OnboardingConnect.test.tsx#L28-L34): Asserts that the page always renders exactly the 6 connector cards (`Google Drive`, `GitHub`, `Slack`, `Linear`, `Notion`, `Gmail`).
  - Test file: [packages/ui/test/pages/OnboardingConnect.test.tsx#L126-L140](file:///C:/gitrep/Nimbus/packages/ui/test/pages/OnboardingConnect.test.tsx#L126-L140): Asserts auto-navigation to `/onboarding/syncing` when a connector becomes connected.
  - Plan Task 4: Replaces hardcoded 6 cards with catalog recommendations and replaces auto-navigation with manual Continue.
- **Failure Scenario**: Running `pnpm test` in `packages/ui` will immediately fail `OnboardingConnect.test.tsx`.
- **Fix**: Update Plan Task 4 to include refactoring `packages/ui/test/pages/OnboardingConnect.test.tsx` to mock `catalog.list` / store `chosenPackId`, verify recommended connectors render, and verify manual Continue click instead of auto-navigation.

---

### Finding 10: Existing UI Route Tests in `OnboardingWelcome.test.tsx` Will Fail
- **Severity**: Important
- **Evidence**:
  - Test file: [packages/ui/test/pages/OnboardingWelcome.test.tsx#L23-L28](file:///C:/gitrep/Nimbus/packages/ui/test/pages/OnboardingWelcome.test.tsx#L23-L28):
    ```tsx
    <MemoryRouter initialEntries={["/onboarding/welcome"]}>
      <Routes>
        <Route path="/onboarding/welcome" element={<Welcome />} />
        <Route path="/onboarding/connect" element={<div>connect</div>} />
      </Routes>
    </MemoryRouter>
    ```
- **Failure Scenario**: Plan Task 3 updates Welcome's Continue button to navigate to `/onboarding/role` instead of `/onboarding/connect`. Clicking Continue in `OnboardingWelcome.test.tsx` will fail navigation assertion or route resolution.
- **Fix**: Add `packages/ui/test/pages/OnboardingWelcome.test.tsx` to Task 3's test update list, changing route target to `/onboarding/role`.

---

### Finding 11: Untyped `connectors: readonly unknown[]` in `CatalogListResult`
- **Severity**: Important
- **Evidence**:
  - Type definition: [packages/ui/src/ipc/types.ts#L580-L588](file:///C:/Users/asafg/AppData/Local/Temp/claude/C--gitrep-Nimbus/a6e3bf10-4f9f-4ee2-ab4f-2f9b6686707b/scratchpad/p2-agy-bundle-plan2/packages/ui/src/ipc/types.ts#L580-L588):
    ```ts
    export interface CatalogListResult {
      readonly packs: readonly unknown[];
      readonly connectors: readonly unknown[];
      readonly suggestedConnectors: readonly string[];
    }
    ```
  - Gateway Catalog Definition: [packages/gateway/src/catalog/catalog-list.ts#L8-L23](file:///C:/gitrep/Nimbus/packages/gateway/src/catalog/catalog-list.ts#L8-L23).
- **Failure Scenario**: Plan Task 4 expects `connectors` in `CatalogListResult` to provide `displayName`, `description`, and `signIn: ConnectorSignInKind`. Leaving `connectors: readonly unknown[]` will trigger TypeScript compile errors in `Connect.tsx` or force dangerous type-casts.
- **Fix**: In Task 1 / Task 4, update `packages/ui/src/ipc/types.ts` to export `CatalogConnector` with `id: string`, `displayName: string`, `description: string`, `signIn: "browser" | "atlassian" | "terminal"`, and type `connectors: readonly CatalogConnector[]`.

---

### Finding 12: `resetOnboarding` Fails to Reset `chosenPackId`
- **Severity**: Important
- **Evidence**:
  - Slice store: [packages/ui/src/store/slices/onboarding.ts#L22-L27](file:///C:/Users/asafg/AppData/Local/Temp/claude/C--gitrep-Nimbus/packages/ui/src/store/slices/onboarding.ts#L22-L27):
    ```ts
    resetOnboarding: () =>
      set({
        selected: [],
        authStatus: {},
      }),
    ```
  - Plan Task 3 lines 56–57: Adds `chosenPackId: string | null` and `setChosenPack: (packId: string | null) => void` to `OnboardingSlice`.
- **Failure Scenario**: When user cancels, restarts, or finishes onboarding, `resetOnboarding()` is called. `chosenPackId` will persist in store across sessions, dirtying subsequent onboarding runs.
- **Fix**: Update Task 3 to include `chosenPackId: null` inside `resetOnboarding` in `packages/ui/src/store/slices/onboarding.ts`.

---

### Finding 13: `ERR_PACK_RENDERER_FILE` Error Code Missing from `PackErrorCode` Union
- **Severity**: Important
- **Evidence**:
  - Error enum/types: [packages/gateway/src/packs/pack-install.ts#L38-L46](file:///C:/Users/asafg/AppData/Local/Temp/claude/C--gitrep-Nimbus/a6e3bf10-4f9f-4ee2-ab4f-2f9b6686707b/scratchpad/p2-agy-bundle-plan2/packages/gateway/src/packs/pack-install.ts#L38-L46):
    `export type PackErrorCode = "ERR_PACK_NOT_FOUND" | "ERR_PACK_READ_FAILED" | ...`
  - Plan Task 1 line 18: Throws `RpcMethodError(-32000, "ERR_PACK_RENDERER_FILE: the desktop installs bundled packs by id only")`.
- **Failure Scenario**: In `pack-rpc.ts` and `pack-install.ts`, error mappings are standardized against `PackErrorCode`. If thrown as a `PackError`, TypeScript compilation will fail if `ERR_PACK_RENDERER_FILE` is not in `PackErrorCode`.
- **Fix**: In Task 1, explicitly add `"ERR_PACK_RENDERER_FILE"` to `PackErrorCode` in `packages/gateway/src/packs/pack-install.ts` or ensure it is thrown directly as `RpcMethodError` in `pack-rpc.ts` without going through `PackError`.

---

### Finding 14: Borderless HITL Window Resizable Setting Causes Platform Glitches
- **Severity**: Minor
- **Evidence**:
  - Rust Window creation: [packages/ui/src-tauri/src/hitl_popup.rs#L38-L44](file:///C:/gitrep/Nimbus/packages/ui/src-tauri/src/hitl_popup.rs#L38-L44):
    ```rust
    .decorations(false)
    .resizable(false)
    ```
  - Plan Task 2 line 49: Changes to `.resizable(true)`.
- **Failure Scenario**: On Windows and macOS Tauri Webview2/WKWebView, a window with `decorations(false)` and `resizable(true)` without explicit resize borders/grips can present ugly white artifact lines or erratic resize borders.
- **Fix**: In Task 2, note that `hitl_popup.rs` retains `.resizable(true)` but add `min_inner_size(480.0, 360.0)` to prevent collapsing below base dimensions.

---

### Finding 15: Polling Leak and Visibility Listener Cleanup in `Decisions.tsx`
- **Severity**: Minor
- **Evidence**:
  - Spec § 7.2 & Plan Task 5 line 89: *"polls decisions.status every 3 s while the document is visible; stops when hidden or unmounted."*
- **Failure Scenario**: If `document.addEventListener("visibilitychange", ...)` is bound inside a `useEffect` without clean cancellation of both the listener and the active interval timer, React 19 StrictMode double-mounting will create leaked intervals flooding `decisions.status`.
- **Fix**: In Task 5, explicitly specify the cleanup pattern: store interval id in a ref, clear it on `visibilitychange` (when `hidden`) and return a cleanup function from `useEffect` clearing both interval and event listener.

---

### Finding 16: Missing Allowlist Documentation Updates Across 5 Ledger Locations
- **Severity**: Minor
- **Evidence**:
  - Allowlist ledger locations in repository:
    1. `packages/ui/src-tauri/src/gateway_bridge.rs` (`116 -> 118`)
    2. `packages/gateway/src/security-invariants.test.ts` (test regex)
    3. `docs/SECURITY-INVARIANTS.md` (Table 4.1 & I7 section text)
    4. `.claude/commands/nimbus-tauri-allowlist.md` (explicit count 116 -> 118, 7 -> 8)
    5. `CLAUDE.md` / `GEMINI.md`
  - Plan Task 1 line 33 mentions docs and tests, but omits `.claude/commands/nimbus-tauri-allowlist.md`.
- **Failure Scenario**: Tooling commands like `/nimbus-tauri-allowlist` check against stale numbers and trigger verification warnings.
- **Fix**: Update Task 1's documentation checklist to include `.claude/commands/nimbus-tauri-allowlist.md`.

## Disposition

| # | Finding | Disposition |
|---|---|---|
| 1–2 | `decisions.status` skipped without a refresher; allowlist-resolves | Already handled in PR 1 (the status arm runs before the refresher check); `allowlist-resolves.test.ts` passes with both new methods. The reviewer's proposed result shape (`running`, `lastRunMs`, `itemCount`) is not the spec's and was not used. |
| 3–6 | Invariant regex 116, pack order, Rust no-timeout and pack tests | Already in the plan's Task 1 list; all done (118, `["pack.install","pack.list"]`, `…_expected_eight`, `allowlist_pack_list_and_install_only`). |
| 7 | Atlassian params / trailing slash | Param names confirmed (`atlassianEmail`, `apiToken`, `apiBaseUrl`); the gateway already strips trailing slashes (`stripTrailingSlashes`), so the form does not duplicate it. |
| 8 | No 1-year preset | **Fixed** — `SINCE_PRESETS` gained "1 year"; prefill accepts presets only. |
| 9–10 | Connect / Welcome tests | **Fixed** — Connect test rewritten for the catalog-driven page; Welcome test now expects `/onboarding/role`. |
| 11 | Untyped catalog connectors | **Declined** — the pages parse the `unknown` rows with guards (`suggestionsFrom`), the pattern `Connect.tsx` already used for `listStatus`; a typed interface would assert, not validate. |
| 12 | `resetOnboarding` keeps `chosenPackId` | **Fixed** (it resets it). |
| 13 | `ERR_PACK_RENDERER_FILE` in `PackErrorCode` | **Declined** — thrown as an `RpcMethodError` in `pack-rpc.ts`, never a `PackError`. |
| 14 | Resizable borderless window | **Fixed differently** — kept `.resizable(false)`; the prompt box is capped at 200 px so the footer always fits the 360 px window. |
| 15 | Polling cleanup | Already handled — one interval, cleared on unmount, ticks skip while hidden; a test proves no calls after unmount. |
| 16 | Allowlist skill restatement | Already handled (118 / 8 updated with the list). |
