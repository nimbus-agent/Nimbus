# Nimbus CLA

Contributions to Nimbus's public repos require a signed CLA — a one-time,
sign-by-comment step enforced by a required status check.

## Signing

On your first pull request the CLA bot comments asking you to sign. Reply with
exactly:

> I have read the CLA Document and I hereby sign the CLA

Your signature is recorded once and covers **all** Nimbus public repos.
Contributing on behalf of an employer? Your employer signs the
[Corporate CLA](./CCLA.md) and lists you in its Schedule A.

- [Individual CLA](./ICLA.md) · [Corporate CLA](./CCLA.md)

## Why a CLA (not a DCO)

The CLA grants a broad, relicensable license so the AGPL-3.0 core can be offered
under more than one license in future. See `docs/CONTRIBUTING.md` for the
MIT → AGPL one-way rule.

## Version-bump SOP (maintainers)

The CLA text version lives in `path-to-signatures` (`signatures/version1/...`).
To bump it (materially changed text → re-require signatures):

1. Update the CLA doc(s) in `.github/CLA/`.
2. In **one** coordinated change, bump `version1` → `version2` in the `cla.yml`
   of **all 7** gated repos.
3. `audit:cla-coverage` asserts the version matches across all 7 — a partial bump
   goes red.

Never bump one repo at a time: a contributor would be blocked on a bumped repo
while allowed on a not-yet-bumped one.
