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
- [ ] **Push protection** — confirm it is enabled on every repository. The
      auditor App cannot read a repository's `security_and_analysis` field, and
      it will not be widened to grant it that (widening it further would trade
      away the read-only guarantee this whole system depends on) — so this stays
      a manual check indefinitely, not a gap this program intends to close.

## What the automated side cannot tell you

`updated_at` is when a **secret was last set**, not when the **credential was
issued**. Re-saving an unchanged value resets the clock while nothing rotated, and
GitHub exposes no API for a PAT's true issue date — the organization audit log
that would record this requires Enterprise Cloud, and this org is on Free.

So a quiet monitor is not proof of rotation. That is what this page is for.
