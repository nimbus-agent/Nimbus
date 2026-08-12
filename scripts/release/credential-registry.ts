/**
 * The credential manifest: the single machine-checked declaration of every
 * credential this organization holds.
 *
 * `docs/ci-secrets.md` carries the human narrative and points here; this file is
 * authoritative for anything checkable. Once the weekly monitor is wired to diff
 * live GitHub state against this manifest, adding a secret anywhere in the org
 * without adding it here will hard-fail with `undocumented` — that is the intent
 * of this file, though the wiring itself is a separate, not-yet-done task.
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

/**
 * The point at which an approaching hard deadline stops being *scheduled work*
 * and becomes a *failure*.
 *
 * Between `HARD_DEADLINE_LEAD_DAYS` and this, a deadline row is
 * `deadline-approaching`: a warning, never an exit-1, because nothing is broken
 * — the credential still authenticates and the only fact in evidence is a date
 * on a calendar. At or inside this window it becomes `deadline-critical`, a hard
 * failure, because the runway a replacement needs is gone.
 *
 * **Why 14 and not 7 or 21.** The monitor runs on one weekly cron (Mondays
 * 09:00 UTC). A 7-day window yields exactly ONE run before the deadline — and
 * this org has already lost queued scheduled runs to shared-concurrency
 * eviction, so a single-run alarm can produce zero alarms. 14 days yields TWO
 * (one at 8–14 days out, one at 1–7), so a lost run still leaves an alarm while
 * the credential is alive. 21 days (the cert `thresholdDays` default) would buy
 * a third run at the cost of a third week of standing red, and standing red is
 * the exact failure mode this split exists to end: the escalation must mean
 * "act this week", not "act eventually".
 *
 * The 76 days before escalation are not silent — they are the
 * `deadline-approaching` warning, which files/updates the health issue without
 * failing the job.
 */
export const HARD_DEADLINE_CRITICAL_DAYS = 14;

/** Quarterly, matching the default maxAgeDays so the cadences cannot drift apart. */
export const MANUAL_AUDIT_MAX_AGE_DAYS = 90;

/** Bump this when `docs/credential-hygiene.md` is actually walked through. */
export const LAST_MANUAL_AUDIT = "2026-07-20";

const OWNER = "@AsafGolombek";

export const CREDENTIAL_REGISTRY: readonly CredentialEntry[] = [
  // --- org scope ---
  {
    name: "RELEASE_PLEASE_PAT",
    state: "forbidden",
    location: { scope: "org" },
    product: "actions",
    type: "pat",
    owner: OWNER,
    consumedBy: [],
    maxAgeDays: null,
    hardDeadline: null,
    note: "Deleted 2026-07-22 — the last long-lived release PAT retired. All four consumers now mint from the Release Bot App: Nimbus (#787), nimbus-client (#8), nimbus-sdk (#16), nimbus-vscode (#42), each proven with a live 'Mint release-bot token: success'. If this reappears, someone has reintroduced a PAT where the App now works.",
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
    state: "forbidden",
    location: { scope: "repo", repo: "Nimbus" },
    product: "actions",
    type: "app-key",
    owner: OWNER,
    consumedBy: [],
    maxAgeDays: null,
    hardDeadline: null,
    note: "Deleted 2026-07-22. Superseded by RELEASE_BOT_CLIENT_ID when the App-mint steps moved off the deprecated `app-id` input (Nimbus#779). No workflow reads it. If it reappears, someone has reintroduced the deprecated input.",
  },
  {
    name: "RELEASE_BOT_CLIENT_ID",
    state: "required",
    location: { scope: "org" },
    product: "actions",
    type: "app-key",
    owner: OWNER,
    consumedBy: [
      ".github/workflows/release.yml",
      ".github/workflows/release-please.yml",
      ".github/workflows/publish-package-managers.yml",
      ".github/workflows/publish-linux-repo.yml",
      ".github/workflows/secret-health.yml",
      "nimbus-client/.github/workflows/release.yml",
      "nimbus-sdk/.github/workflows/release.yml",
    ],
    maxAgeDays: null,
    hardDeadline: null,
    expectedVisibility: "all",
    note: "Org secret (2026-07-22), visibility all — the client ID is public (readable from GET /apps/{slug}), so all-repo exposure costs nothing and it need never be touched again. Consolidated from per-repo copies on Nimbus + nimbus-client. Consumed by all three repos that mint Release Bot tokens.",
  },
  {
    name: "RELEASE_BOT_PRIVATE_KEY",
    state: "required",
    location: { scope: "org" },
    product: "actions",
    type: "app-key",
    owner: OWNER,
    consumedBy: [
      ".github/workflows/release.yml",
      ".github/workflows/release-please.yml",
      "nimbus-client/.github/workflows/release.yml",
      "nimbus-sdk/.github/workflows/release.yml",
    ],
    maxAgeDays: 365,
    hardDeadline: null,
    expectedVisibility: "selected",
    note: "Org secret (2026-07-22) SCOPED to Nimbus + nimbus-client + nimbus-sdk — the three repos that mint tokens. Deliberately NOT visibility:all: the key can mint contents/PRs/issues:write tokens for any installed repo, so the blast radius is kept to the repos that need it. Mints 1-hour installation tokens; no schedule expiry, rotate on suspicion (now one place, not three).",
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

  // --- Nimbus: CLA bot ---
  {
    name: "CLA_BOT_APP_ID",
    state: "forbidden",
    location: { scope: "org" },
    product: "actions",
    type: "app-key",
    owner: OWNER,
    consumedBy: [],
    maxAgeDays: null,
    hardDeadline: null,
    note: "Deleted 2026-07-30 (Nimbus#854). Same shape as RELEASE_BOT_APP_ID: created 2026-07-24T09:30Z while wiring the CLA Assistant App, then superseded hours later by CLA_BOT_CLIENT_ID (12:39Z) when the mint step used the `client-id` input rather than the deprecated `app-id`. It was never removed, so it sat in the org unreferenced — secret-health could only report it as `undocumented`, which is why it is registered here rather than silently deleted. `cla.yml` reads only CLA_BOT_CLIENT_ID + CLA_BOT_PRIVATE_KEY. If it reappears, someone has reintroduced the deprecated input.",
  },
  {
    name: "CLA_BOT_CLIENT_ID",
    state: "required",
    location: { scope: "org" },
    product: "actions",
    type: "app-key",
    owner: OWNER,
    consumedBy: [".github/workflows/cla.yml"],
    maxAgeDays: null,
    hardDeadline: null,
    expectedVisibility: "selected",
    note: "Org secret (2026-07-24). Mints the CLA Assistant App token that writes the signature store. Like RELEASE_BOT_CLIENT_ID the client ID is public (readable from GET /apps/{slug}), so age is the wrong alarm — but kept visibility:selected to match its private key rather than widening one half of a pair.",
  },
  {
    name: "CLA_BOT_PRIVATE_KEY",
    state: "required",
    location: { scope: "org" },
    product: "actions",
    type: "app-key",
    owner: OWNER,
    consumedBy: [".github/workflows/cla.yml"],
    maxAgeDays: 365,
    hardDeadline: null,
    expectedVisibility: "selected",
    note: "Org secret (2026-07-24) SCOPED to the repos running the CLA gate. Mints 1-hour installation tokens for the CLA Assistant App; no schedule expiry, rotate on suspicion.",
  },

  // --- Nimbus: release-path PATs (retired 2026-07-22) ---
  {
    name: "RELEASE_PAT",
    state: "forbidden",
    location: { scope: "repo", repo: "Nimbus" },
    product: "actions",
    type: "pat",
    owner: OWNER,
    consumedBy: [],
    maxAgeDays: null,
    hardDeadline: null,
    note: "Deleted 2026-07-22. Superseded by the Release Bot App (#772); the gate was met when v0.23.1 published under the App with publish-package-managers.yml + publish-linux-repo.yml both green. If this reappears, someone has reintroduced a PAT where the App now works.",
  },
  {
    name: "PACKAGE_MANAGER_PAT",
    state: "forbidden",
    location: { scope: "repo", repo: "Nimbus" },
    product: "actions",
    type: "pat",
    owner: OWNER,
    consumedBy: [],
    maxAgeDays: null,
    hardDeadline: null,
    note: "Deleted 2026-07-22. Same App gate as RELEASE_PAT (WINGET_PAT stays — it forks an external repo the App cannot reach). If this reappears, someone has reintroduced a PAT the App migration retired.",
  },
  {
    name: "WINGET_PAT",
    state: "required",
    location: { scope: "repo", repo: "Nimbus" },
    product: "actions",
    type: "pat",
    owner: OWNER,
    consumedBy: [
      ".github/workflows/publish-package-managers.yml",
      ".github/workflows/secret-health.yml",
    ],
    maxAgeDays: 90,
    hardDeadline: null,
    note: "Stays a PAT: it must fork microsoft/winget-pkgs, which the App cannot reach. Classic PAT, scopes `public_repo` AND `workflow` — `workflow` is not optional: syncing the fork replays upstream commits that touch `.github/workflows/`, which GitHub refuses without it (winget froze at 1.19.1 for five days in 2026-08 on exactly this).",
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
    state: "forbidden",
    location: { scope: "repo", repo: "Nimbus" },
    product: "actions",
    type: "service-token",
    owner: OWNER,
    consumedBy: [],
    maxAgeDays: null,
    hardDeadline: null,
    note: "Deleted 2026-07-21. It never reached Codecov: _test-suite.yml is a reusable workflow and its secrets contract declares SONAR_TOKEN only, so secrets.CODECOV_TOKEN resolved to an empty string there. Uploads authenticate via OIDC (use_oidc + id-token: write). Surfaced as a staleness row (95d vs 90d), but the real finding was redundancy, not age. If this reappears, someone has added a token path where OIDC already works.",
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
    name: "APPLE_TEAM_ID",
    state: "optional",
    location: { scope: "repo", repo: "Nimbus" },
    product: "actions",
    type: "signing-key",
    owner: OWNER,
    consumedBy: [".github/workflows/release.yml"],
    maxAgeDays: null,
    hardDeadline: null,
    note: "Apple Developer Team ID for the macOS .pkg signing/notarization set. Unset today; scripts/sign/sign-macos.sh degrades to a no-op without it and APPLE_CERT_P12_BASE64.",
  },
  {
    name: "APPLE_DEVELOPER_ID_APP",
    state: "optional",
    location: { scope: "repo", repo: "Nimbus" },
    product: "actions",
    type: "signing-key",
    owner: OWNER,
    consumedBy: [".github/workflows/release.yml"],
    maxAgeDays: null,
    hardDeadline: null,
    note: "Developer ID Application identity passed to codesign; unset today, part of the same signing set as APPLE_CERT_P12_BASE64.",
  },
  {
    name: "APPLE_DEVELOPER_ID_INSTALLER",
    state: "optional",
    location: { scope: "repo", repo: "Nimbus" },
    product: "actions",
    type: "signing-key",
    owner: OWNER,
    consumedBy: [".github/workflows/release.yml"],
    maxAgeDays: null,
    hardDeadline: null,
    note: "Developer ID Installer identity passed to productsign for the .pkg; unset today, part of the same signing set as APPLE_CERT_P12_BASE64.",
  },
  {
    name: "APPLE_NOTARY_ID",
    state: "optional",
    location: { scope: "repo", repo: "Nimbus" },
    product: "actions",
    type: "signing-key",
    owner: OWNER,
    consumedBy: [".github/workflows/release.yml"],
    maxAgeDays: null,
    hardDeadline: null,
    note: "Apple ID for notarytool; notarization is best-effort in scripts/sign/sign-macos.sh and is skipped without it and APPLE_NOTARY_PASSWORD.",
  },
  {
    name: "APPLE_NOTARY_PASSWORD",
    state: "optional",
    location: { scope: "repo", repo: "Nimbus" },
    product: "actions",
    type: "signing-key",
    owner: OWNER,
    consumedBy: [".github/workflows/release.yml"],
    maxAgeDays: null,
    hardDeadline: null,
    note: "App-specific password paired with APPLE_NOTARY_ID for notarytool; unset today.",
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
    hardDeadline: "2026-09-20",
    note: "Azure DevOps PAT, confirmed org-scoped to `asafgolombek` in the ADO portal 2026-07-22 (nimbus-vscode#34) — so the 2026-12-01 GLOBAL-PAT decommission does NOT apply here. An Entra/OIDC migration is not merely unnecessary for that decommission — it is BLOCKED: `vsce publish --azure-credential` authenticates as an Entra service principal, but the backing ADO org (`asafgolombek`) is MSA-backed and has never been connected to a directory, so granting an SP publisher rights fails with TF14045 (identity not found). Attempted end-to-end and torn down 2026-08-12; see docs/credential-hygiene.md for the full finding, and do NOT connect the org to a directory to work around it. The binding date is instead the token's own expiry, 2026-09-20: Marketplace publishing breaks then unless it is regenerated. Regeneration is routine precisely because the token is org-scoped (global PATs have been uncreatable since 2026-03-15). Deliberately NOT the later decommission date — that one is not real for us and, at 90-day lead, would have stayed silent past the expiry that actually bites. Marketplace trusted publishing is still unshipped (microsoft/vsmarketplace#1422).",
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
      [
        "CWS_EXTENSION_ID",
        "Chrome Web Store extension id (identifier, not a secret, but stored as one).",
      ],
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
