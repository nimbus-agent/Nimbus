# Credential Rotation & Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the org's credential inventory machine-checked against live GitHub state, and close four concrete exposure gaps.

**Architecture:** A typed manifest in `scripts/release/credential-registry.ts` declares every credential. A read-only GitHub App (`nimbus-secret-auditor`) enumerates live Actions + Dependabot secret *names and timestamps* across all 18 repos. A pure join function compares the two and emits `HealthRow`s into the existing weekly `secret-health.yml` monitor, reusing its table and de-duped issue filer. No new alerting path is built.

**Tech Stack:** Bun + TypeScript (strict), `bun:test`, GitHub Actions, `actions/create-github-app-token`.

**Spec:** [`docs/superpowers/specs/2026-07-20-credential-rotation-and-hardening-design.md`](../specs/2026-07-20-credential-rotation-and-hardening-design.md) · review + resolutions in the `-review.md` companion.

## Global Constraints

- **No `any`.** Use `unknown` for external data. TypeScript strict is non-negotiable.
- **No new runtime dependencies.** Use Bun/Node built-ins and the existing `gh`/`fetch` patterns already in `scripts/release/`.
- **Never log a secret value.** The enumeration API returns names and timestamps only — never values. No code may print, interpolate, or persist a credential value.
- **Wording constraint (load-bearing).** `updated_at` is when the **secret was last set**, not when the credential was **issued**. Row details must read `secret last set N days ago` and must never claim `credential is N days old`.
- **SHA-pin every action reference.** The org sets `sha_pinning_required: true`; full 40-char SHAs only.
- **`actions/create-github-app-token` is pinned at `bcd2ba49218906704ab6c1aa796996da409d3eb1` (v3.2.0)** and MUST be called with `client-id`, not the deprecated `app-id` (Nimbus#779).
- **Auditor App:** `nimbus-secret-auditor`, app_id `4347847`, client id in `SECRET_AUDITOR_CLIENT_ID`, key in `SECRET_AUDITOR_PRIVATE_KEY` (repo secrets on `Nimbus`). Effective installation permissions, verified 2026-07-20: `dependabot_secrets:read`, `metadata:read`, `organization_secrets:read`, `secrets:read`, installed on **all 18 repos**. It holds **no `contents` permission** and must never be granted one.
- **Thresholds:** `HARD_DEADLINE_LEAD_DAYS = 90`, `MANUAL_AUDIT_MAX_AGE_DAYS = 90`.
- **Branch:** `dev/asafgolombek/credential-rotation-hardening`, worktree `.claude/worktrees/credential-rotation-hardening`. Never commit to `main`.
- **Lint note:** `bun run lint` spuriously reports "0 files processed" inside `.claude/worktrees/`. Use `bunx biome check packages scripts` instead.

## Deviation from the spec — read before Task 3

The spec's verdict table lists both *"`required`, absent → hard"* and *"in manifest, no longer exists → warn (**orphaned**)"*. **These overlap: a required credential that no longer exists satisfies both.** There is no way to tell "deliberately deleted" from "vanished" by inspection.

This plan resolves it by making intent explicit in the data rather than guessing at it. `state` becomes a **three-value** field:

| `state` | absent | present |
| --- | --- | --- |
| `required` | **hard** (`missing`) — a workflow will break | `ok` |
| `optional` | `ok` | `ok` |
| `forbidden` | `ok` | **hard** (`present`) — a revoked credential is back |

`orphaned` is then **unreachable and is dropped**: a manifest entry that no longer exists is either `missing` (hard, if required) or correctly `ok` (if optional/forbidden). Deliberate deletion is recorded by flipping `state` to `forbidden`, which is what already happened with `NPM_TOKEN`.

`optional` is not optional to add: `WINDOWS_CERT_PFX_BASE64`, `WINDOWS_CERT_PASSWORD`, `APPLE_CERT_P12_BASE64`, `APPLE_CERT_PASSWORD`, `NIMBUS_CHECKS_TOKEN` and `SCORECARD_TOKEN` are referenced by workflows but are legitimately absent today, and the current monitor reports them `not-configured` without failing. Without `optional` they would all hard-fail on the first run.

## File Structure

| Path | Responsibility |
| --- | --- |
| `scripts/release/credential-registry.ts` | **Create.** Types, thresholds, and the manifest data. No logic, no I/O. |
| `scripts/release/credential-registry.test.ts` | **Create.** Manifest self-consistency (unique names, state/field coherence). |
| `scripts/release/credential-audit.ts` | **Create.** Pure join: manifest × live secrets → `HealthRow[]`. No I/O. |
| `scripts/release/credential-audit.test.ts` | **Create.** Every verdict, with red/green proofs. |
| `scripts/release/credential-enumerate.ts` | **Create.** GitHub enumeration with injected `fetch`. Returns `LiveSecret[]`. |
| `scripts/release/credential-enumerate.test.ts` | **Create.** Pagination, 403 handling, product tagging. |
| `scripts/release/check-secret-health.ts` | **Modify.** Widen `HealthRow`, extend `summarize` sets, wire inventory rows, retire the bespoke `NPM_TOKEN` classifier. |
| `scripts/release/check-secret-health.test.ts` | **Modify.** Repoint `NPM_TOKEN` tests at the general mechanism. |
| `.github/workflows/secret-health.yml` | **Modify.** Mint the auditor token, run the inventory step. |
| `scripts/structure-audit/check-consumed-by.ts` | **Create.** Preflight static check: manifest ↔ this repo's workflow `secrets.*` references. |
| `scripts/lib/preflight-gates.ts` | **Modify.** Register `audit:consumed-by`. |
| `package.json` | **Modify.** Add the `audit:consumed-by` script. |
| `docs/credential-hygiene.md` | **Create.** The manual workstation audit. |
| `docs/ci-secrets.md` | **Modify.** Point at the manifest instead of restating it. |

---

## Task 1: Probe the auditor's capabilities

A spike. It answers two questions the later tasks branch on, and deletes itself. Nothing here ships.

**Files:**

- Create then delete: `.github/workflows/_auditor-capability-probe.yml`

**Interfaces:**

- Consumes: nothing.
- Produces: two recorded answers — (A) does `GET /repos/{owner}/{repo}/dependabot/secrets` return 200 (not 403) with the auditor token; (B) does `GET /repos/{owner}/{repo}` expose `security_and_analysis` to it.

- [ ] **Step 1: Create the probe branch**

```bash
git switch -c scratch/auditor-capability-probe
```

- [ ] **Step 2: Write the probe workflow**

Create `.github/workflows/_auditor-capability-probe.yml`:

```yaml
name: Auditor capability probe (throwaway)
on:
  push:
    branches: [scratch/auditor-capability-probe]
permissions:
  contents: read
jobs:
  probe:
    runs-on: ubuntu-24.04
    timeout-minutes: 5
    steps:
      - name: Mint auditor token
        id: mint
        uses: actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3.2.0
        with:
          client-id: ${{ secrets.SECRET_AUDITOR_CLIENT_ID }}
          private-key: ${{ secrets.SECRET_AUDITOR_PRIVATE_KEY }}
          owner: nimbus-agent
      - name: Probe capabilities
        env:
          GH_TOKEN: ${{ steps.mint.outputs.token }}
        run: |
          set -uo pipefail
          code=$(gh api repos/nimbus-agent/Nimbus/dependabot/secrets --silent -i 2>/dev/null | head -1 || true)
          echo "PROBE-A dependabot endpoint: ${code:-<no status line>}"
          gh api repos/nimbus-agent/Nimbus/dependabot/secrets --jq '"PROBE-A total_count=\(.total_count)"' || echo "PROBE-A FAILED (403 = permission not effective)"
          gh api repos/nimbus-agent/nimbus-sdk --jq '"PROBE-B security_and_analysis=\(.security_and_analysis // "ABSENT")"'
```

- [ ] **Step 3: Push and read the result**

```bash
git add .github/workflows/_auditor-capability-probe.yml
git commit -m "chore: throwaway auditor capability probe"
git push -u origin scratch/auditor-capability-probe
```

Then wait for the run and read it:

```bash
until gh run list --repo nimbus-agent/Nimbus --branch scratch/auditor-capability-probe --limit 1 --json status --jq '.[0].status' | grep -q completed; do sleep 15; done
gh run view "$(gh run list --repo nimbus-agent/Nimbus --branch scratch/auditor-capability-probe --limit 1 --json databaseId --jq '.[0].databaseId')" --repo nimbus-agent/Nimbus --log | grep "PROBE-"
```

Expected for **PROBE-A**: `PROBE-A total_count=0`. If it prints `PROBE-A FAILED`, the Dependabot permission is declared on the App but not granted on the installation — **stop and report**, do not proceed to Task 4's Dependabot enumeration.

**PROBE-B** decides Task 8's push-protection row:

- `security_and_analysis={...}` → readable. Task 8 adds a monitored row.
- `security_and_analysis=ABSENT` → not readable. Task 8 does the one-time fix only, and Task 7 adds the manual-checklist line. **This is the expected outcome** (the field needs `administration`), so treat `ABSENT` as normal, not a failure.

- [ ] **Step 4: Record both answers in the report file, then destroy the probe**

```bash
git switch dev/asafgolombek/credential-rotation-hardening
git push origin --delete scratch/auditor-capability-probe
git branch -D scratch/auditor-capability-probe
git ls-remote --heads origin 'scratch/*'
```

Expected: the final command prints nothing.

---

## Task 2: The credential manifest

**Files:**

- Create: `scripts/release/credential-registry.ts`
- Test: `scripts/release/credential-registry.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `type CredentialState = "required" | "optional" | "forbidden"`
  - `type SecretProduct = "actions" | "dependabot"`
  - `interface CredentialEntry` (fields exactly as written below)
  - `const CREDENTIAL_REGISTRY: readonly CredentialEntry[]`
  - `const HARD_DEADLINE_LEAD_DAYS = 90`, `MANUAL_AUDIT_MAX_AGE_DAYS = 90`, `LAST_MANUAL_AUDIT = "2026-07-20"`

- [ ] **Step 1: Write the failing test**

Create `scripts/release/credential-registry.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  CREDENTIAL_REGISTRY,
  HARD_DEADLINE_LEAD_DAYS,
  LAST_MANUAL_AUDIT,
  MANUAL_AUDIT_MAX_AGE_DAYS,
} from "./credential-registry";

describe("CREDENTIAL_REGISTRY", () => {
  test("every entry is uniquely keyed by scope+repo+product+name", () => {
    const keys = CREDENTIAL_REGISTRY.map(
      (e) => `${e.location.scope}:${e.location.repo ?? "-"}:${e.product}:${e.name}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("repo-scoped entries name a repo and org-scoped entries do not", () => {
    for (const e of CREDENTIAL_REGISTRY) {
      if (e.location.scope === "repo") expect(e.location.repo).toBeTruthy();
      else expect(e.location.repo).toBeUndefined();
    }
  });

  test("expectedVisibility is only set on org-scoped entries", () => {
    for (const e of CREDENTIAL_REGISTRY) {
      if (e.expectedVisibility !== undefined) expect(e.location.scope).toBe("org");
    }
  });

  test("forbidden entries carry no rotation policy — they must not exist at all", () => {
    for (const e of CREDENTIAL_REGISTRY.filter((x) => x.state === "forbidden")) {
      expect(e.maxAgeDays).toBeNull();
      expect(e.hardDeadline).toBeNull();
    }
  });

  test("signing keys opt out of age-based rotation", () => {
    for (const e of CREDENTIAL_REGISTRY.filter((x) => x.type === "signing-key")) {
      expect(e.maxAgeDays).toBeNull();
    }
  });

  test("every entry states an owner and a note", () => {
    for (const e of CREDENTIAL_REGISTRY) {
      expect(e.owner.length).toBeGreaterThan(0);
      expect(e.note.length).toBeGreaterThan(0);
    }
  });

  test("hardDeadline is an ISO date when present", () => {
    for (const e of CREDENTIAL_REGISTRY) {
      if (e.hardDeadline !== null) expect(e.hardDeadline).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  test("thresholds and the audit stamp are the agreed values", () => {
    expect(HARD_DEADLINE_LEAD_DAYS).toBe(90);
    expect(MANUAL_AUDIT_MAX_AGE_DAYS).toBe(90);
    expect(LAST_MANUAL_AUDIT).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("the VSCE_PAT decommission deadline is recorded", () => {
    const vsce = CREDENTIAL_REGISTRY.find((e) => e.name === "VSCE_PAT");
    expect(vsce?.hardDeadline).toBe("2026-12-01");
  });

  test("NPM_TOKEN is forbidden — it was revoked 2026-07-19 and must stay gone", () => {
    const npm = CREDENTIAL_REGISTRY.find((e) => e.name === "NPM_TOKEN");
    expect(npm?.state).toBe("forbidden");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun test scripts/release/credential-registry.test.ts
```

Expected: FAIL — `Cannot find module './credential-registry'`.

- [ ] **Step 3: Write the manifest**

Create `scripts/release/credential-registry.ts`:

```ts
/**
 * The credential manifest: the single machine-checked declaration of every
 * credential this organization holds.
 *
 * `docs/ci-secrets.md` carries the human narrative and points here; this file is
 * authoritative for anything checkable. Adding a secret anywhere in the org
 * without adding it here makes the weekly monitor hard-fail with `undocumented`,
 * which is the point.
 */

export type CredentialState = "required" | "optional" | "forbidden";
export type CredentialType = "pat" | "app-key" | "signing-key" | "service-token";

/** GitHub scopes secrets by product; each has its own API and permission. */
export type SecretProduct = "actions" | "dependabot";

export interface CredentialLocation {
  readonly scope: "org" | "repo";
  /** Set if and only if scope === "repo". */
  readonly repo?: string;
}

export interface CredentialEntry {
  readonly name: string;
  /**
   * `required` — a workflow breaks without it (absent => hard).
   * `optional`  — referenced but legitimately unset (absent => ok).
   * `forbidden` — deliberately deleted; must not come back (present => hard).
   */
  readonly state: CredentialState;
  readonly location: CredentialLocation;
  readonly product: SecretProduct;
  readonly type: CredentialType;
  /** Who rotates it. */
  readonly owner: string;
  /** Workflow paths that consume it, so an unused entry is traceable. */
  readonly consumedBy: readonly string[];
  /** Warn when the secret was last set longer ago than this. null = age is the wrong signal. */
  readonly maxAgeDays: number | null;
  /** Immovable external date (ISO), e.g. a platform decommission. */
  readonly hardDeadline: string | null;
  /** Org-scoped entries only: the visibility this secret must keep. */
  readonly expectedVisibility?: "all" | "selected";
  readonly note: string;
}

/** Lead time on a hard external deadline. Longer than the 21-day cert threshold
 *  because a deadline may require investigation, not just a rotation. */
export const HARD_DEADLINE_LEAD_DAYS = 90;

/** Quarterly, matching the default maxAgeDays so the cadences cannot drift apart. */
export const MANUAL_AUDIT_MAX_AGE_DAYS = 90;

/** Bump this when `docs/credential-hygiene.md` is actually walked through. */
export const LAST_MANUAL_AUDIT = "2026-07-20";

const OWNER = "@AsafGolombek";

export const CREDENTIAL_REGISTRY: readonly CredentialEntry[] = [
  // --- org scope ---
  {
    name: "RELEASE_PLEASE_PAT",
    state: "required",
    location: { scope: "org" },
    product: "actions",
    type: "pat",
    owner: OWNER,
    consumedBy: [
      "nimbus-sdk/.github/workflows/release.yml",
      "nimbus-client/.github/workflows/release.yml",
      "nimbus-vscode/.github/workflows/release-please.yml",
    ],
    maxAgeDays: 90,
    hardDeadline: null,
    expectedVisibility: "selected",
    note: "Interim state. Migrating the satellites onto the Release Bot App retires this entirely.",
  },
  {
    name: "SONAR_TOKEN",
    state: "optional",
    location: { scope: "org" },
    product: "actions",
    type: "service-token",
    owner: OWNER,
    consumedBy: [".github/workflows/ci.yml", ".github/workflows/_test-suite.yml"],
    maxAgeDays: 180,
    hardDeadline: null,
    expectedVisibility: "selected",
    note: "Quality gate skips its step when unset.",
  },

  // --- Nimbus: release bot + auditor ---
  {
    name: "RELEASE_BOT_APP_ID",
    state: "required",
    location: { scope: "repo", repo: "Nimbus" },
    product: "actions",
    type: "app-key",
    owner: OWNER,
    consumedBy: [".github/workflows/release.yml", ".github/workflows/release-please.yml"],
    maxAgeDays: null,
    hardDeadline: null,
    note: "App ID is stable across key rotations. Superseded by CLIENT_ID once Nimbus#779 lands.",
  },
  {
    name: "RELEASE_BOT_PRIVATE_KEY",
    state: "required",
    location: { scope: "repo", repo: "Nimbus" },
    product: "actions",
    type: "app-key",
    owner: OWNER,
    consumedBy: [".github/workflows/release.yml", ".github/workflows/release-please.yml"],
    maxAgeDays: 365,
    hardDeadline: null,
    note: "Mints 1-hour installation tokens; no schedule expiry, rotate on suspicion.",
  },
  {
    name: "SECRET_AUDITOR_CLIENT_ID",
    state: "required",
    location: { scope: "repo", repo: "Nimbus" },
    product: "actions",
    type: "app-key",
    owner: OWNER,
    consumedBy: [".github/workflows/secret-health.yml"],
    maxAgeDays: null,
    hardDeadline: null,
    note: "Read-only auditor App; no contents permission, must never be granted one.",
  },
  {
    name: "SECRET_AUDITOR_PRIVATE_KEY",
    state: "required",
    location: { scope: "repo", repo: "Nimbus" },
    product: "actions",
    type: "app-key",
    owner: OWNER,
    consumedBy: [".github/workflows/secret-health.yml"],
    maxAgeDays: 365,
    hardDeadline: null,
    note: "This system's own credential. Tracked here like any other.",
  },

  // --- Nimbus: release-path PATs (gap 4, pending deletion) ---
  {
    name: "RELEASE_PAT",
    state: "required",
    location: { scope: "repo", repo: "Nimbus" },
    product: "actions",
    type: "pat",
    owner: OWNER,
    consumedBy: [],
    maxAgeDays: 90,
    hardDeadline: null,
    note: "Superseded by the Release Bot App (#772). Flips to `forbidden` and is deleted once release.yml, publish-package-managers.yml and publish-linux-repo.yml have gone green under the App on a real tag.",
  },
  {
    name: "PACKAGE_MANAGER_PAT",
    state: "required",
    location: { scope: "repo", repo: "Nimbus" },
    product: "actions",
    type: "pat",
    owner: OWNER,
    consumedBy: [],
    maxAgeDays: 90,
    hardDeadline: null,
    note: "Superseded by the Release Bot App (#772). Same gate as RELEASE_PAT before deletion.",
  },
  {
    name: "WINGET_PAT",
    state: "required",
    location: { scope: "repo", repo: "Nimbus" },
    product: "actions",
    type: "pat",
    owner: OWNER,
    consumedBy: [".github/workflows/publish-package-managers.yml"],
    maxAgeDays: 90,
    hardDeadline: null,
    note: "Stays a PAT: it must fork microsoft/winget-pkgs, which the App cannot reach.",
  },

  // --- Nimbus: signing material ---
  {
    name: "GPG_SIGNING_SUBKEY",
    state: "required",
    location: { scope: "repo", repo: "Nimbus" },
    product: "actions",
    type: "signing-key",
    owner: OWNER,
    consumedBy: [".github/workflows/release.yml"],
    maxAgeDays: null,
    hardDeadline: null,
    note: "Carries its own GPG expiry, which the existing cert check reads. Calendar rotation is the wrong alarm.",
  },
  {
    name: "GPG_PASSPHRASE",
    state: "required",
    location: { scope: "repo", repo: "Nimbus" },
    product: "actions",
    type: "signing-key",
    owner: OWNER,
    consumedBy: [".github/workflows/release.yml"],
    maxAgeDays: null,
    hardDeadline: null,
    note: "Unlocks GPG_SIGNING_SUBKEY; rotates with it.",
  },
  {
    name: "UPDATER_SIGNING_KEY",
    state: "required",
    location: { scope: "repo", repo: "Nimbus" },
    product: "actions",
    type: "signing-key",
    owner: OWNER,
    consumedBy: [".github/workflows/release.yml"],
    maxAgeDays: null,
    hardDeadline: null,
    note: "Ed25519 updater-manifest key. Rotating it invalidates client trust; never on a calendar.",
  },

  // --- Nimbus: optional / absent ---
  {
    name: "CODECOV_TOKEN",
    state: "optional",
    location: { scope: "repo", repo: "Nimbus" },
    product: "actions",
    type: "service-token",
    owner: OWNER,
    consumedBy: [".github/workflows/_test-suite.yml"],
    maxAgeDays: 90,
    hardDeadline: null,
    note: "Coverage upload; the step degrades without it.",
  },
  {
    name: "BENCHER_API_KEY",
    state: "optional",
    location: { scope: "repo", repo: "Nimbus" },
    product: "actions",
    type: "service-token",
    owner: OWNER,
    consumedBy: [".github/workflows/_perf.yml"],
    maxAgeDays: 180,
    hardDeadline: null,
    note: "Benchmark upload.",
  },
  {
    name: "NIMBUS_CHECKS_TOKEN",
    state: "optional",
    location: { scope: "repo", repo: "Nimbus" },
    product: "actions",
    type: "pat",
    owner: OWNER,
    consumedBy: [".github/workflows/ci.yml", ".github/workflows/_test-suite.yml"],
    maxAgeDays: 90,
    hardDeadline: null,
    note: "Deleted 2026-07-19 after the monitor flagged it dead; workflows fall back to github.token.",
  },
  {
    name: "SCORECARD_TOKEN",
    state: "optional",
    location: { scope: "repo", repo: "Nimbus" },
    product: "actions",
    type: "pat",
    owner: OWNER,
    consumedBy: [".github/workflows/scorecard.yml"],
    maxAgeDays: 90,
    hardDeadline: null,
    note: "Read-only fine-grained PAT; Scorecard degrades without it.",
  },
  {
    name: "WINDOWS_CERT_PFX_BASE64",
    state: "optional",
    location: { scope: "repo", repo: "Nimbus" },
    product: "actions",
    type: "signing-key",
    owner: OWNER,
    consumedBy: [".github/workflows/release.yml"],
    maxAgeDays: null,
    hardDeadline: null,
    note: "Windows code-signing cert; unset today, so .msi ships unsigned.",
  },
  {
    name: "WINDOWS_CERT_PASSWORD",
    state: "optional",
    location: { scope: "repo", repo: "Nimbus" },
    product: "actions",
    type: "signing-key",
    owner: OWNER,
    consumedBy: [".github/workflows/release.yml"],
    maxAgeDays: null,
    hardDeadline: null,
    note: "Password for WINDOWS_CERT_PFX_BASE64.",
  },
  {
    name: "APPLE_CERT_P12_BASE64",
    state: "optional",
    location: { scope: "repo", repo: "Nimbus" },
    product: "actions",
    type: "signing-key",
    owner: OWNER,
    consumedBy: [".github/workflows/release.yml"],
    maxAgeDays: null,
    hardDeadline: null,
    note: "macOS signing cert; unset today.",
  },
  {
    name: "APPLE_CERT_PASSWORD",
    state: "optional",
    location: { scope: "repo", repo: "Nimbus" },
    product: "actions",
    type: "signing-key",
    owner: OWNER,
    consumedBy: [".github/workflows/release.yml"],
    maxAgeDays: null,
    hardDeadline: null,
    note: "Password for APPLE_CERT_P12_BASE64.",
  },
  {
    name: "NPM_TOKEN",
    state: "forbidden",
    location: { scope: "repo", repo: "Nimbus" },
    product: "actions",
    type: "service-token",
    owner: OWNER,
    consumedBy: [],
    maxAgeDays: null,
    hardDeadline: null,
    note: "Revoked 2026-07-19. Publishing is OIDC-only; both packages are set to mfa=publish, so a token cannot publish. If this reappears, someone has reintroduced a bypass.",
  },

  // --- nimbus-vscode ---
  {
    name: "VSCE_PAT",
    state: "required",
    location: { scope: "repo", repo: "nimbus-vscode" },
    product: "actions",
    type: "pat",
    owner: OWNER,
    consumedBy: [".github/workflows/publish.yml", ".github/workflows/secret-health.yml"],
    maxAgeDays: null,
    hardDeadline: "2026-12-01",
    note: "Azure DevOps PAT. Global ADO PATs are decommissioned 2026-12-01 and cannot be regenerated; see nimbus-vscode#34. Marketplace trusted publishing is unshipped (microsoft/vsmarketplace#1422).",
  },
  {
    name: "OVSX_PAT",
    state: "required",
    location: { scope: "repo", repo: "nimbus-vscode" },
    product: "actions",
    type: "pat",
    owner: OWNER,
    consumedBy: [".github/workflows/publish.yml", ".github/workflows/secret-health.yml"],
    maxAgeDays: 180,
    hardDeadline: null,
    note: "Open VSX has no OIDC path at all (eclipse-openvsx/openvsx#1534); rotation is the only mitigation.",
  },

  // --- nimbus-web-clipper (store publishing) ---
  ...(
    [
      ["AMO_JWT_ISSUER", "Firefox Add-ons API issuer."],
      ["AMO_JWT_SECRET", "Firefox Add-ons API secret."],
      ["CWS_CLIENT_ID", "Chrome Web Store OAuth client id."],
      ["CWS_CLIENT_SECRET", "Chrome Web Store OAuth client secret."],
      ["CWS_EXTENSION_ID", "Chrome Web Store extension id (identifier, not a secret, but stored as one)."],
      ["CWS_PUBLISHER_ID", "Chrome Web Store publisher id."],
      ["CWS_REFRESH_TOKEN", "Chrome Web Store refresh token."],
    ] as const
  ).map(
    ([name, note]): CredentialEntry => ({
      name,
      state: "required",
      location: { scope: "repo", repo: "nimbus-web-clipper" },
      product: "actions",
      type: "service-token",
      owner: OWNER,
      consumedBy: [".github/workflows/publish.yml"],
      maxAgeDays: 180,
      hardDeadline: null,
      note,
    }),
  ),
];
```

- [ ] **Step 4: Run the tests and watch them pass**

```bash
bun test scripts/release/credential-registry.test.ts
```

Expected: PASS, 10 tests.

- [ ] **Step 5: Prove one assertion can fail**

Temporarily change `NPM_TOKEN`'s `state` to `"optional"`, re-run, confirm the
`NPM_TOKEN is forbidden` test goes RED, then revert and confirm green. Paste both
outputs in the report.

- [ ] **Step 6: Lint and commit**

```bash
bunx biome check scripts/release/credential-registry.ts scripts/release/credential-registry.test.ts
git add scripts/release/credential-registry.ts scripts/release/credential-registry.test.ts
git commit -m "feat(secrets): declare the credential manifest

A prose table in docs/ci-secrets.md cannot be checked against reality, so it
drifts in both directions. This is the machine-readable declaration the weekly
monitor will diff against live GitHub state.

state is three-valued because two would be wrong: required/forbidden alone would
hard-fail the six credentials that are referenced but legitimately unset today
(the Windows/Apple signing certs, NIMBUS_CHECKS_TOKEN, SCORECARD_TOKEN)."
```

---

## Task 3: The verdict logic

**Files:**

- Create: `scripts/release/credential-audit.ts`
- Test: `scripts/release/credential-audit.test.ts`

**Interfaces:**

- Consumes: `CredentialEntry`, `CREDENTIAL_REGISTRY`, `HARD_DEADLINE_LEAD_DAYS`, `MANUAL_AUDIT_MAX_AGE_DAYS`, `SecretProduct` from Task 2.
- Produces:
  - `interface LiveSecret { name; scope; repo?; product; updatedAt; visibility? }`
  - `type InventoryStatus = "ok" | "missing" | "present" | "undocumented" | "stale" | "deadline" | "visibility-drift" | "audit-overdue"`
  - `function auditCredentials(entries, live, now): HealthRow[]` — used by Task 5.
  - `function daysBetween(a: Date, b: Date): number`

- [ ] **Step 1: Write the failing test**

Create `scripts/release/credential-audit.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { auditCredentials, daysBetween, type LiveSecret } from "./credential-audit";
import type { CredentialEntry } from "./credential-registry";

const NOW = new Date("2026-07-20T00:00:00Z");

function entry(over: Partial<CredentialEntry> = {}): CredentialEntry {
  return {
    name: "TEST_SECRET",
    state: "required",
    location: { scope: "repo", repo: "Nimbus" },
    product: "actions",
    type: "pat",
    owner: "@AsafGolombek",
    consumedBy: [".github/workflows/ci.yml"],
    maxAgeDays: 90,
    hardDeadline: null,
    note: "test",
    ...over,
  };
}

function live(over: Partial<LiveSecret> = {}): LiveSecret {
  return {
    name: "TEST_SECRET",
    scope: "repo",
    repo: "Nimbus",
    product: "actions",
    updatedAt: "2026-07-19T00:00:00Z",
    ...over,
  };
}

const find = (rows: readonly { name: string; status: string; detail: string }[], n: string) =>
  rows.find((r) => r.name.includes(n));

describe("auditCredentials", () => {
  test("a required credential that is present and fresh is ok", () => {
    const rows = auditCredentials([entry()], [live()], NOW);
    expect(find(rows, "TEST_SECRET")?.status).toBe("ok");
  });

  test("a required credential that is absent is a hard failure", () => {
    const rows = auditCredentials([entry()], [], NOW);
    expect(find(rows, "TEST_SECRET")?.status).toBe("missing");
  });

  test("an optional credential that is absent is ok — it is legitimately unset", () => {
    const rows = auditCredentials([entry({ state: "optional" })], [], NOW);
    expect(find(rows, "TEST_SECRET")?.status).toBe("ok");
  });

  test("a forbidden credential that is absent is ok", () => {
    const rows = auditCredentials([entry({ state: "forbidden", maxAgeDays: null })], [], NOW);
    expect(find(rows, "TEST_SECRET")?.status).toBe("ok");
  });

  test("a forbidden credential that exists is a hard failure — it came back", () => {
    const rows = auditCredentials(
      [entry({ state: "forbidden", maxAgeDays: null })],
      [live()],
      NOW,
    );
    expect(find(rows, "TEST_SECRET")?.status).toBe("present");
  });

  test("a live secret absent from the manifest is a hard failure", () => {
    const rows = auditCredentials([], [live({ name: "MYSTERY_TOKEN" })], NOW);
    const row = find(rows, "MYSTERY_TOKEN");
    expect(row?.status).toBe("undocumented");
    expect(row?.detail).toContain("Nimbus");
  });

  test("an over-age secret warns and says the SECRET was last set — never that the credential is old", () => {
    const rows = auditCredentials(
      [entry({ maxAgeDays: 30 })],
      [live({ updatedAt: "2026-01-01T00:00:00Z" })],
      NOW,
    );
    const row = find(rows, "TEST_SECRET");
    expect(row?.status).toBe("stale");
    expect(row?.detail).toContain("secret last set");
    expect(row?.detail).not.toContain("credential is");
  });

  test("maxAgeDays null opts out of age checks entirely", () => {
    const rows = auditCredentials(
      [entry({ maxAgeDays: null, type: "signing-key" })],
      [live({ updatedAt: "2020-01-01T00:00:00Z" })],
      NOW,
    );
    expect(find(rows, "TEST_SECRET")?.status).toBe("ok");
  });

  test("a hard deadline inside the 90-day lead time warns", () => {
    const rows = auditCredentials(
      [entry({ maxAgeDays: null, hardDeadline: "2026-09-01" })],
      [live()],
      NOW,
    );
    const row = find(rows, "TEST_SECRET");
    expect(row?.status).toBe("deadline");
    expect(row?.detail).toContain("2026-09-01");
  });

  test("a hard deadline beyond the lead time stays quiet", () => {
    const rows = auditCredentials(
      [entry({ maxAgeDays: null, hardDeadline: "2027-09-01" })],
      [live()],
      NOW,
    );
    expect(find(rows, "TEST_SECRET")?.status).toBe("ok");
  });

  test("org visibility wider than declared warns", () => {
    const rows = auditCredentials(
      [entry({ location: { scope: "org" }, expectedVisibility: "selected" })],
      [live({ scope: "org", repo: undefined, visibility: "all" })],
      NOW,
    );
    const row = find(rows, "TEST_SECRET");
    expect(row?.status).toBe("visibility-drift");
    expect(row?.detail).toContain("selected");
  });

  test("the same name in two repos is not confused for one credential", () => {
    const rows = auditCredentials(
      [
        entry({ name: "DUP", location: { scope: "repo", repo: "Nimbus" } }),
        entry({ name: "DUP", location: { scope: "repo", repo: "nimbus-vscode" } }),
      ],
      [live({ name: "DUP", repo: "Nimbus" })],
      NOW,
    );
    const statuses = rows.filter((r) => r.name.includes("DUP")).map((r) => r.status).sort();
    expect(statuses).toEqual(["missing", "ok"]);
  });

  test("Actions and Dependabot secrets of the same name are distinct credentials", () => {
    const rows = auditCredentials(
      [entry({ name: "SHARED", product: "dependabot" })],
      [live({ name: "SHARED", product: "actions" })],
      NOW,
    );
    const statuses = rows.filter((r) => r.name.includes("SHARED")).map((r) => r.status).sort();
    expect(statuses).toEqual(["missing", "undocumented"]);
  });

  test("a stale manual audit warns", () => {
    const rows = auditCredentials([], [], new Date("2027-01-01T00:00:00Z"));
    expect(find(rows, "manual audit")?.status).toBe("audit-overdue");
  });

  test("a recent manual audit does not warn", () => {
    const rows = auditCredentials([], [], NOW);
    expect(find(rows, "manual audit")?.status).toBe("ok");
  });
});

describe("daysBetween", () => {
  test("counts whole days", () => {
    expect(daysBetween(new Date("2026-01-01T00:00:00Z"), new Date("2026-01-31T00:00:00Z"))).toBe(30);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun test scripts/release/credential-audit.test.ts
```

Expected: FAIL — `Cannot find module './credential-audit'`.

- [ ] **Step 3: Implement**

Create `scripts/release/credential-audit.ts`:

```ts
import type { HealthRow } from "./check-secret-health";
import {
  CREDENTIAL_REGISTRY,
  type CredentialEntry,
  HARD_DEADLINE_LEAD_DAYS,
  LAST_MANUAL_AUDIT,
  MANUAL_AUDIT_MAX_AGE_DAYS,
  type SecretProduct,
} from "./credential-registry";

/** One secret as the GitHub API reports it: name and timestamps only, never a value. */
export interface LiveSecret {
  readonly name: string;
  readonly scope: "org" | "repo";
  readonly repo?: string;
  readonly product: SecretProduct;
  readonly updatedAt: string;
  /** Org-scoped secrets only. */
  readonly visibility?: "all" | "selected";
}

export type InventoryStatus =
  | "ok"
  | "missing"
  | "present"
  | "undocumented"
  | "stale"
  | "deadline"
  | "visibility-drift"
  | "audit-overdue";

export function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000);
}

/**
 * A credential's identity is scope + repo + product + name. Name alone is not
 * unique: the same name can legitimately exist in two repos, and GitHub keys
 * Actions and Dependabot secrets in separate namespaces.
 */
function keyOfEntry(e: CredentialEntry): string {
  return `${e.location.scope}:${e.location.repo ?? "-"}:${e.product}:${e.name}`;
}

function keyOfLive(s: LiveSecret): string {
  return `${s.scope}:${s.repo ?? "-"}:${s.product}:${s.name}`;
}

function label(scopeRepo: string | undefined, name: string): string {
  return scopeRepo ? `${scopeRepo}/${name}` : `org/${name}`;
}

function row(name: string, status: InventoryStatus, detail: string): HealthRow {
  return { name, kind: "inventory", status, detail };
}

/**
 * Diff the manifest against live state.
 *
 * `orphaned` is deliberately absent from the status set. A manifest entry whose
 * credential no longer exists is either `missing` (required — a workflow will
 * break) or `ok` (optional/forbidden — correctly absent). Deliberate deletion is
 * recorded by flipping `state` to `forbidden`, not by a separate verdict, so
 * there is no case where the system has to guess at intent.
 */
export function auditCredentials(
  entries: readonly CredentialEntry[] = CREDENTIAL_REGISTRY,
  live: readonly LiveSecret[] = [],
  now: Date = new Date(),
): HealthRow[] {
  const rows: HealthRow[] = [];
  const liveByKey = new Map(live.map((s) => [keyOfLive(s), s]));
  const seen = new Set<string>();

  for (const e of entries) {
    const key = keyOfEntry(e);
    seen.add(key);
    const found = liveByKey.get(key);
    const name = label(e.location.repo, e.name);

    if (!found) {
      rows.push(
        e.state === "required"
          ? row(name, "missing", `declared required but absent; consumed by ${e.consumedBy.join(", ") || "nothing recorded"}`)
          : row(name, "ok", e.state === "forbidden" ? "correctly absent" : "optional, unset"),
      );
      continue;
    }

    if (e.state === "forbidden") {
      rows.push(row(name, "present", `must not exist — ${e.note}`));
      continue;
    }

    if (e.expectedVisibility && found.visibility && found.visibility !== e.expectedVisibility) {
      rows.push(
        row(
          name,
          "visibility-drift",
          `visibility is "${found.visibility}", declared "${e.expectedVisibility}"`,
        ),
      );
      continue;
    }

    if (e.hardDeadline) {
      const remaining = daysBetween(now, new Date(`${e.hardDeadline}T00:00:00Z`));
      if (remaining <= HARD_DEADLINE_LEAD_DAYS) {
        rows.push(row(name, "deadline", `hard deadline ${e.hardDeadline} in ${remaining}d — ${e.note}`));
        continue;
      }
    }

    if (e.maxAgeDays !== null) {
      const age = daysBetween(new Date(found.updatedAt), now);
      if (age > e.maxAgeDays) {
        // Wording is load-bearing: updated_at is when the SECRET was last set,
        // not when the credential was issued. Claiming the latter would be a
        // stronger assertion than the data supports.
        rows.push(row(name, "stale", `secret last set ${age}d ago, policy ${e.maxAgeDays}d`));
        continue;
      }
    }

    rows.push(row(name, "ok", `secret last set ${daysBetween(new Date(found.updatedAt), now)}d ago`));
  }

  for (const s of live) {
    if (seen.has(keyOfLive(s))) continue;
    rows.push(
      row(
        label(s.repo, s.name),
        "undocumented",
        `${s.product} secret in ${s.repo ?? "org"} is absent from credential-registry.ts — add it or delete it`,
      ),
    );
  }

  const auditAge = daysBetween(new Date(`${LAST_MANUAL_AUDIT}T00:00:00Z`), now);
  rows.push(
    auditAge > MANUAL_AUDIT_MAX_AGE_DAYS
      ? row("manual audit", "audit-overdue", `docs/credential-hygiene.md last walked ${auditAge}d ago, policy ${MANUAL_AUDIT_MAX_AGE_DAYS}d`)
      : row("manual audit", "ok", `last walked ${auditAge}d ago`),
  );

  return rows;
}
```

> **On the import cycle.** `credential-audit.ts` imports `HealthRow` from
> `check-secret-health.ts`, and `check-secret-health.ts` imports `InventoryStatus`
> back from `credential-audit.ts`. Both of those are **`import type`**, which
> TypeScript erases, so there is no runtime cycle — only the one-directional
> value import of `auditCredentials`. Keep both as `import type`. If
> `bun run audit:boundaries` ever flags this, the fix is to move `HealthRow` into
> a shared types module, **not** to duplicate the type.

- [ ] **Step 4: Add `"inventory"` to `HealthRow.kind` so this compiles**

In `scripts/release/check-secret-health.ts`, change the `kind` union on `HealthRow` (line ~122) and widen `status`:

```ts
export interface HealthRow {
  readonly name: string;
  readonly kind: "pat" | "cert" | "provenance" | "absence" | "inventory";
  readonly status: PatStatus | CertStatus | ProvenanceStatus | AbsenceStatus | InventoryStatus;
  readonly detail: string;
}
```

Add the import at the top of the file:

```ts
import type { InventoryStatus } from "./credential-audit";
```

- [ ] **Step 5: Run the tests and watch them pass**

```bash
bun test scripts/release/credential-audit.test.ts
```

Expected: PASS, 16 tests.

- [ ] **Step 6: Prove the two hard verdicts can fail**

Do both, reverting after each, and paste all four outputs:

1. In `auditCredentials`, change the `!found` branch so `required` returns `"ok"` instead of `"missing"`. Confirm `a required credential that is absent is a hard failure` goes RED. Revert.
2. Delete the final `for (const s of live)` loop. Confirm `a live secret absent from the manifest is a hard failure` goes RED. Revert.

- [ ] **Step 7: Lint and commit**

```bash
bunx biome check scripts/release/credential-audit.ts scripts/release/credential-audit.test.ts scripts/release/check-secret-health.ts
git add scripts/release/credential-audit.ts scripts/release/credential-audit.test.ts scripts/release/check-secret-health.ts
git commit -m "feat(secrets): diff the credential manifest against live state

undocumented is a HARD failure and there is no orphaned verdict at all.

Hard, because a credential nobody recorded is one nobody has assessed — and the
fix is one line. The spec originally paired it with an orphaned warn for
manifest entries that no longer exist, but that overlapped with required+absent
and would have forced the code to guess intent. Three-valued state records the
intent instead, so absence is either missing (required) or correctly ok."
```

---

## Task 4: Enumerate live secrets from GitHub

**Files:**

- Create: `scripts/release/credential-enumerate.ts`
- Test: `scripts/release/credential-enumerate.test.ts`

**Interfaces:**

- Consumes: `LiveSecret`, `SecretProduct`.
- Produces: `function enumerateSecrets(deps): Promise<{ secrets: LiveSecret[]; errors: string[] }>` — used by Task 5.

- [ ] **Step 1: Write the failing test**

Create `scripts/release/credential-enumerate.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { enumerateSecrets } from "./credential-enumerate";

type Handler = (url: string) => { status: number; body: unknown };

function fetcher(handler: Handler) {
  return async (url: string): Promise<Response> => {
    const { status, body } = handler(url);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
}

describe("enumerateSecrets", () => {
  test("tags org secrets with scope, product and visibility", async () => {
    const { secrets, errors } = await enumerateSecrets({
      token: "t",
      repos: [],
      fetchFn: fetcher(() => ({
        status: 200,
        body: { secrets: [{ name: "ORG_ONE", updated_at: "2026-01-01T00:00:00Z", visibility: "all" }] },
      })),
    });
    expect(errors).toEqual([]);
    expect(secrets).toEqual([
      {
        name: "ORG_ONE",
        scope: "org",
        product: "actions",
        updatedAt: "2026-01-01T00:00:00Z",
        visibility: "all",
      },
    ]);
  });

  test("enumerates both Actions and Dependabot secrets per repo", async () => {
    const { secrets } = await enumerateSecrets({
      token: "t",
      repos: ["Nimbus"],
      fetchFn: fetcher((url) => {
        if (url.includes("orgs/")) return { status: 200, body: { secrets: [] } };
        const name = url.includes("dependabot") ? "DEP" : "ACT";
        return { status: 200, body: { secrets: [{ name, updated_at: "2026-01-01T00:00:00Z" }] } };
      }),
    });
    expect(secrets.map((s) => `${s.product}:${s.name}`).sort()).toEqual([
      "actions:ACT",
      "dependabot:DEP",
    ]);
  });

  test("a 403 is reported as an error, never silently treated as an empty repo", async () => {
    const { secrets, errors } = await enumerateSecrets({
      token: "t",
      repos: ["Nimbus"],
      fetchFn: fetcher((url) =>
        url.includes("dependabot")
          ? { status: 403, body: { message: "Resource not accessible by integration" } }
          : { status: 200, body: { secrets: [] } },
      ),
    });
    expect(secrets).toEqual([]);
    expect(errors.join(" ")).toContain("403");
    expect(errors.join(" ")).toContain("dependabot");
  });

  test("a 404 on a repo is tolerated — the App may not be installed there", async () => {
    const { errors } = await enumerateSecrets({
      token: "t",
      repos: ["ghost"],
      fetchFn: fetcher((url) =>
        url.includes("orgs/") ? { status: 200, body: { secrets: [] } } : { status: 404, body: {} },
      ),
    });
    expect(errors).toEqual([]);
  });

  test("never puts the token in a URL", async () => {
    const seen: string[] = [];
    await enumerateSecrets({
      token: "super-secret-token",
      repos: ["Nimbus"],
      fetchFn: async (url: string) => {
        seen.push(url);
        return new Response(JSON.stringify({ secrets: [] }), { status: 200 });
      },
    });
    expect(seen.join(" ")).not.toContain("super-secret-token");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun test scripts/release/credential-enumerate.test.ts
```

Expected: FAIL — `Cannot find module './credential-enumerate'`.

- [ ] **Step 3: Implement**

Create `scripts/release/credential-enumerate.ts`:

```ts
import type { LiveSecret } from "./credential-audit";
import type { SecretProduct } from "./credential-registry";

const API = "https://api.github.com";
const ORG = "nimbus-agent";

interface SecretListResponse {
  readonly secrets?: readonly {
    readonly name?: unknown;
    readonly updated_at?: unknown;
    readonly visibility?: unknown;
  }[];
}

/** Narrow the API payload without trusting it. Anything malformed is skipped, not coerced. */
function parseSecrets(
  body: unknown,
  scope: "org" | "repo",
  product: SecretProduct,
  repo?: string,
): LiveSecret[] {
  const list = (body as SecretListResponse)?.secrets;
  if (!Array.isArray(list)) return [];
  const out: LiveSecret[] = [];
  for (const s of list) {
    if (typeof s?.name !== "string" || typeof s?.updated_at !== "string") continue;
    const visibility = s.visibility === "all" || s.visibility === "selected" ? s.visibility : undefined;
    out.push({
      name: s.name,
      scope,
      ...(repo ? { repo } : {}),
      product,
      updatedAt: s.updated_at,
      ...(visibility ? { visibility } : {}),
    });
  }
  return out;
}

export async function enumerateSecrets(deps: {
  token: string;
  repos: readonly string[];
  fetchFn?: (url: string, init?: RequestInit) => Promise<Response>;
}): Promise<{ secrets: LiveSecret[]; errors: string[] }> {
  const fetchFn = deps.fetchFn ?? fetch;
  const secrets: LiveSecret[] = [];
  const errors: string[] = [];

  // The token travels in the Authorization header, never in the URL — a URL can
  // land in a log line, a redirect, or an error message.
  const get = async (path: string): Promise<{ status: number; body: unknown }> => {
    const res = await fetchFn(`${API}${path}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${deps.token}`,
        "x-github-api-version": "2022-11-28",
      },
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  };

  const org = await get(`/orgs/${ORG}/actions/secrets`);
  if (org.status === 200) secrets.push(...parseSecrets(org.body, "org", "actions"));
  else errors.push(`org actions secrets: HTTP ${org.status}`);

  for (const repo of deps.repos) {
    for (const product of ["actions", "dependabot"] as const) {
      const r = await get(`/repos/${ORG}/${repo}/${product}/secrets`);
      if (r.status === 200) {
        secrets.push(...parseSecrets(r.body, "repo", product, repo));
        continue;
      }
      // 404 means the App is not installed on that repo, which is a
      // configuration fact, not a failure. 403 means the permission is missing —
      // that MUST surface, because silently reporting zero secrets for a repo
      // would make `undocumented` claim a completeness it does not have.
      if (r.status !== 404) errors.push(`${repo} ${product} secrets: HTTP ${r.status}`);
    }
  }

  return { secrets, errors };
}
```

- [ ] **Step 4: Run the tests and watch them pass**

```bash
bun test scripts/release/credential-enumerate.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Prove the 403 assertion can fail**

Change the `if (r.status !== 404)` guard to `if (false)`, confirm
`a 403 is reported as an error` goes RED, revert, confirm green. Paste both.

- [ ] **Step 6: Lint and commit**

```bash
bunx biome check scripts/release/credential-enumerate.ts scripts/release/credential-enumerate.test.ts
git add scripts/release/credential-enumerate.ts scripts/release/credential-enumerate.test.ts
git commit -m "feat(secrets): enumerate live secret names via the read-only auditor App

Distinguishes 404 (App not installed — a configuration fact) from 403
(permission missing — must surface). Collapsing them would let a permission
regression report zero secrets for a repo, and the undocumented verdict would
then claim a completeness it does not have."
```

---

## Task 5: Wire the inventory into the weekly monitor

**Files:**

- Modify: `scripts/release/check-secret-health.ts`
- Modify: `scripts/release/check-secret-health.test.ts`
- Modify: `.github/workflows/secret-health.yml`

**Interfaces:**

- Consumes: `auditCredentials` (Task 3), `enumerateSecrets` (Task 4), `CREDENTIAL_REGISTRY` (Task 2).
- Produces: inventory rows merged into `extraRows`.

- [ ] **Step 1: Write the failing test**

Append to `scripts/release/check-secret-health.test.ts`:

```ts
describe("summarize with inventory rows", () => {
  test("undocumented is a hard failure", () => {
    const s = summarize([{ name: "org/X", kind: "inventory", status: "undocumented", detail: "d" }]);
    expect(s.hasHardFailure).toBe(true);
  });

  test("missing is a hard failure", () => {
    const s = summarize([{ name: "org/X", kind: "inventory", status: "missing", detail: "d" }]);
    expect(s.hasHardFailure).toBe(true);
  });

  test("stale, deadline, visibility-drift and audit-overdue warn but do not fail", () => {
    for (const status of ["stale", "deadline", "visibility-drift", "audit-overdue"] as const) {
      const s = summarize([{ name: "org/X", kind: "inventory", status, detail: "d" }]);
      expect(s.hasHardFailure).toBe(false);
      expect(s.hasWarning).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun test scripts/release/check-secret-health.test.ts
```

Expected: FAIL — `undocumented is a hard failure` and the warn test fail, because
`summarize`'s sets do not yet contain the new statuses.

- [ ] **Step 3: Extend `summarize`'s sets**

In `scripts/release/check-secret-health.ts`, update the two sets inside `summarize`:

```ts
  const hard = new Set<string>([
    "dead",
    "insufficient",
    "expired",
    "missing-provenance",
    "source-mismatch",
    "present",
    // Inventory: a credential nobody recorded is a credential nobody assessed.
    "undocumented",
    "missing",
  ]);
  const warn = new Set<string>([
    "expiring",
    "indeterminate",
    "stale",
    "deadline",
    "visibility-drift",
    "audit-overdue",
  ]);
```

- [ ] **Step 4: Run the tests and watch them pass**

```bash
bun test scripts/release/check-secret-health.test.ts
```

Expected: PASS.

- [ ] **Step 5: Retire the bespoke `NPM_TOKEN` classifier**

`NPM_TOKEN` is now a `forbidden` manifest entry, so the hand-rolled special case
is redundant. In `check-secret-health.ts`, delete the `npmTokenRow` construction
and remove it from the `extraRows` array, leaving:

```ts
  const { hardFailure } = await runSecretHealth({
    api: createGitHubApi({ token, repo }),
    // ...
    extraRows: [appMintRow, ...provenanceRows, ...inventoryRows],
  });
```

Delete `classifySecretAbsence` and its `AbsenceStatus` type, plus the `"absence"`
member of `HealthRow.kind`, and delete the tests that exercised them
(`classifySecretAbsence` describe block and the `a returned NPM_TOKEN is a hard
failure` case). The general mechanism now covers this: Task 3's
`a forbidden credential that exists is a hard failure` test is the replacement.

- [ ] **Step 6: Wire the enumeration into the entrypoint**

In the `if (import.meta.main)` block of `check-secret-health.ts`, before the
`runSecretHealth` call, add:

```ts
  // The auditor token is minted by the workflow and passed in; without it the
  // inventory check is skipped rather than reported as "no secrets found",
  // which would fire `missing` for every declared credential at once.
  const auditorToken = process.env["AUDITOR_TOKEN"] ?? "";
  const inventoryRows: HealthRow[] = [];
  if (auditorToken) {
    const repos = [...new Set(CREDENTIAL_REGISTRY.flatMap((e) => (e.location.repo ? [e.location.repo] : [])))];
    const { secrets, errors } = await enumerateSecrets({ token: auditorToken, repos });
    for (const e of errors) {
      inventoryRows.push({
        name: "inventory",
        kind: "inventory",
        status: "undocumented",
        detail: `enumeration failed: ${e} — inventory is incomplete, treat as unverified`,
      });
    }
    inventoryRows.push(...auditCredentials(CREDENTIAL_REGISTRY, secrets, new Date()));
  } else {
    inventoryRows.push({
      name: "inventory",
      kind: "inventory",
      status: "audit-overdue",
      detail: "AUDITOR_TOKEN not provided — credential inventory not checked this run",
    });
  }
```

Add the imports:

```ts
import { auditCredentials } from "./credential-audit";
import { enumerateSecrets } from "./credential-enumerate";
import { CREDENTIAL_REGISTRY } from "./credential-registry";
```

- [ ] **Step 7: Mint the auditor token in the workflow**

In `.github/workflows/secret-health.yml`, add a mint step immediately after the
existing `app-mint` step:

```yaml
      - name: Mint auditor token (read-only credential inventory)
        id: auditor-mint
        continue-on-error: true
        uses: actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3.2.0
        with:
          client-id: ${{ secrets.SECRET_AUDITOR_CLIENT_ID }}
          private-key: ${{ secrets.SECRET_AUDITOR_PRIVATE_KEY }}
          owner: nimbus-agent
```

and add one line to the `env:` block of the `Run secret-health check` step:

```yaml
          AUDITOR_TOKEN: ${{ steps.auditor-mint.outputs.token }}
```

`continue-on-error` matches the sibling probes: a mint failure must degrade to a
skipped inventory row, not abort the job and silence PAT and cert monitoring.

- [ ] **Step 8: Verify the workflow parses and the suite is green**

```bash
python -c "import yaml; yaml.safe_load(open('.github/workflows/secret-health.yml')); print('yaml ok')"
bun test scripts/release/
bunx biome check packages scripts
```

Expected: `yaml ok`, all tests pass, biome clean. (`python3` is a Store stub on
this machine — use `python`.)

- [ ] **Step 9: Commit**

```bash
git add scripts/release/check-secret-health.ts scripts/release/check-secret-health.test.ts .github/workflows/secret-health.yml
git commit -m "feat(secrets): check the credential inventory in the weekly monitor

Retires the hand-rolled NPM_TOKEN absence classifier: it was a special case of
'this credential must not exist', which the manifest now expresses as a
forbidden entry.

A missing AUDITOR_TOKEN skips the inventory rather than enumerating nothing —
an empty result would fire `missing` for every declared credential at once and
bury the real signal."
```

---

## Task 6: Keep `consumedBy` honest

**Files:**

- Create: `scripts/structure-audit/check-consumed-by.ts`
- Modify: `scripts/lib/preflight-gates.ts`
- Modify: `package.json`

**Interfaces:**

- Consumes: `CREDENTIAL_REGISTRY`.
- Produces: the `audit:consumed-by` preflight gate.

- [ ] **Step 1: Write the checker**

Create `scripts/structure-audit/check-consumed-by.ts`:

```ts
/**
 * Preflight gate: the manifest's Nimbus-scoped entries and this repo's workflow
 * `secrets.*` references must agree.
 *
 * Monorepo-only by design. Extending it across the other 17 repos would require
 * reading their workflow files, i.e. `contents: read` — the permission
 * deliberately withheld so the auditor App cannot read code. Paying for
 * validation of a documentation field with a code-read grant is a bad trade.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CREDENTIAL_REGISTRY } from "../release/credential-registry";

const WORKFLOWS = join(process.cwd(), ".github", "workflows");

/** Secrets GitHub injects itself; never declared in the manifest. */
const BUILTIN = new Set(["GITHUB_TOKEN"]);

function referencedSecrets(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of readdirSync(WORKFLOWS).filter((f) => f.endsWith(".yml"))) {
    const text = readFileSync(join(WORKFLOWS, file), "utf8");
    for (const m of text.matchAll(/secrets\.([A-Z0-9_]+)/g)) {
      const name = m[1];
      if (!name || BUILTIN.has(name)) continue;
      const list = found.get(name) ?? [];
      if (!list.includes(file)) list.push(file);
      found.set(name, list);
    }
  }
  return found;
}

function main(): void {
  const referenced = referencedSecrets();
  const declared = new Map(
    CREDENTIAL_REGISTRY.filter(
      (e) => e.product === "actions" && (e.location.scope === "org" || e.location.repo === "Nimbus"),
    ).map((e) => [e.name, e]),
  );

  const problems: string[] = [];

  for (const [name, files] of referenced) {
    if (!declared.has(name)) {
      problems.push(`${name} is referenced by ${files.join(", ")} but is not in credential-registry.ts`);
    }
  }

  for (const [name, entry] of declared) {
    if (entry.state === "forbidden") continue;
    if (entry.consumedBy.length === 0) continue;
    if (!referenced.has(name)) {
      problems.push(
        `${name} declares consumedBy ${entry.consumedBy.join(", ")} but no workflow in this repo references it`,
      );
    }
  }

  if (problems.length > 0) {
    console.error("audit:consumed-by: FAILED");
    for (const p of problems) console.error(`  - ${p}`);
    process.exitCode = 1;
    return;
  }
  console.log(`audit:consumed-by: OK (${declared.size} declared, ${referenced.size} referenced)`);
}

main();
```

- [ ] **Step 2: Register the script**

In `package.json`, add to `scripts`:

```json
    "audit:consumed-by": "bun scripts/structure-audit/check-consumed-by.ts",
```

- [ ] **Step 3: Register the preflight gate**

In `scripts/lib/preflight-gates.ts`, add after the `audit:action-sha-pins` entry:

```ts
  { name: "audit:consumed-by", cmd: ["bun", "run", "audit:consumed-by"], tier: "fast" },
```

- [ ] **Step 4: Run it**

```bash
bun run audit:consumed-by
```

Expected: `audit:consumed-by: OK (...)`. If it reports a name referenced but not
declared, that is a **real finding** — add the entry to the manifest rather than
weakening the check. Record any such addition in the report.

- [ ] **Step 5: Prove it can fail**

Temporarily delete the `WINGET_PAT` entry from the manifest, re-run, confirm
`FAILED` naming `WINGET_PAT`, then restore and confirm `OK`. Paste both.

- [ ] **Step 6: Confirm the drift test still passes**

The preflight gate manifest has a drift test that fails when a CI gate is missing:

```bash
bun test scripts/lib/
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/structure-audit/check-consumed-by.ts scripts/lib/preflight-gates.ts package.json
git commit -m "feat(secrets): gate on manifest/workflow agreement at PR time

consumedBy is hand-maintained and will drift like any prose. This asserts the
correspondence in both directions for this repo, in preflight rather than the
weekly monitor — it needs no credentials, so it should fail at PR time."
```

---

## Task 7: The manual workstation audit

**Files:**

- Create: `docs/credential-hygiene.md`
- Modify: `docs/ci-secrets.md`

**Interfaces:**

- Consumes: `LAST_MANUAL_AUDIT` (Task 2).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the hygiene doc**

Create `docs/credential-hygiene.md`:

````markdown
# Credential Hygiene — the manual quarterly audit

The weekly `secret-health.yml` monitor checks everything reachable from CI. This
page covers what it structurally cannot: credentials on a developer workstation.

Sub-project 3 produced the motivating case. Exactly one npm token served as both
the CI secret and the maintainer's local `~/.npmrc` session, so revoking it broke
the workstation — and nothing in any repo could see that coupling.

**Cadence:** quarterly. `credential-registry.ts` records `LAST_MANUAL_AUDIT`; the
monitor warns once it is more than 90 days old. Bump that constant when you
finish a pass, in the same commit as any findings.

## Rotation ordering — configure, then revoke

Provision the replacement and **verify it works** before revoking what it
replaces. Getting this backwards has already cost a reversal: revoking the npm
token before the package policies were set killed the maintainer's own CLI
session mid-task.

To verify, dispatch the monitor and read the credential's row:

```bash
gh workflow run secret-health.yml --repo nimbus-agent/Nimbus
```

`ok` means a live service accepted it. `dead` means a reachable service rejected
it. `indeterminate` means the service could not be reached — that is not evidence
either way, and is not a reason to revoke anything.

## The checklist

- [ ] `~/.npmrc` — any `_authToken` present? Run `npm whoami`. A 401 with a token
      still on disk means a **revoked credential is being retained in plaintext**.
      This was the state of the maintainer's machine on 2026-07-20.
- [ ] `~/.docker/config.json` — registry auth entries.
- [ ] `~/.aws/credentials` and `~/.aws/config` — long-lived access keys.
- [ ] `git config --get-regexp credential` and the OS credential helper store.
- [ ] `gh auth status` — scopes wider than needed? `admin:org` on a daily-driver
      token is worth questioning.
- [ ] OS keychain (Keychain Access / Credential Manager / `secret-tool`) for
      entries belonging to retired services.
- [ ] `~/Downloads` and `~/Desktop` for `.pem`, `.p12`, `.pfx`, `.key` files. App
      private keys are frequently left there after being pasted into a secret.
- [ ] **Codespaces secrets** — out of the auditor's scope. Check
      <https://github.com/settings/codespaces> and the org's Codespaces settings.
- [ ] **Push protection** — confirm it is enabled on every repository.
      *(Only needed if the Task 1 probe showed the auditor cannot read
      `security_and_analysis`; if it can, the monitor covers this.)*

## What the automated side cannot tell you

`updated_at` is when a **secret was last set**, not when the **credential was
issued**. Re-saving an unchanged value resets the clock while nothing rotated, and
GitHub exposes no API for a PAT's true issue date — the organization audit log
that would record this requires Enterprise Cloud, and this org is on Free.

So a quiet monitor is not proof of rotation. That is what this page is for.
````

- [ ] **Step 2: Point `docs/ci-secrets.md` at the manifest**

Add this immediately after the "Quick reference" table's closing prose:

```markdown
> **The machine-checked inventory lives in
> [`scripts/release/credential-registry.ts`](../scripts/release/credential-registry.ts).**
> That manifest is authoritative for anything checkable — expected state,
> ownership, rotation policy, and consuming workflows — and the weekly monitor
> hard-fails on any secret in the org that is missing from it. This page carries
> the narrative: what each credential is for and how to mint it. When they
> disagree, the manifest is right.
>
> Workstation credentials are out of CI's reach entirely; see
> [`credential-hygiene.md`](./credential-hygiene.md).
```

- [ ] **Step 3: Lint**

```bash
bun run lint:markdown
bun run audit:doc-refs
```

Expected: `Summary: 0 error(s)` and the doc-refs audit passing.

- [ ] **Step 4: Commit**

```bash
git add docs/credential-hygiene.md docs/ci-secrets.md
git commit -m "docs(secrets): the manual workstation audit

Opens with a real finding from this machine rather than hypotheticals: a revoked
npm token is still sitting in ~/.npmrc, inert but retained in plaintext, and no
CI-side inventory can see it.

Writes down configure-then-revoke, the ordering whose absence killed the
maintainer's own npm session during sub-project 3."
```

---

## Task 8: Close the hardening gaps

Live operations against GitHub, not code. Each step states its own verification.

**Files:** none in this repo (except the report).

- [ ] **Step 1: Enable secret scanning and push protection on `nimbus-sdk` (Gap 1)**

```bash
gh api -X PATCH repos/nimbus-agent/nimbus-sdk \
  -f 'security_and_analysis[secret_scanning][status]=enabled' \
  -f 'security_and_analysis[secret_scanning_push_protection][status]=enabled'
```

Verify across every repo:

```bash
for r in $(gh repo list nimbus-agent --limit 30 --json name --jq '.[].name'); do
  printf "%-26s " "$r"
  gh api repos/nimbus-agent/$r --jq '"scanning=\(.security_and_analysis.secret_scanning.status) push=\(.security_and_analysis.secret_scanning_push_protection.status)"'
done
```

Expected: `enabled` / `enabled` for all 18.

- [ ] **Step 2: Enumerate every consumer of `RELEASE_PLEASE_PAT` before narrowing it (Gap 2)**

Do **not** skip this. Narrowing on an incomplete list breaks a release silently in
a repo nobody is watching.

```bash
for r in $(gh repo list nimbus-agent --limit 30 --json name --jq '.[].name'); do
  hits=$(gh api "search/code?q=RELEASE_PLEASE_PAT+repo:nimbus-agent/$r" --jq '.total_count' 2>/dev/null || echo "?")
  [ "$hits" != "0" ] && echo "$r => $hits"
done
```

Cross-check by fetching each repo's workflow directory listing, because code
search can lag indexing:

```bash
for r in $(gh repo list nimbus-agent --limit 30 --json name --jq '.[].name'); do
  for f in $(gh api repos/nimbus-agent/$r/contents/.github/workflows --jq '.[].name' 2>/dev/null); do
    gh api repos/nimbus-agent/$r/contents/.github/workflows/$f --jq '.content' 2>/dev/null \
      | base64 -d | grep -q RELEASE_PLEASE_PAT && echo "$r/$f"
  done
done
```

Expected consumers: `nimbus-sdk`, `nimbus-client`, `nimbus-vscode`. **If any other
repo appears, stop and report** — the narrowing list changes.

- [ ] **Step 3: Narrow `RELEASE_PLEASE_PAT` to its real consumers (Gap 2)**

```bash
ids=$(for r in nimbus-sdk nimbus-client nimbus-vscode; do gh api repos/nimbus-agent/$r --jq '.id'; done | paste -sd, -)
gh api -X PUT orgs/nimbus-agent/actions/secrets/RELEASE_PLEASE_PAT/repositories \
  -f "selected_repository_ids=[$ids]"
gh api orgs/nimbus-agent/actions/secrets/RELEASE_PLEASE_PAT --jq '.visibility'
gh api orgs/nimbus-agent/actions/secrets/RELEASE_PLEASE_PAT/repositories --jq '[.repositories[].name]'
```

Expected: `selected`, and exactly the three repos.

If `visibility` is still `all`, set it first:

```bash
gh api -X PUT orgs/nimbus-agent/actions/secrets/RELEASE_PLEASE_PAT \
  -f visibility=selected -f "selected_repository_ids=[$ids]"
```

- [ ] **Step 4: Confirm the narrowing did not break a consumer (Gap 2)**

```bash
gh workflow run release.yml --repo nimbus-agent/nimbus-client || true
```

Wait for it and confirm the release-please job still mints. A failure here means
the narrowing was wrong — widen it back immediately and report.

- [ ] **Step 5: Environment-scope the web-clipper store secrets (Gap 3)**

The 7 secrets must be **re-entered**, not moved: secret values cannot be read back
out. This is a human step — report it as an owner action rather than attempting it:

1. Create the `release` environment on `nimbus-agent/nimbus-web-clipper`.
2. Re-enter `AMO_JWT_ISSUER`, `AMO_JWT_SECRET`, `CWS_CLIENT_ID`,
   `CWS_CLIENT_SECRET`, `CWS_EXTENSION_ID`, `CWS_PUBLISHER_ID`,
   `CWS_REFRESH_TOKEN` as environment secrets.
3. Add `environment: release` to the publishing job.
4. Delete the repo-level copies **only after** a publish succeeds — configure,
   then revoke.

Leave protection rules off unless a human approval on store publishes is wanted.

- [ ] **Step 6: Record Gap 4 as gated, do not execute it**

`RELEASE_PAT` and `PACKAGE_MANAGER_PAT` stay. Their manifest entries already carry
the gate. Confirm the gate is still unmet:

```bash
gh run list --repo nimbus-agent/Nimbus --workflow release.yml --limit 3 --json conclusion,event,createdAt
```

If no tag-triggered run has gone green under the App, the gate is unmet and the
PATs stay. State this explicitly in the report.

- [ ] **Step 7: Commit the report**

No repo files change in this task; record every command and its real output in the
task report file.

---

## Task 9: Prove the `undocumented` path live

The hard-failure path never runs on a healthy monitor, so it must be driven
deliberately — the same blind spot that hid a broken alert path in sub-project 3.

**Files:** none. This is a live exercise with cleanup.

- [ ] **Step 1: Confirm the monitor is currently green**

```bash
gh workflow run secret-health.yml --repo nimbus-agent/Nimbus
```

Wait, then confirm `conclusion: success` and read the inventory rows in the step
summary. Every declared credential should be `ok`. **Any `undocumented` row here is
a real finding** — a credential missing from the manifest — so add it to
`credential-registry.ts` rather than dismissing it, and note it in the report.

- [ ] **Step 2: Plant a throwaway secret**

```bash
gh secret set ZZ_AUDIT_PROBE --repo nimbus-agent/nimbus-benchmarks --body "not-a-real-credential"
```

`nimbus-benchmarks` is chosen because it holds no other secrets, so the probe
cannot be confused with real state.

- [ ] **Step 3: Confirm the monitor hard-fails and names it**

```bash
gh workflow run secret-health.yml --repo nimbus-agent/Nimbus
```

Expected: the run **fails**, an issue is filed or commented, and a row reads
approximately:

```text
| nimbus-benchmarks/ZZ_AUDIT_PROBE | inventory | undocumented | actions secret in nimbus-benchmarks is absent from credential-registry.ts — add it or delete it |
```

Paste the real row.

- [ ] **Step 4: Remove the probe and confirm the monitor recovers**

```bash
gh secret delete ZZ_AUDIT_PROBE --repo nimbus-agent/nimbus-benchmarks
gh workflow run secret-health.yml --repo nimbus-agent/Nimbus
```

Expected: `conclusion: success`, and the health issue closed with
"All release credentials healthy".

- [ ] **Step 5: Confirm cleanup**

```bash
gh secret list --repo nimbus-agent/nimbus-benchmarks
gh issue list --repo nimbus-agent/Nimbus --state open --search "credential health"
```

Expected: no `ZZ_AUDIT_PROBE`, no open health issue.

- [ ] **Step 6: Run the full gate set and open the PR**

```bash
bun run typecheck
bunx biome check packages scripts
bun run lint:markdown
bun run audit:doc-refs
bun run audit:consumed-by
bun run audit:status-drift
bun run audit:action-sha-pins
bun run audit:boundaries
bun run audit:invariants
bun run audit:cross-platform
bun test scripts/release/
bun test scripts/lib/
```

`bun run preflight` aborts early on the known `.claude/worktrees/` biome
false-fail, so run the gates individually as above. All must pass before pushing.

```bash
git push -u origin dev/asafgolombek/credential-rotation-hardening
gh pr create --fill
```

**Check `mergeable` / `mergeStateStatus` before trusting `gh pr checks`.** A PR
that conflicts with `main` runs **no** `pull_request` workflows at all — it looks
like a green two-check PR when in fact CI never ran. If it reports `CONFLICTING`,
rebase onto `main` and force-push with `--force-with-lease`.
