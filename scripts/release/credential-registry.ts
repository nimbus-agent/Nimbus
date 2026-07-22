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
    state: "optional",
    location: { scope: "repo", repo: "Nimbus" },
    product: "actions",
    type: "app-key",
    owner: OWNER,
    consumedBy: [],
    maxAgeDays: null,
    hardDeadline: null,
    note: "Superseded by RELEASE_BOT_CLIENT_ID (Nimbus#779); no workflow reads it any more, so it is safe to delete. Held at `optional` rather than `forbidden` deliberately: the secret still exists, and `forbidden` + present is a HARD failure that would red the monitor for a credential that is merely obsolete. Flip to `forbidden` once it is actually deleted.",
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

  // --- Nimbus: release-path PATs (gap 4, pending deletion) ---
  {
    name: "RELEASE_PAT",
    state: "required",
    location: { scope: "repo", repo: "Nimbus" },
    product: "actions",
    type: "pat",
    owner: OWNER,
    // Deliberately empty and VERIFIED empty: the App migration (#772) removed
    // every reference. The note below names the workflows that must go green
    // under the App before deletion — those are the GATE, not consumers.
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
    // Deliberately empty and VERIFIED empty — see RELEASE_PAT above.
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
    consumedBy: [
      ".github/workflows/publish-package-managers.yml",
      ".github/workflows/secret-health.yml",
    ],
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
