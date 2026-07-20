# Credential Rotation & Hardening — Design

**Sub-project 4 of the org secrets-management program.** Sub-projects 1–3 shipped
release-health verification, the GitHub App migration, and npm supply-chain
assurance. This one closes the program: it makes the credential inventory
machine-checked, narrows what is over-exposed, and writes down what only a human
can audit.

**Date:** 2026-07-20 · **Status:** design approved, plan pending

---

## Why this exists

Sub-project 3 surfaced a finding no CI-side check could have produced: exactly one
npm token served as both the CI secret and the maintainer's local `~/.npmrc`
session, so revoking it broke the workstation. Nothing in the repo could see that
coupling.

Verified again while designing this: `npm whoami` on the maintainer's machine
returns 401 and the revoked token string is **still sitting in `~/.npmrc`**. It is
inert, but it is a dead credential persisted in plaintext, invisible to every
automated inventory that exists today.

That is the shape of the problem. The credential inventory is a prose table in
`docs/ci-secrets.md` that nothing validates, so it can silently disagree with
reality in both directions — documenting credentials that no longer exist, and
missing credentials nobody recorded.

## Goals

1. Make the credential inventory **machine-checked** against live state.
2. Detect the drift that prose cannot: **undocumented** and **orphaned** credentials.
3. Provide a **rotation signal** from data the API actually exposes.
4. Close four concrete exposure gaps found during the survey.
5. Write down the workstation audit that no CI job can perform — and make
   *forgetting* it machine-detectable.

## Non-goals

- Rotating any credential as part of this work. The system reports; the human rotates.
- Retiring `VSCE_PAT` / `OVSX_PAT`. No OIDC path exists for either
  (microsoft/vsmarketplace#1422, eclipse-openvsx/openvsx#1534); tracked separately.
- Migrating the satellites onto the GitHub App. Related and desirable, but a
  distinct piece of work.

---

## Architecture

### The read-only auditor App

The existing monitor can only inspect credentials it is explicitly handed via
`env:`. That verifies manifest → reality, never reality → manifest, so it can
never detect a secret nobody documented.

Enumerating secrets requires `GET /repos/{owner}/{repo}/actions/secrets`, which
returns **names and `updated_at` only — never values**.

The Release Bot App was rejected as the vehicle. App permissions are uniform
across every installed repo, and the Release Bot holds `contents: write` on 4
repos. Installing it on all 18 to read secret *names* would have granted write
access to 14 more repos, including 6 private ones — the same
"credential reachable from more places than it needs" mistake this sub-project
exists to fix.

**A second, read-only App is used instead:** `nimbus-secret-auditor`
(app_id `4347847`), permissions `metadata:read` + `secrets:read` +
`organization_secrets:read`, no write anywhere, installed on all repositories.
The Release Bot is untouched.

Verified live before design sign-off: the App mints via `client-id`, its
installation covers **18 repositories**, and it successfully enumerated org
secrets plus per-repo secrets including a private repo. Credentials are stored as
`SECRET_AUDITOR_CLIENT_ID` / `SECRET_AUDITOR_PRIVATE_KEY` repo secrets on `Nimbus`.
`client-id` is used rather than `app-id`, which is deprecated (Nimbus#779).

### The manifest

`scripts/release/credential-registry.ts` holds one typed entry per credential:

```ts
interface CredentialEntry {
  name: string;
  state: "required" | "forbidden";
  location: { scope: "org" | "repo"; repo?: string };
  type: "pat" | "app-key" | "signing-key" | "service-token";
  owner: string;               // who rotates it
  consumedBy: string[];        // workflow paths, so an orphan is traceable
  maxAgeDays: number | null;   // null = age is not the right signal
  hardDeadline: string | null; // ISO date, e.g. VSCE_PAT's 2026-12-01
  expectedVisibility?: "all" | "selected"; // org-scoped entries only
  note: string;
}
```

`expectedVisibility` exists so Gap 2 stays fixed. Narrowing
`RELEASE_PLEASE_PAT` to `selected` is invisible to every other check here, and a
later widening back to `all` would be silent. The org secrets API returns
`visibility`, so recording the expected value makes regression a warn rather than
a discovery. It applies only to org-scoped entries.

The manifest is authoritative for anything checkable. `docs/ci-secrets.md` keeps
the human-facing narrative and points at the manifest rather than restating it —
the same split already used between `CLAUDE.md` and `docs/CHANGELOG.md`.

### Verdicts

The monitor joins the manifest against enumerated live state:

| Condition | Verdict |
| --- | --- |
| `required`, absent | **hard** |
| `forbidden`, present | **hard** |
| present, absent from manifest (**undocumented**) | **hard** |
| `required`, age > `maxAgeDays`, or within the `hardDeadline` lead time | warn |
| in manifest, no longer exists (**orphaned**) | warn |

**Thresholds are explicit, not implied.** `maxAgeDays` is per-entry. The
`hardDeadline` lead time is **90 days** — deliberately longer than the existing
21-day cert-expiry threshold, because a hard external deadline may require
*investigation* rather than a rotation: `VSCE_PAT`'s 2026-12-01 decommission could
end in an Azure tenant procurement, which 21 days does not accommodate.

`undocumented` is hard and `orphaned` only warns — deliberately the opposite of
the intuition that a missing thing is worse than an extra one. A hard failure must
be *rare and actionable* or operators learn to ignore it. An undocumented secret is
both: rare, and fixed by one line in the manifest. `orphaned` is the normal,
expected aftermath of a deliberate deletion — exactly what happened with
`NPM_TOKEN` and `NIMBUS_CHECKS_TOKEN`. Making that hard would turn every correct
cleanup into a red monitor, training the operator to ignore the alarm.

This is the same principle already encoded in the four-state probe design, where
`dead` requires an independently-confirmed-reachable service so an alert never says
"rotate" for a credential that never existed.

### Honesty constraint on the rotation signal

`updated_at` records when the **secret was last set**, not when the underlying
credential was **issued**. Rotating a PAT at GitHub without updating the secret
leaves the clock looking fresh; re-pasting the same value resets the clock while
nothing rotated.

It is a useful proxy, not truth. Row details must therefore read
*"secret last set N days ago"* and never *"credential is N days old"*. This is the
same discipline that forbids describing `verify-npm-provenance` as verifying
cryptography.

Against live data on 2026-07-20, a 90-day `maxAgeDays` immediately flags
`CODECOV_TOKEN` (last set 2026-04-16, 95 days) and puts the three signing keys
(76 days) on the horizon — so the check carries real signal on day one.

`maxAgeDays: null` applies to `GPG_SIGNING_SUBKEY` and `UPDATER_SIGNING_KEY`.
Signing keys should not rotate on a calendar, and GPG already carries its own
expiry, which the existing cert check reads. Age would be the wrong alarm.

### Retirement

The bespoke `NPM_TOKEN` absence classifier collapses into a `forbidden` manifest
entry, so the special case stops being special. Its tests are repointed at the
general mechanism.

---

## The four hardening gaps

Ordered by what must be true first.

### Gap 1 — `nimbus-sdk` has secret scanning and push protection disabled

The only repo of 18 without both. Free for public repos. Safe to fix immediately.

Whether it *stays* fixed is an open question: `security_and_analysis` requires
**admin** repo permission, and the auditor deliberately holds only `metadata:read`,
`secrets:read` and `organization_secrets:read`. Rather than reflexively widening
the App, the plan **probes
whether the auditor can read this field**. If it can, push protection becomes a
monitored row across all 18 repos. If it cannot, it is a one-time fix plus a line
in the manual checklist. The App's permissions are not widened for it.

### Gap 2 — `RELEASE_PLEASE_PAT` is org-visible to all 18 repos

Three repos consume it. Any workflow in the other 15, including 6 private repos,
can read it.

**Precondition:** "references it in a workflow I have read" is not the same as
"is the complete set of consumers." Narrowing on an incomplete list breaks a
release silently in a repo nobody is watching — precisely the failure this program
exists to prevent. The plan must enumerate consumers across all 18 repos first,
narrow second, then confirm the known consumers still mint.

Narrowing is the correct *interim* state, not the destination: migrating the
satellites onto the App retires this PAT entirely.

### Gap 3 — `nimbus-web-clipper`'s 7 store secrets are not environment-scoped

Plain repo secrets with no environment, unlike `Nimbus` and `nimbus-vscode`.
Create a `release` environment, move the secrets, add `environment: release` to the
publishing job.

Scope honestly: environment scoping's real value is *optional* protection rules
(required reviewers, wait timers). Moving the secrets without adding a rule buys
scoping and an audit trail, not gating. Protection rules stay off unless a human
approval on store publishes is wanted.

### Gap 4 — `RELEASE_PAT` and `PACKAGE_MANAGER_PAT` still live (gated)

Staged for deletion since sub-project 2, and the gate has **not** been met. It
requires `nimbus-sdk` PR #14 merged, a release cutting cleanly, and `release.yml` /
`publish-package-managers.yml` / `publish-linux-repo.yml` going green **under the
App** — all three run only on tag/release events and have never been exercised
since the migration.

Deleting first is how one discovers the App migration missed a call site, at the
worst possible moment. This lands as a **gated checklist item**, not an executed
step. The manifest marks both `required` today, with a note that they flip to
`forbidden` once the release cycle proves out.

---

## The manual workstation audit

`docs/credential-hygiene.md` — a checklist for what no CI job can reach:
`~/.npmrc`, `~/.docker/config.json`, `~/.aws/credentials`, git credential helpers,
`gh auth token`, OS keychain entries, and downloaded key material in `~/Downloads`.

It is seeded with the finding already in hand — the revoked npm token still in the
maintainer's `~/.npmrc`. A checklist that opens with a real hit from this machine
is likelier to be run than one full of hypotheticals.

A checklist silently stops being run. The same drift principle applies: record
`lastManualAudit` as a date in the manifest and have the monitor warn when it is
more than **90 days** old — quarterly, matching the `maxAgeDays` default so the
two cadences do not drift apart. The step stays manual; *forgetting* it becomes
machine-detectable.

---

## Testing

**Unit tests** follow the existing `check-secret-health.test.ts` shape. The
manifest-to-reality join is a pure function over two arrays, so every verdict is
testable without network. Fixtures use real enumerated shapes captured from the
live probe, not invented ones.

**Every new verdict requires a red/green proof** — break the code, watch that
specific test fail, revert. Non-negotiable: in sub-project 3, four defects survived
accurate-sounding subagent reports and were caught only by re-running things.

**Live verification of `undocumented`.** This path cannot be proven by a healthy
run — the same structural blind spot as the alert-filing path in sub-project 3. The
plan proves it directly: create a throwaway secret in one repo, dispatch the
monitor, confirm a hard failure naming that secret and an issue filed, then delete
the secret and confirm the monitor returns green.

**Built-in completeness self-test.** Seeding the manifest with all currently-known
credentials makes the first live run the completeness check — anything missed
appears as `undocumented`. A clean first run means the inventory is provably
complete rather than assumed complete.

---

## Risks

| Risk | Mitigation |
| --- | --- |
| Auditor private key becomes a credential this system must itself track | It is an App key minting 1-hour tokens, and it appears in the manifest like any other credential |
| `updated_at` misread as credential issue date | Row wording is constrained; stated explicitly above |
| Narrowing Gap 2 breaks an unknown consumer | Enumerate all 18 repos before narrowing; verify known consumers after |
| Gap 4 deleted before the App is proven on tag/release paths | Left gated; not executed in this pass |
| Manifest and `docs/ci-secrets.md` disagree | Manifest authoritative for checkable facts; doc points rather than restates |

## Open questions

None. The one unresolved technical question — whether the auditor can read
`security_and_analysis` — is deliberately scheduled as a probe in the plan rather
than guessed at here, and has a defined answer either way.
