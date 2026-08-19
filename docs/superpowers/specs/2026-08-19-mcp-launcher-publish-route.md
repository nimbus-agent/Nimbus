# Deciding the `@nimbus-dev/mcp` publish route

**Status: recommendation, awaiting the repository owner's decision.** This document costs both
branches and ends at a recommendation; it does not decide for the owner and does not implement
either branch. Implementing the chosen branch is a follow-up plan, because the two branches share
almost no steps.

## Why this decision exists

The official MCP Registry is a metaregistry: it lists metadata pointing at a package hosted on a
supported registry (npm, PyPI, NuGet, Cargo, OCI, or an MCPB release asset). Nimbus's MCP launcher,
`@nimbus-dev/mcp`, lives in this monorepo at `packages/mcp-launcher` and has never been published.
That is the single blocker on the registry listing (tracked as "blocked — needs a packaging
decision" in `docs/superpowers/specs/2026-08-19-nimbus-distribution-program-design.md`), and it is
also why `CLAUDE.md` / `GEMINI.md` currently read "**Not yet published to npm**" at the
`packages/mcp-launcher` bullet (line 90 of both files).

There are two structurally different ways to get from "unpublished" to "published," and picking
between them is a real decision, not a formality — so it is recorded here before anything is
built.

## Step 1 — verified state (2026-08-19)

Every fact below was re-run in this worktree rather than assumed:

- `npm view @nimbus-dev/mcp version` → `E404 Not Found — GET
  https://registry.npmjs.org/@nimbus-dev%2fmcp — Not found`. The package has never been published.
- `npm view @nimbus-dev/sdk version` → `1.18.0`. `npm view @nimbus-dev/client version` → `0.17.3`.
  Both resolve to real, live versions.
- `scripts/release/credential-registry.ts` records `NPM_TOKEN` with `state: "forbidden"`,
  `location: { scope: "repo", repo: "Nimbus" }`, and the note: *"Revoked 2026-07-19. Publishing is
  OIDC-only; both packages are set to mfa=publish, so a token cannot publish. If this reappears,
  someone has reintroduced a bypass."*
- `.github/workflows/secret-health.yml` does not inject `NPM_TOKEN` (line 153: "`NPM_TOKEN` is
  deliberately NOT injected...").
- `grep -rn "npm publish|npm-publish|trusted publish" .github/workflows/` returns **zero** matches.
  There is no `npm publish` step anywhere in this monorepo's workflows.
- `npm whoami` and `npm org ls nimbus-dev` on the author's machine both fail `E401` in under a
  second — there is no local npm authentication at all, and neither command hangs or opens a
  browser. This is confirmatory, not new information: whichever branch is chosen, publishing has to
  happen from CI under OIDC, not from a developer machine.

`docs/ci-secrets.md` ("## npm packages") independently confirms and dates the working precedent:
`@nimbus-dev/sdk` and `@nimbus-dev/client` were both extracted to their own repos
([nimbus-agent/nimbus-sdk](https://github.com/nimbus-agent/nimbus-sdk),
[nimbus-agent/nimbus-client](https://github.com/nimbus-agent/nimbus-client)) and "each publishes to
npm via release-please + an OIDC trusted publisher — no `NPM_TOKEN` involved, here or there."
Publishing access on both packages is set to require two-factor authentication and disallow
tokens, so CI's only path to publish is OIDC and a leaked token cannot publish either. The gate
shipped in both satellite repos on 2026-07-20
([nimbus-sdk#12](https://github.com/nimbus-agent/nimbus-sdk/pull/12),
[nimbus-client#5](https://github.com/nimbus-agent/nimbus-client/pull/5)): a pre-publish preflight
asserts OIDC is available and npm meets the 11.5.1 floor, and two post-publish steps fail the
release if the registry signature doesn't verify or provenance is missing/wrong. Per that same
doc, neither gate had executed against a real publish yet as of 2026-07-20 — the next release of
either package is the first live exercise, so "proven twice" means the pattern and its guardrails
exist and are configured, not that the failure path has been observed in production.

That is real, repo-documented precedent — not something this document has to invent. The exact
npm trusted-publisher setup screens (which fields the npm web UI asks for, in what order) are not
verified here and are called out below as an implementation-time gap rather than guessed at.

## Step 2 — the two branches, costed

### Branch A — publish from the monorepo via OIDC trusted publishing

Add a publish workflow to this repo and configure npm trusted publishing for `@nimbus-dev/mcp` as
a third package, publishing `packages/mcp-launcher` in place.

**Cost:**

- A new publish workflow in a repo that has never published to npm — there is no existing
  `npm-publish`-shaped job to copy from within this monorepo (confirmed: zero `npm publish` steps
  in `.github/workflows/`). The nearest models are the sdk/client workflows, which live in
  different repos with different `on:` triggers (their own release-please, not this monorepo's).
- A trusted-publisher configuration for a third package, on top of the two that already exist.
- Whatever OIDC (`id-token: write`) permission scoping and pre/post-publish preflight the sdk/client
  gate established would need to be re-derived for a workflow that lives beside the release-signing
  surface, not copied wholesale, since the workflow file itself isn't visible from this repo.

**Benefit:**

- The launcher stays beside the gateway code it launches — `packages/mcp-launcher/src/index.ts` /
  `resolve-binary.ts` / `exit-status.ts` are the entire source surface, and they already ship as a
  workspace member (see Step 1 of the wiring check below).
- The launcher stays close enough to the gateway to make future refactors touching both easier, at
  the cost of a real gap: `.release-please-manifest.json` contains only a `"."` entry, and
  `release-please-config.json`'s `node-workspace` plugin syncs versions across workspace packages
  it is *told* to release — it does not, on its own, make an unlisted package a release-please
  component. `packages/mcp-launcher/package.json` sits at `0.1.0` today with no component entry, so
  Branch A would require explicit release-please configuration for this package (an added entry in
  both files) before its version tracked anything at all. As things stand, the launcher's version
  is not aligned with `GATEWAY_VERSION` and does not move when the gateway releases.

**Risk:**

- Adds an outbound publish path to the repo that holds the release signing surface
  (`docs/release/signing-keys.md`). Every other npm publish in this org happens from a satellite
  repo specifically so that this repo does not need one; Branch A reverses that separation for one
  package.

### Branch B — move `packages/mcp-launcher` to its own satellite repo

Extract `packages/mcp-launcher` to a new repo (e.g. `nimbus-agent/nimbus-mcp`) and give it its own
release-please + OIDC trusted-publisher setup, matching sdk and client.

**Cost — repo split:**

A new repo, its own CI setup (checkout/build/test/publish workflow, branch ruleset, release-please
config), and registration in the org's drift-sweep tooling. Concretely, in this repo:

- `.github/workflows/org-drift-sweep.yml` enumerates repos explicitly by name in **four** separate
  places, each of which would need the new repo name added:
  1. The `sha-pins` job's `matrix.repo` list (lines 27–36; currently 9 entries — this job clones each
     public repo to audit its Action pins).
  2. The `ruleset-drift` job's App-token `repositories:` CSV (line 78; currently 6 entries).
  3. The `cla-coverage` job's App-token `repositories:` CSV (line 165; currently 7 entries).
  4. The `review-coverage` job's App-token `repositories:` CSV (line 197; currently 6 entries).
- `.github/rulesets/general-branch.json` also enumerates repos explicitly, independent of the
  workflow file — the brief's check was right to ask about it separately:
  - The `bypass.by_repo` object (an entry per repo, e.g. `"nimbus-sdk": []`).
  - The top-level `repos` array that `audit:ruleset-drift` diffs each entry against.

  So a full satellite split touches **six** enumeration sites across two files, not the "several
  places" the brief estimated loosely — four in the workflow, two in the ruleset.
- A CLA-coverage and review-coverage entry (`.coderabbit.yaml`, CLA workflow) the new repo would
  need, mirroring what `nimbus-sdk`/`nimbus-client`/`nimbus-vscode` already carry — visible as the
  same repos already appearing in the `cla-coverage` and `review-coverage` CSVs above.

**Cost — breaks something that works today.** This is beyond what the brief named, and is worth
weighing on its own: `packages/mcp-launcher/src/resolve-binary.test.ts` deliberately reads
`scripts/install/lib/paths.ts` **as text** (via a relative path,
`resolve(import.meta.dir, "../../../scripts/install/lib/paths.ts")`) rather than importing it, with
the comment explaining why: *"this package is MIT and cannot import from \[the AGPL installer\],
and `scripts/` is not a dependency of it either... A text read creates neither a package dependency
nor a licence problem."* The test exists to keep the launcher's list of known install directories
in sync with what the installer actually writes to. That relative path only resolves inside this
monorepo — moving `packages/mcp-launcher` to a satellite repo severs it, and the drift check would
need a replacement (vendoring a copy of the relevant literals, or dropping the check and accepting
silent drift risk between the installer and the launcher's fallback paths).

**Cost — workspace membership.** `packages/mcp-launcher` is a first-class entry in the root
`package.json` `workspaces` array (`packages/mcp-launcher`, alongside gateway/cli/ui) and in the
root `test` script (`"test": "bun test packages/gateway packages/cli packages/mcp-connectors
packages/mcp-launcher scripts"`). Extracting it means removing it from both, and its tests
(`exit-status.test.ts`, `resolve-binary.test.ts`) stop running under the monorepo's `bun test` /
`preflight` / coverage-floor gates and need their own CI in the new repo instead. Checked for
actual source coupling beyond workspace membership — there is none: `packages/mcp-launcher/src`
has no import of anything under `packages/gateway`, and its own `package.json` declares no
dependency on any `@nimbus-dev/*` package. It is already, in every way except location, treated
like an independent MIT package sitting inside an AGPL monorepo — which is exactly what Branch B
would make official.

**Benefit:**

- Matches the pattern already proven twice in this org: sdk and client both publish this way and
  both are live, with a documented, repo-verified OIDC trusted-publisher + `mfa=publish` +
  provenance-verification setup (`docs/ci-secrets.md`, above).
- No new publish surface is added to the repo holding the release signing keys.

**Risk:**

- The launcher's version can drift from the gateway version it launches, since it would no longer
  share release-please's single version bump with the rest of the monorepo. (In practice this is a
  soft risk: the launcher only resolves and execs a local `nimbus` binary — see
  `packages/mcp-launcher/src/resolve-binary.ts` — it does not embed gateway logic, so a
  version-number mismatch is a labeling nuisance, not a correctness bug, the same way `sdk` and
  `client` already version independently of the gateway today.)

## Step 3 — recommendation

**Recommend Branch B: extract `packages/mcp-launcher` to its own satellite repo.**

Reasoning:

1. **It is the only branch with working, verified precedent in this org.** `docs/ci-secrets.md`
   documents that sdk and client both publish via OIDC trusted publishing with `mfa=publish` and
   provenance verification, gated 2026-07-20. Branch A would be this repo's first-ever npm publish
   path, built from scratch, with no in-repo workflow to model it on (zero `npm publish` steps
   exist here today). Copying a proven pattern is materially lower-risk than inventing a new one in
   the repo that also holds release signing.
2. **The `NPM_TOKEN` note is explicit about *why* the org chose OIDC-only, and Branch A would be
   the first time that OIDC publish surface touches this specific repo.** The credential-registry
   note treats a reappeared `NPM_TOKEN` in *this* repo as a detected bypass. Branch A doesn't
   reintroduce `NPM_TOKEN`, but it does add the first OIDC-publish workflow to the repo the note is
   guarding — a strictly larger blast radius than adding a fourth satellite repo whose only
   capability is "publish this one package."
3. **The code was already living as if it were independent.** The `resolve-binary.test.ts` comment
   is explicit that the launcher is MIT specifically *because* it must not depend on the AGPL
   installer, and goes out of its way to avoid a real import dependency even while co-located. That
   is a package already engineered for extraction; Branch B mostly formalizes a boundary that
   already exists, rather than fighting one.
4. **The stated benefit of Branch A — staying beside the gateway and inheriting release-please's
   version bump — is weaker than it looks.** The launcher's own `package.json` puts it at `0.1.0`
   today, not tracking `GATEWAY_VERSION`; nothing currently keeps its version numerically aligned
   with the gateway even while co-located. sdk and client already demonstrate that an independently
   versioned, separately-released MIT package works fine as a stable dependency surface for this
   product, and a plain semver bump for a thin binary-resolver is easy to keep sane by hand.
5. **The extraction cost is bounded and enumerable**, not open-ended: six named enumeration sites
   (four in `org-drift-sweep.yml`, two in `general-branch.json`), a `workspaces`/`test`-script
   edit, and a resolve-binary drift-check replacement. All are small, mechanical follow-up work,
   unlike Branch A's "design a new publish workflow from nothing in a repo that has never done
   this."

The genuine counterweight — Branch A keeps the launcher's source next to the gateway it launches,
easing future refactors that touch both — is real but outweighed here, because the launcher's
actual coupling to the gateway is already almost zero (it execs a binary by path; it doesn't import
gateway code), so there is little cross-repo refactor pain to avoid in the first place.

**What is not decided here and must be confirmed at implementation time, not guessed:** the exact
npm web UI steps for registering a new trusted publisher (which fields it asks for, in what order),
and the precise shape of the new repo's release workflow beyond "mirror nimbus-sdk/nimbus-client's
OIDC + `mfa=publish` + provenance-verification pattern." Both are implementation details for the
follow-up plan, not decision inputs — getting them wrong here would be a confidently wrong
instruction, which is worse than leaving the gap acknowledged.

## Consequence for `CLAUDE.md` / `GEMINI.md`

Both files currently read, at the `packages/mcp-launcher` bullet (line 90 in each):

> `packages/mcp-launcher` — the `@nimbus-dev/mcp` npm launcher (`nimbus-mcp` bin) that resolves and
> execs the local gateway MCP server. **Not yet published to npm** — publishing it is what unblocks
> the official MCP Registry listing (see
> `docs/superpowers/specs/2026-08-19-nimbus-distribution-program-design.md`).

Once Branch B ships (the new satellite repo publishes `@nimbus-dev/mcp` for the first time), that
wording is reversed in both files:

- The bullet under "Subsystems (monorepo)" changes from describing `packages/mcp-launcher` as the
  live source of the npm package to describing it the way `nimbus-sdk`/`nimbus-client` are
  described today — a satellite repo entry under "Several surfaces live in their own standalone
  repos and release independently of the Gateway," pointing at
  `github.com/nimbus-agent/nimbus-mcp` (or whatever name the extraction plan settles on) and
  noting it publishes `@nimbus-dev/mcp` to npm.
- `packages/mcp-launcher` itself is removed as a listed subsystem once extracted, and the "Not yet
  published to npm" clause is deleted rather than flipped to "published," matching how the sdk/client
  bullets read today (they state where the package is published and to which repo, with no
  "published/unpublished" framing at all).

This reversal is explicitly out of scope for this document and belongs to the follow-up
implementation plan, but recording it here means that plan does not have to re-derive it.
