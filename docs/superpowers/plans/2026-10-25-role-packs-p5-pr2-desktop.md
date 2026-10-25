# Role packs P5 PR 2 — onboarding: desktop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The desktop asks "What do you do?", installs the matching bundled pack behind its approval, offers the pack's connectors (browser, Atlassian form, or a terminal command), and ends on a Decisions step that shows live progress, the decisions found, or why none were — plus a once-dismissible "Try a role pack" card for existing users.

**Architecture:** Two methods join the Tauri allowlist (`pack.install`, `decisions.status`); the gateway refuses the file form of `pack.install` from a renderer connection (I47 widened). The onboarding routes gain Role, Pack and Decisions steps; Connect reads `catalog.list`. All data comes from PR 1's gateway fields.

**Tech Stack:** React 19, React Router 7, zustand, vitest + Testing Library, Rust (Tauri bridge allowlist), Bun gateway.

**Spec:** `docs/superpowers/specs/2026-10-25-role-packs-p5-onboarding-design.md` § 6.3, § 7.2, § 9, § 10, § 11. Builds on PR 1 (merged first). Branch `dev/asaf/role-packs-p5-desktop` from `origin/main` after PR 1 merges.

## Global Constraints

- Renderer-reachable additions are exactly `pack.install` and `decisions.status`; `pack.remove`, `pack.show`, `decisions.refresh`, `decisions.rebuild` stay off. Allowlist 116 → 118; `NO_TIMEOUT_METHODS` 7 → 8 (`pack.install`). Re-derive the enumeration in every place it is restated (`docs/SECURITY-INVARIANTS.md` allowlist ledger, CLAUDE.md, GEMINI.md, `.claude/commands/nimbus-tauri-allowlist.md`), not just the number.
- A renderer `pack.install` takes `{ id }` only — the gateway refuses `fileText`/`filePath` from a `ui` connection (`ERR_PACK_RENDERER_FILE`) before reading anything.
- No code branches on a pack id; "ends on Decisions" keys on `visibleAgents` containing `decisions`.
- No new CSP, no remote code, no `dangerouslySetInnerHTML`.
- Poll interval 3 s, only while the document is visible; stop polling on unmount.
- The Atlassian form's token field is `type="password"`, cleared from state as soon as `connector.auth` returns or throws, never logged.
- Copy exactly as below where given.

## Review Focus

1. A renderer sending `{ fileText, filePath }` to `pack.install` (a compromised renderer) → refused before any read, with no prompt raised. → Task 1 test.
2. `pack.install` denied in the popup → the Pack step says so in plain words and offers "Continue without the pack"; nothing is installed. → Task 3 test.
3. Decisions step when `decisions.status` answers `enabled: false` → the "turned off" message, never a spinner. → Task 5 test.
4. Decisions step B1 with `candidates.extracted > 0, shown === 0` → the "too uncertain" reason, not "no decision language". → Task 5 test.
5. Upgraded user who dismissed the card → it never renders again (meta key read), and a fresh install never sees it. → Task 6 test.

---

### Task 1: gateway — renderer gets `pack.install` (bundled id only) and `decisions.status`

**Files:**
- Modify: `packages/gateway/src/ipc/pack-rpc.ts` (`dispatchPackRpc(method, params, deps, gate, fromRenderer)`), `packages/gateway/src/ipc/server/dispatchers.ts` (`tryDispatchPackRpc` passes `ctx.getClientKind(clientId) === "ui"`), `packages/gateway/src/packs/pack-install.ts` (new `PackErrorCode` `ERR_PACK_RENDERER_FILE` if codes are a closed union there; else in `pack-rpc.ts`)
- Modify: `packages/ui/src-tauri/src/gateway_bridge.rs` (`ALLOWED_METHODS` += `pack.install`, `decisions.status`; `NO_TIMEOUT_METHODS` += `pack.install`; tests `allowlist_pack_list_only` → `allowlist_pack_list_and_install_only`, `allowlist_decisions_brief_only` gains `assert!(is_method_allowed("decisions.status"))`, `allowlist_exact_size` 118, no-timeout count 8)
- Modify: `packages/gateway/src/security-invariants.test.ts` (I47 block: the renderer-file refusal; the "role packs desktop" allowlist test now names `pack.install`), `packages/gateway/src/ipc/allowlist-resolves.test.ts` (if it enumerates; it must resolve both), `docs/SECURITY-INVARIANTS.md` (I47 text + allowlist ledger entry "Role packs Project 5, onboarding (2026-10-25): 116 → 118"), `CLAUDE.md` + `GEMINI.md` (I47 line), `.claude/commands/nimbus-tauri-allowlist.md`
- Test: `packages/gateway/src/ipc/pack-rpc.test.ts`, `packages/gateway/src/ipc/server/dispatchers-chain.test.ts`

**Interfaces:**
- Produces: `dispatchPackRpc(method: string, params: unknown, deps: PackDeps, gate: PackOwnerGate | undefined, fromRenderer: boolean)`; with `fromRenderer` and a request carrying `fileText` or `filePath` (on `pack.install` and `pack.show`) → `RpcMethodError(-32000, "ERR_PACK_RENDERER_FILE: the desktop installs bundled packs by id only")` before `parseRequest` reads the text.

- [ ] **Step 1: Failing tests** — `pack-rpc.test.ts`: `a renderer pack.install with fileText is refused before any read or gate call` (gate spy count 0, `deps.store` untouched); `a renderer pack.install { id: "pm" } proceeds to the gate`; `a CLI connection may still install from a file`. Chain test: `tryDispatchPackRpc passes fromRenderer from the declared client kind` (harness `getClientKind: () => "ui"` + fileText → the refusal). Rust: the renamed allowlist test, size 118, no-timeout 8. `security-invariants.test.ts`: I47 renderer refusal pinned at the source (`pack-rpc.ts` contains the `fromRenderer` check before `parseRequest`).
- [ ] **Step 2: Run** `bun test packages/gateway/src/ipc/pack-rpc.test.ts packages/gateway/src/ipc/server/dispatchers-chain.test.ts packages/gateway/src/security-invariants.test.ts` and `cargo test --manifest-path packages/ui/src-tauri/Cargo.toml gateway_bridge` → FAIL.
- [ ] **Step 3: Implement.** Docs in the same commit (triple rule).
- [ ] **Step 4: Run** the same → PASS; `bun run audit:status-drift` → OK.
- [ ] **Step 5: Commit** `feat(desktop): the renderer may install a bundled role pack and read decisions.status`.

### Task 2: HITL popup renders the `pack.install` prompt

**Files:** Modify `packages/ui/src/components/hitl/HitlPopupPage.tsx`, `packages/ui/src-tauri/src/hitl_popup.rs` (`.resizable(true)`); Test `packages/ui/test/components/hitl/HitlPopupPage.test.tsx` (existing file — extend).

- [ ] **Step 1: Failing tests** — `a pack.install request shows the heading "Install this role pack?" and the prompt verbatim in a <pre> inside a scroll container (max-height 220px, overflow auto)`; `it does not render StructuredPreview for pack.install`; `focus lands on Reject for pack.install` (a first-time, irreversible-feeling install is not auto-approved by Enter).
- [ ] **Step 2: Run** `bunx vitest run test/components/hitl` (from `packages/ui`) → FAIL.
- [ ] **Step 3: Implement** a `pack.install` branch beside `isMigrate`; add `/^pack\.install$/` to the focus-to-Reject rule (not to `DESTRUCTIVE_PATTERNS`' meaning — a separate `FOCUS_REJECT` set).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(desktop): the approval popup shows a role pack's install prompt in full`.

### Task 3: Role and Pack steps

**Files:** Create `packages/ui/src/pages/onboarding/Role.tsx`, `packages/ui/src/pages/onboarding/Pack.tsx`, `packages/ui/src/onboarding/role-choices.ts` (pure); Modify `packages/ui/src/App.tsx` (routes `role`, `pack`, `decisions`), `packages/ui/src/pages/Onboarding.tsx` (step header from a pure `onboardingSteps(path, packChosen)`), `packages/ui/src/pages/onboarding/Welcome.tsx` (Continue → `/onboarding/role`), `packages/ui/src/store/slices/onboarding.ts` (`chosenPackId: string | null`, `setChosenPack`), `packages/ui/src/ipc/types.ts` (`PackListResult.available` typed rows with optional `roles`/`suggestedConnectors`/`visibleAgents`; `CatalogListResult.suggestedConnectors?`; builtin connector `signIn?`; `DecisionStatusResult`); Test `packages/ui/test/pages/OnboardingRole.test.tsx`, `OnboardingPack.test.tsx`, `packages/ui/test/onboarding/role-choices.test.ts`.

**Interfaces:**
- Produces in `role-choices.ts`: `roleChoices(packs: PackListResult | null): { value: string; label: string; description?: string }[]` — same rule as the CLI's (one per pack, installed first, then `engineering`/`design`/`other` labelled Engineering/Design/Something else); `packFor(value, packs)` → the pack row or undefined.
- Role step: cards; picking a pack not installed → `setChosenPack(id)`, navigate `/onboarding/pack`; a pack already installed → `setChosenPack(id)`, `/onboarding/connect`; Engineering/Design/Something else → `setChosenPack(null)`, `/onboarding/connect`.
- Pack step copy: heading `Set up Nimbus for <name>`; lists "Suggests: <connector display names>" and "Shows: <visible agent display names>" from `pack.list` + `catalog.list`; button **Continue** → `pack.install { id }`; while pending, `Waiting for your approval…`; success → `/onboarding/connect`; error → `<message without the ERR_ code prefix>` plus **Continue without the pack** (→ `/onboarding/connect`, `setChosenPack(null)`).

- [ ] **Step 1: Failing tests**: role choices order/labels; Role step navigation per answer; Pack step calls `pack.install` with `{ id: "pm" }` only; denied (`callMock` rejects `ERR_PACK_INSTALL_NOT_APPROVED: …`) shows the plain message and the continue-without button; success navigates to connect.
- [ ] **Step 2–4: Run → FAIL, implement, run → PASS** (`bunx vitest run test/pages/OnboardingRole.test.tsx test/pages/OnboardingPack.test.tsx test/onboarding`).
- [ ] **Step 5: Commit** `feat(desktop): onboarding asks what you do and offers the matching role pack`.

### Task 4: Connect step reads the catalog

**Files:** Modify `packages/ui/src/pages/onboarding/Connect.tsx`; Create `packages/ui/src/components/onboarding/AtlassianForm.tsx`; Test `packages/ui/test/pages/OnboardingConnect.test.tsx` (rewrite cases that assumed the six names).

- Tiles from `catalog.list.suggestedConnectors` (fallback: the neutral six ids when absent — an older gateway), label/description from the catalog row. `browser` → selectable, signed in by **Connect** (sequential, as today, with the **id**); `atlassian` → inline form (Email, API token [password], Site URL) → `connector.auth { service, atlassianEmail, apiToken, apiBaseUrl }` (verify these param names against `parseAtlassianSiteCredentials` in `ipc/connector-rpc-shared.ts` and use what it reads); `terminal` → `Set up from a terminal:` + the `nimbus connector auth <id>` command in a copyable `<code>`.
- No auto-navigation: **Continue** enabled once any suggested connector is connected; **Skip for now** always. Continue/Skip → `/onboarding/decisions` when the chosen pack's `visibleAgents` include `decisions`, else `/onboarding/syncing`.
- [ ] **Step 1: Failing tests**: tiles come from `suggestedConnectors` in order; `connector.auth` is called with the id (`slack`), never a display name; the Atlassian form sends the three fields and clears the token after the call (input value `""`); a terminal tile shows its command and no button; connecting does NOT navigate on its own; Continue goes to decisions for a pack showing decisions, else syncing.
- [ ] **Step 2–4.** Run → FAIL; implement; run → PASS.
- [ ] **Step 5: Commit** `feat(desktop): onboarding suggests the pack's connectors and signs each in its own way`.

### Task 5: Decisions step

**Files:** Create `packages/ui/src/pages/onboarding/Decisions.tsx`, `packages/ui/src/onboarding/decisions-progress.ts` (pure); Modify `packages/ui/src/pages/BriefRun.tsx` (`useSearchParams` prefill of known params); Test `packages/ui/test/onboarding/decisions-progress.test.ts`, `packages/ui/test/pages/OnboardingDecisions.test.tsx`, `packages/ui/test/pages/BriefRun.test.tsx` (prefill case).

**Interfaces:**
- `decisionsView(status: DecisionStatusResult | null, connectors: { id; displayName; status; itemCount; connected }[]): { phase: "off" | "working" | "found" | "none"; lines: string[]; reason?: string }` — `off` when `enabled === false`; `working` while `state === "running"`, any connected connector has `status === "syncing"` or no `lastSyncAt` yet, or `candidates.pending > 0`; then `found` (`shown > 0`) or `none`. Copy: `Syncing <name>… <n> items` / `<name>: <n> items`; `Looking for decisions… <shown> found so far`; none: `We read <n> <noun> and <m> <noun> and found no clear decisions.` (nouns by kind: message→messages, ticket→tickets, doc→docs, note→notes, commit→commits; 1 → singular), reasons `"<n> possible decisions were too uncertain to show (below your confidence floor)."` (`extracted > 0`) else `"None of it used decision language like 'we decided' or 'Decision:'."`; off: `The decisions pass is turned off in your config ([decisions] enabled).`
- Step: polls `connector.listStatus` + `decisions.status` every 3 s while visible; `recent` list; buttons **Open Decisions** (`/briefs/decisions`, found), **Add a channel** (`/settings/connectors`), **Connect Notion or Google Drive** (back to Connect), **Widen the window** (`/briefs/decisions?sinceMs=31536000000`), **Open dashboard** (marks `onboarding_completed`, as Syncing does).
- [ ] **Step 1: Failing tests** for every `decisionsView` phase and both reasons (Review Focus 3, 4), the noun pluralisation, and the step's polling stop on unmount; BriefRun prefills `sinceMs` from the query string and still does not run until **Run**.
- [ ] **Step 2–4.** Run → FAIL; implement; run → PASS.
- [ ] **Step 5: Commit** `feat(desktop): onboarding ends on decisions — progress, what was found, or why nothing was`.

### Task 6: "Try a role pack" card

**Files:** Create `packages/ui/src/components/home/TryRolePackCard.tsx`; Modify `packages/ui/src/pages/Dashboard.tsx`; Test `packages/ui/test/components/home/TryRolePackCard.test.tsx`.

- Shown when: `db.getMeta onboarding_completed` is set OR `diag.snapshot.indexTotalItems > 0`; `pack.list` loaded without `listError`; `installed.length === 0`; `available.length > 0`; `db.getMeta role_pack_card_dismissed` is null. Copy: `Nimbus can set itself up for your role.` + one button per available pack (`<name>` / its description) → `setChosenPack(id)` + `/onboarding/pack`; **Not now** → `db.setMeta { key: "role_pack_card_dismissed", value: <ISO now> }` and hide.
- [ ] **Step 1: Failing tests** (Review Focus 5): hidden on a fresh install; hidden once dismissed; hidden with a pack installed; shown otherwise; Not now writes the meta key.
- [ ] **Step 2–4.** Run → FAIL; implement; run → PASS.
- [ ] **Step 5: Commit** `feat(desktop): a once-dismissible "Try a role pack" card for existing users`.

### Task 7: docs + verification

- [ ] Docs: `docs/architecture.md` desktop paragraph (:1027) — onboarding steps; `packages/docs/src/content/docs/**` desktop onboarding page if one exists (`rg -l "onboarding" packages/docs/src/content`); `docs/CHANGELOG.md` entry; CLAUDE.md/GEMINI.md I7 count prose.
- [ ] `bun run preflight:fast`; `bun run typecheck:tests` (0 new; it is the only check that sees `packages/ui/test/**`); `bunx vitest run` in `packages/ui`; `cargo test` for the bridge; full `bun test packages/gateway/src` + `bun test scripts` under the full-suite lock.
- [ ] Antigravity end-result review; disposition in the PR description.
