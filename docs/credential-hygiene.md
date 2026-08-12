# Credential Hygiene — the manual quarterly audit

The weekly `secret-health.yml` monitor checks everything reachable from CI. This
page covers what it structurally cannot: credentials on a developer workstation.

Sub-project 3 produced the motivating case. Exactly one npm token served as both
the CI secret and the maintainer's local `~/.npmrc` session, so revoking it broke
the workstation — and nothing in any repo could see that coupling.

**Cadence:** quarterly. `credential-registry.ts` records `LAST_MANUAL_AUDIT`;
once this hardening branch merges, the monitor warns when it is more than 90
days old. Bump that constant when you finish a pass, in the same commit as any
findings.

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
- [ ] **Push protection** — confirm it is enabled on every **public** repository.
      The auditor App cannot read a repository's `security_and_analysis` field,
      and it will not be widened to grant it that (widening it further would
      trade away the read-only guarantee this whole system depends on) — so this
      stays a manual check indefinitely, not a gap this program intends to close.

Scope that last item honestly: secret scanning is **unavailable on private
repositories** on this organization's Free plan. The API returns `null` for all
six of them and rejects an enable attempt with `422 Secret scanning is not
available for this repository`. Verified 2026-07-21 — all 12 public repos are
`enabled`/`enabled`; the 6 private ones cannot be, and that is a plan
limitation rather than a misconfiguration to chase. Re-check if the organization
ever moves off Free.

## What the automated side cannot tell you

`updated_at` is when a **secret was last set**, not when the **credential was
issued**. Re-saving an unchanged value resets the clock while nothing rotated, and
GitHub exposes no API for a PAT's true issue date — the organization audit log
that would record this requires Enterprise Cloud, and this org is on Free.

So a quiet monitor is not proof of rotation. That is what this page is for.

## Runbook — regenerating `VSCE_PAT`

`VSCE_PAT` is the one credential on a **hard calendar deadline** rather than an
age policy: it expires **2026-09-20**, and the first extension release after that
date fails at the `vsce publish` step. Nothing else breaks — it is not a merge
gate, and the Nimbus gateway release path does not touch it.

Azure DevOps PATs cannot be created non-interactively, so this is a manual task.
The steps are short; the one that gets forgotten is step 5.

1. **Create the token.** <https://dev.azure.com/asafgolombek/_usersSettings/tokens>
   → *New Token*. Organization **asafgolombek** (not "all accessible
   organizations" — org-scoped is what keeps this out of the 2026-12-01 global-PAT
   decommission). Scope: **Marketplace → Manage**. Set an expiry and write it
   down; you need it for step 5.
2. **Store it.** `nimbus-vscode` → *Settings* → *Environments* → **release** →
   update the `VSCE_PAT` secret. It is an **environment** secret, not a repository
   secret — pasting it at repo level leaves the publish job reading the old value.
3. **Verify — before revoking anything.** Run the `secret-health` workflow in
   `nimbus-vscode` manually. It live-probes the token via `probe-publish-token`
   (`tool: vsce`), so a bad paste or a wrong-scope store surfaces in about a
   minute instead of at the next release.
4. **Revoke the old token** in the same ADO tokens page, and only once step 3
   reported `ok`. This is the configure-then-revoke ordering rule from the top of
   this page: until the replacement is proven, the old token is the rollback, and
   revoking first throws it away at exactly the moment you might need it.
5. **Update the deadline.** Set `hardDeadline` on the `VSCE_PAT` entry in
   `scripts/release/credential-registry.ts` to the new expiry date. Skipping this
   is the failure mode with teeth: the date is hand-maintained, so a stale past
   date makes the health job cry wolf every week, and deleting the field instead
   makes it go silent through the next real expiry.

### Why there is no OIDC path (attempted 2026-08-12)

`@vscode/vsce` supports `vsce publish --azure-credential`, which authenticates as
a Microsoft Entra service principal and would remove this credential entirely. It
was set up end to end and **does not work for this publisher**:

- An Entra app registration + a GitHub OIDC federated credential
  (`repo:nimbus-agent/nimbus-vscode:environment:release`) were created
  successfully — that half is fine.
- Granting that service principal rights on the `nimbus-agent` Marketplace
  publisher fails with **`TF14045: The identity could not be found`**.
- Root cause: the backing Azure DevOps organization (`asafgolombek`) is
  **MSA-backed** — its identity source is personal Microsoft accounts, and
  *Organization settings → Microsoft Entra* offers "Connect directory", meaning it
  has never been connected to one. A service principal exists only inside an Entra
  directory, so ADO cannot resolve it at all. This is a structural mismatch, not a
  permissions or spelling problem.

The Azure objects were deleted after the attempt; nothing is left behind.

**Do not "fix" this by connecting the organization to a directory.** That remaps
how every existing user of the org signs in — enormous blast radius to avoid one
token renewal.

Revisit when Marketplace **Trusted Publishing** ships
([microsoft/vsmarketplace#1422](https://github.com/microsoft/vsmarketplace/issues/1422),
still open as of 2026-08-12). `OVSX_PAT` has no OIDC path either and never will
until [eclipse-openvsx/openvsx#1534](https://github.com/eclipse-openvsx/openvsx/issues/1534)
lands, so rotation remains the only mitigation for the Open VSX half regardless.
