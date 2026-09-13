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
still open as of 2026-09-12, though actively discussed — 9 comments, last touched
2026-09-10).

**The Open VSX half is no longer indefinite (re-checked 2026-09-12).** This paragraph used to say
`OVSX_PAT` "has no OIDC path either and never will until
[eclipse-openvsx/openvsx#1534](https://github.com/eclipse-openvsx/openvsx/issues/1534) lands".
That issue **closed COMPLETED on 2026-08-21** — nine days after this section was written — and
Trusted Publishing shipped in server **v1.2.0** (PR
[#2000](https://github.com/eclipse-openvsx/openvsx/pull/2000), commit `d5a01c83`), with CLI support
in `ovsx` v1.2.0 (`cli/src/oidc.ts`, `cli/src/trusted-publishing.ts`). Usage is a `--trusted-publishing`
flag plus the `id-token: write` permission `publish.yml` already grants.

**It is nevertheless NOT actionable yet, for a reason that is easy to miss: merged upstream is not
deployed here.** `https://open-vsx.org/api/version` reports **`v1.1.2`** — the release immediately
BEFORE the feature (v1.1.2 shipped 2026-08-20, the merge landed 2026-08-21), confirmed by
`gh api repos/eclipse-openvsx/openvsx/compare/v1.1.1...v1.1.2` containing no such commit. So the
trusted-publisher registration UI does not exist on the instance we publish to, and switching
`publish.yml` today would fail the next release rather than remove a secret.

**The trigger is therefore a one-line check, not more research:**

```bash
curl -s https://open-vsx.org/api/version   # retire OVSX_PAT once this reports v1.2.0 or later
```

When it does, the migration is written out below so it does not need re-deriving. It is ordered
configure-then-revoke, per the rule at the top of this page: **nothing is deleted until a trusted
publish has actually succeeded.**

1. **Register the publisher.** [open-vsx.org trusted publishers](https://open-vsx.org/user-settings/trusted-publishers)
   — namespace-owner action, web UI only, no API. Pin it to the `nimbus-agent` namespace and the
   `nimbus-vscode` publish workflow.
2. **Add a controlled-publish mode to `publish.yml` that OMITS `OVSX_PAT` without deleting it.**
   This step exists because the obvious order does not work: the publish job currently *hard-fails
   on an empty* `OVSX_PAT` (`if [ -z "$OVSX_PAT" ]; then echo "::error::..."`), so simply deleting
   the secret aborts at that guard before `ovsx` ever runs — and you would be testing trusted
   publishing for the first time with the old credential already gone. Gate the guard and the
   `OVSX_PAT:` env line on an input (a `workflow_dispatch` boolean, say) so a dry run can take the
   trusted-publishing branch while the secret is still sitting there as the rollback.
3. **Upgrade `ovsx` to v1.2.0 or later in `nimbus-vscode`, lockfile included — before step 4, or
   step 4 fails for a reason that has nothing to do with OIDC.** `package.json` declares
   `"ovsx": "^1.1.0"` and `bun.lock` resolves `ovsx@1.1.0`; the publish job installs with
   `bun install --frozen-lockfile` and then runs `bunx ovsx publish`, which prefers the locally
   installed `node_modules/.bin/ovsx` over anything it could fetch. So the range *permitting*
   1.2.0 changes nothing on its own — the locked 1.1.0 is what runs, and v1.1.0 has no
   `trusted-publishing.ts` / `oidc.ts` at all (they first appear at
   [`v1.2.0`](https://github.com/eclipse-openvsx/openvsx/tree/v1.2.0/cli/src)), so commander
   rejects `--trusted-publishing` as an unknown option. `bun update ovsx` and commit the
   regenerated `bun.lock`; confirm with `bunx ovsx publish --help`.
4. **Add `--trusted-publishing` to the `ovsx publish` call.** With the flag, the run FAILS rather
   than silently falling back if no ID token can be obtained — which is what you want for a
   verification run. Note the precedence trap it guards against: `--pat` / `OVSX_PAT` always wins
   over trusted publishing, so with the secret still exported the migration looks done while
   nothing has changed.
5. **Prove it** — one dispatch of the controlled mode, publishing a real version, succeeding.
6. **Only then delete the secret** from `nimbus-vscode` → *Settings* → *Environments* → **release**,
   and drop `OVSX_PAT` from both `publish.yml` and `secret-health.yml` (including its
   `probe-publish-token` step, which has nothing left to probe).
7. **Flip the registry entry, or you trade one alert for another.** In
   `scripts/release/credential-registry.ts`, set the `OVSX_PAT` entry to `state: "forbidden"`,
   `consumedBy: []`, `maxAgeDays: null`. A deleted secret left at `state: "required"` is reported
   by `auditCredentials` as a hard `missing` every week — the same permanently-open-alert failure
   this page warns about elsewhere — and `forbidden` is the state that says *deliberately deleted;
   must not come back*, which is exactly the claim being made. This is this migration's equivalent
   of step 5 in the `VSCE_PAT` runbook above: the one that gets forgotten.

Until open-vsx.org upgrades, rotation on the 180-day age policy remains the only mitigation for
this half.
