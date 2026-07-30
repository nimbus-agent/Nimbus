# P6 — Bypass-actor audit design

**Date:** 2026-07-30
**Sub-program:** P6 (Access & Contribution Model), the last remaining item
**Design of record:** `superpowers/specs/2026-07-23-org-infrastructure-program-design.md`
**Roadmap:** [`docs/infrastructure-roadmap.md`](../../infrastructure-roadmap.md)

---

## Problem

`audit:ruleset-drift` deliberately does **not** diff `bypass_actors`. The reason is
recorded in the P1 progress log: the sweep's CI credential is a repo-scoped App
installation token with `Administration: read`, and GitHub returns an **empty**
`bypass_actors` array to it for org-level actors such as `OrganizationAdmin`. It
was proven live that adding `organization-administration: read` does not restore
the field, and reading it otherwise requires `Administration: write` — which a
read-only audit gate must not hold. Diffing the field from the sweep therefore
false-failed on every repo carrying an org-level bypass, and the field was
dropped from the diff.

The consequence is a real gap. A bypass actor is the single most powerful
override in a ruleset: it exempts a principal from every rule the ruleset
enforces, including the `pull_request` rule that is the whole point of the
`General` ruleset. Nothing currently detects one being added, widened, or
retargeted.

The intended shape has been recorded in prose since P1 — `OrganizationAdmin` on
`Nimbus`/`nimbus-vscode`/`nimbus-web-clipper`, none on
`nimbus-client`/`nimbus-sdk` — inside a JSON `$comment` **string**. Prose in a
comment is not a gate.

## Verified premises

Both checked before designing, rather than taken from the existing prose:

1. **An owner-context `gh` token does return `bypass_actors`.** The local token
   (scopes `admin:org`, `repo`) reads the field successfully on all five active
   repos. The P1 limitation is specific to the App installation token, not to
   `gh` generally.
2. **Live state currently matches the declared intent exactly:**

   | repo | live `bypass_actors` | declared intent |
   | --- | --- | --- |
   | `Nimbus` | `OrganizationAdmin` / `always` | `OrganizationAdmin` |
   | `nimbus-vscode` | `OrganizationAdmin` / `always` | `OrganizationAdmin` |
   | `nimbus-web-clipper` | `OrganizationAdmin` / `always` | `OrganizationAdmin` |
   | `nimbus-client` | `[]` | none |
   | `nimbus-sdk` | `[]` | none |

   `bypass_mode: always` matches the `solo` side of the existing
   `$contributor_two` switch.

Premise 2 means the gate **ships green by construction**. Per the precedent set
by `audit:ci-latency`, the red-proof is therefore a unit test, not the first live
run — with one exception noted under *Red-prove* below.

## Rejected approaches

| Approach | Why rejected |
| --- | --- |
| Grant the sweep App `Administration: write` | Fully automated, but costs the read-only property the roadmap explicitly committed to. An audit credential that can rewrite every ruleset in the org is a worse trade than a slower cadence. |
| A second narrow App with `Administration: write` | Isolates blast radius from the release bot, but still stores an org secret that can rewrite rulesets, and adds a credential to rotate and track in `credential-registry.ts`. |
| Owner-run CLI only, no gate | Simplest, but by this program's own operating principle it is not done. A control nobody is reminded to run is precisely the "controls stop where they were written" pattern the program exists to break. |

## Chosen approach: owner-run audit + attestation-freshness gate

Two gates share **one pure diff function**. The owner-run gate feeds it live data
from `gh`; the sweep gate feeds it the attested snapshot. No network in the
sweep, no duplicated comparison logic.

```text
        diffBypassActors(declared, observed) → { ok, errors }
                 ▲                                   ▲
                 │ live, via gh (admin:org)          │ attested snapshot (offline)
        audit:bypass-actors                   audit:bypass-attestation
        [owner-run, --attest]                 [sweep job, no credential mint]
```

The gated property is not "the org is clean" — it is **"a green attestation was
committed recently, and it still agrees with declared intent."** That is a
property a machine can check with no privileged credential.

### Gate 1 — `audit:bypass-actors` (owner-run)

`scripts/structure-audit/check-bypass-actors.ts`

Reads declared intent from `.github/rulesets/general-branch.json`, resolves each
repo's `General` ruleset id, fetches the ruleset, and diffs `bypass_actors`.

Mirrors `check-ruleset-drift.ts` throughout — same file, same helpers, same
control flow:

- `runGh`, `isRecord`, `isStrict`, `strictSkip` from `_gh-audit.ts`
- `classifyReadFailure` so a 5xx/403 degrades to `indeterminate` and is never
  recorded as a finding (the 2026-07-27 operating rule)
- the `decideExit` invariant: **drift found on a reachable repo is never
  discarded because a different repo's read failed**; `queried === 0` is the only
  skip-green case
- fail-soft when `gh` is absent or unauthenticated, so an external contributor is
  never blocked

**Normalization.** Live returns
`{"actor_id": null, "actor_type": "OrganizationAdmin", "bypass_mode": "always"}`.
Declared entries omit `actor_id`. Comparison is therefore an order-independent
set of `${actor_type}:${actor_id ?? "null"}:${bypass_mode}` triples. Set
comparison, not array equality — actor order is not meaningful.

**Findings are directional**, because the repairs differ:

- `unexpected bypass actor: <triple>` — someone added an override
- `missing declared bypass actor: <triple>` — an intended override was removed
- `bypass_mode: expected <x>, got <y>` — an override was widened or narrowed
- `<repo>: not declared in bypass.by_repo` — config gap, see check 3 below

**`--attest`** writes `docs/structure-audit/bypass-actors-attestation.json`
**only when the diff is green.** A fresh attestation can therefore never encode a
known-bad state. On a red diff it exits 1 and writes nothing.

### Gate 2 — `audit:bypass-attestation` (sweep)

`scripts/structure-audit/check-bypass-attestation.ts`

Four checks, all offline — no `gh`, no token mint, no network:

1. **exists and parses.** `absent` and `unparseable` are distinct verdicts,
   because the repair differs (the `review-coverage` lesson). A YAML/JSON
   document that parses to a scalar or array is `unparseable`.
2. **`attested_at` is within the grace window.** Grace is read from
   `bypass.attestation_grace_days` in `general-branch.json` — currently **90
   days**, to be flipped to **30** at contributor-two via the documented switch.
   Rationale: in solo mode the repo owner is the only org
   admin, so the audit is near-self-checking; its real value begins when a second
   maintainer gains write access — exactly when the other three switches flip.
   Encoding the window as a fourth switch keeps that reasoning in one place and
   makes tightening it part of the same reviewed diff.
3. **the attested `repos` set equals the declared `repos` set.** Load-bearing:
   adding a sixth repo to `general-branch.json` must invalidate an attestation
   that never covered it. Without this check a newly-added repo would be silently
   unaudited behind a green gate — this program's founding failure mode.
4. **the attested `observed` block still diffs clean against current declared
   intent**, by re-running `diffBypassActors` offline. So editing
   `general-branch.json` without re-attesting is caught, rather than sitting
   green until the grace window expires.

Check 4 is why the attestation stores observations rather than only a timestamp.

**Placement: the sweep only, not the `preflight:fast` tier.** Gate 2 is local and
deterministic, so it *could* run on every PR like `audit:secret-inventory`. It
must not. Its red depends on the repo owner's re-attestation cadence, so a stale
attestation would block an external contributor's unrelated PR — punishing the
wrong person, and manufacturing exactly the always-red gate the 2026-07-27
operating rule warns about.

### Attestation file shape

`docs/structure-audit/bypass-actors-attestation.json` — committed, sits beside
`ci-latency-baseline.json`.

```json
{
  "attested_at": "2026-07-30T06:15:00.000Z",
  "attested_by": "asafgolombek",
  "grace_days": 90,
  "repos": ["Nimbus", "nimbus-client", "nimbus-sdk", "nimbus-vscode", "nimbus-web-clipper"],
  "observed": {
    "Nimbus": [{ "actor_type": "OrganizationAdmin", "actor_id": null, "bypass_mode": "always" }],
    "nimbus-vscode": [{ "actor_type": "OrganizationAdmin", "actor_id": null, "bypass_mode": "always" }],
    "nimbus-web-clipper": [{ "actor_type": "OrganizationAdmin", "actor_id": null, "bypass_mode": "always" }],
    "nimbus-client": [],
    "nimbus-sdk": []
  }
}
```

`attested_by` comes from `gh api user --jq .login`, so the commit records who
attested as well as when. `grace_days` is denormalized into the file for
diagnostics only; **check 2 reads
`bypass.attestation_grace_days` from `general-branch.json`, never this field**,
so a hand-edited `grace_days` cannot widen the window.

### Config changes — `.github/rulesets/general-branch.json`

A new top-level `bypass` block. This is the file's **first per-repo override**,
because intent genuinely differs per repo:

```json
"bypass": {
  "attestation_grace_days": 90,
  "by_repo": {
    "Nimbus":             [{ "actor_type": "OrganizationAdmin", "bypass_mode": "always" }],
    "nimbus-vscode":      [{ "actor_type": "OrganizationAdmin", "bypass_mode": "always" }],
    "nimbus-web-clipper": [{ "actor_type": "OrganizationAdmin", "bypass_mode": "always" }],
    "nimbus-client":      [],
    "nimbus-sdk":         []
  }
}
```

Chosen over converting `repos: string[]` to a map, which would churn
`DesiredRulesetFile`, `loadDesiredFile` and the existing `ruleset-drift` tests
for no gain.

**`attestation_grace_days` holds the CURRENT value, following the file's existing
convention** — exactly as `shared.pull_request.required_approving_review_count`
is `0` (the live solo value) while `$contributor_two` documents the flip to `1`.
There is no separate "which mode am I in" marker in this file, and adding one
would create a second source of truth for the same fact. `$contributor_two.switches`
therefore gains a documentation entry only:

```json
"bypass.attestation_grace_days": { "solo": 90, "team": 30 }
```

A unit test asserts `Object.keys(bypass.by_repo)` equals the `repos` set, so
declaring a repo without its bypass intent fails locally rather than at sweep
time.

### Stale assertions this must correct

Four places currently state that bypass actors are not audited. Leaving any is
the doc-drift the triple rule exists to prevent:

| location | current text |
| --- | --- |
| `general-branch.json` `$comment` | "NOT diffed … Intended bypass, for the future higher-privilege check" |
| `general-branch.json` `$contributor_two.note` | "the bypass switch is not [drift-gated]" |
| `check-ruleset-drift.ts` (the block at ~L115–123) | "a follow-up requiring a higher-privilege context" |
| `DesiredRulesetFile` docstring | "There are no per-repo overrides" |

`audit:ruleset-drift` itself keeps **not** diffing bypass actors — its credential
still cannot read them. Its comment changes from describing a follow-up to
pointing at `audit:bypass-actors` as the gate that now covers the field.

## What this does not prove

The attestation is a committed file, so it can be hand-edited. Gate 2 proves *a
green attestation was committed recently and still agrees with declared intent* —
not *the org is clean right now*. The real control is that the file is
PR-visible and diff-reviewed: a forged or backdated attestation shows up as a
reviewable diff.

Signing the attestation was considered and rejected as theatre: the only
plausible signer is the same person who could forge it.

This limit is stated here deliberately. By this program's own standard — *"a gate
that checks a control's presence cannot see that the control is structurally
unable to execute"* — naming the limit is the difference between a real gate and
a comforting one. The residual risk is bounded by the grace window: up to 90 days
in solo mode, 30 once a second maintainer has write access.

## Testing

**Pure diff (`diffBypassActors`)** — exact match; extra/unexpected actor; missing
declared actor; correct actor with wrong `bypass_mode`; repo absent from
`bypass.by_repo`; `actor_id` normalization (`null` vs omitted); order-independence
of the actor set.

**Gate 2 (`evaluateAttestation`)** — fresh; stale by one day past grace; missing
file; unparseable; parses to a scalar/array; `repos` set mismatch in both
directions; `observed` drifting from declared; grace read from
`general-branch.json` (a 30-day config makes a 45-day-old attestation stale
where a 90-day config does not); hand-edited `grace_days` in the attestation
ignored in favour of the config value.

**Config** — `keys(bypass.by_repo)` equals `repos`.

### Red-prove

The gate ships green (premise 2), so unit tests are the primary red-proof, as
with `audit:ci-latency`.

One **live** red-prove is available at zero risk and should be run: temporarily
flip a declared `bypass_mode` to `pull_request` in the working tree, run
`audit:bypass-actors` against the real org, confirm exit 1 and the expected
finding, then revert. This exercises the real `gh` read path and the real diff
without mutating any org setting. Per the `review-coverage` precedent, **verify
the mutation actually landed in the file before trusting the result.**

Gate 2's stale path can also be red-proved live by backdating `attested_at`.

## Files

| path | change |
| --- | --- |
| `scripts/structure-audit/check-bypass-actors.ts` | new — Gate 1 CLI + `diffBypassActors` |
| `scripts/structure-audit/check-bypass-actors.test.ts` | new |
| `scripts/structure-audit/check-bypass-attestation.ts` | new — Gate 2 CLI + `evaluateAttestation` |
| `scripts/structure-audit/check-bypass-attestation.test.ts` | new |
| `scripts/structure-audit/_bypass-attestation.ts` | new — attestation shape, read/write |
| `docs/structure-audit/bypass-actors-attestation.json` | new — committed snapshot |
| `.github/rulesets/general-branch.json` | `bypass` block, grace switch, `$comment` + note corrections |
| `scripts/structure-audit/check-ruleset-drift.ts` | comment correction only; no behaviour change |
| `.github/workflows/org-drift-sweep.yml` | new `bypass-attestation` job, no token mint |
| `scripts/lib/preflight-gates.ts` | both names → sweep-exemption list |
| `package.json` | `audit:bypass-actors`, `audit:bypass-attestation` |
| `docs/infrastructure-roadmap.md` | P6 row → done; P6 progress-log entry |

## Definition of done

1. Unit tests green, covering every case above.
2. Live red-prove performed and reverted.
3. `bun run preflight:fast` green.
4. `audit:bypass-actors --attest` run by the owner; attestation committed.
5. `bypass-attestation` job **green in a dispatched `org-drift-sweep`** — this
   program's actual bar, not "the code merged".
6. Roadmap P6 row updated with the run id.
