# Satellite npm publish precedent — the record for `@nimbus-dev/mcp`

**Status: verified record, 2026-08-20.** Every fact below was re-read from the live
repositories, the live npm registry, or the live MCP Registry docs rather than recalled.
This closes the two gaps
[`2026-08-19-mcp-launcher-publish-route.md`](./2026-08-19-mcp-launcher-publish-route.md)
explicitly refused to guess: the shape of the satellite release workflow, and the
registration steps around it.

It exists to be executed against by
[`../plans/2026-08-20-mcp-launcher-satellite-extraction.md`](../plans/2026-08-20-mcp-launcher-satellite-extraction.md)
Tasks 3–5.

---

## 1. Prerequisite gates — both PASS

| Gate | Command | Result |
| --- | --- | --- |
| A — operator holds npm org owner | `npm org ls nimbus-dev` | `asafgolombek - owner` ✅ |
| B — package name unclaimed | `npm view @nimbus-dev/mcp version` | `E404 Not Found` ✅ |

`npm whoami` → `asafgolombek`. Owner rights mean the trusted-publisher registration and
the publishing-access setting are both available to the operator directly; no hand-off
is required.

---

## 2. Which repo is the template — `nimbus-client`, not `nimbus-sdk`

The publish-route spec named `nimbus-sdk` as the precedent. On inspection, **`nimbus-client`
is the correct template** and `nimbus-sdk` is the wrong one:

| Repo | `release.yml` | Why |
| --- | --- | --- |
| `nimbus-sdk` | **680 lines** | Publishes multiple language SDKs from `sdks/*` — Go included (`release-go.yml` is a second workflow). Its complexity is entirely about multi-language fan-out. |
| `nimbus-client` | **201 lines** | One npm package at the repo root, OIDC trusted publishing, provenance verification. Exactly `nimbus-mcp`'s shape. |

Copy from `nimbus-client`. This is a correction to the plan, which said "adapted from
nimbus-sdk's workflow".

Workflow inventory — `nimbus-sdk`: `ci.yml`, `cla.yml`, `codeql.yml`, `release-go.yml`,
`release.yml`, `sonar.yml`. `nimbus-client`: the same minus `release-go.yml`.

---

## 3. `nimbus-client/.github/workflows/release.yml` — the structure to copy

Two jobs. **Copy the structure and every pinned SHA verbatim**; change only the four
identifiers called out in §4.

### Job 1 — `release-please`

- Triggers: `push` to `main`, plus `workflow_dispatch`.
- `concurrency: release-${{ github.ref }}`, `cancel-in-progress: false`.
- Top-level `permissions: contents: read`; the job widens to `contents: write` +
  `pull-requests: write`.
- **Mints a GitHub App token rather than using `GITHUB_TOKEN`.** The in-file comment
  states why, and it is a live constraint, not a preference: *"The org blocks
  `GITHUB_TOKEN` from creating pull requests"*. It replaced `RELEASE_PLEASE_PAT`, which
  failed with `Resource not accessible by personal access token`.
  - `actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1` (v3.2.0)
  - `client-id: ${{ secrets.RELEASE_BOT_CLIENT_ID }}`,
    `private-key: ${{ secrets.RELEASE_BOT_PRIVATE_KEY }}`
  - `owner: nimbus-agent`, `repositories: nimbus-client` ← **change to `nimbus-mcp`**
  - `permission-contents: write`, `permission-pull-requests: write`,
    `permission-issues: write` (the last is future-proofing for creating
    `autorelease:*` label definitions).
- `googleapis/release-please-action@45996ed1f6d02564a971a2fa1b5860e934307cf7` (v5.0.0),
  with `config-file` / `manifest-file` / the App token.
- Outputs `releases_created`.

### Job 2 — `publish`

Gated on `needs.release-please.outputs.releases_created == 'true'`. Permissions:
`contents: read` + **`id-token: write`** (required for OIDC + provenance).

Step order:

1. `step-security/harden-runner@b09bb98e06d4d774595224525879c09bc6e98c40` (v2.20.1),
   `egress-policy: audit` — deliberately audit, not block: *"Publishing reaches npm + the
   sigstore provenance endpoints; audit avoids brittle allowlist drift on the signing chain."*
2. `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1` (v7.0.1),
   `persist-credentials: false`.
3. `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6` (v2), `bun-version: 1.3.14`.
4. `bun install --frozen-lockfile`.
5. `actions/setup-node@820762786026740c76f36085b0efc47a31fe5020` (v7.0.0), Node 22,
   `registry-url: https://registry.npmjs.org`.
6. `npm install -g npm@latest` — *"npm trusted publishing (token-less OIDC) requires
   npm >= 11.5.1, newer than the version bundled with Node 22."*
7. `bun run build`, `bun run typecheck`, `bun test` (with `CI: "true"`).
8. **Pre-publish preflight** (the `nimbus-client#5` gate) — fails the job when
   `ACTIONS_ID_TOKEN_REQUEST_TOKEN` is unset or `npm --version` is below `11.5.1`.
   Rationale in-file: *"npm cannot unpublish after 72h, so a post-publish failure reports
   damage rather than preventing it."* Note the portability caveat it carries: `sort -V`
   is GNU coreutils, guaranteed on `ubuntu-24.04` only.
9. `npm publish --provenance --access public` — **no `NODE_AUTH_TOKEN`**. The comment is
   explicit that the trusted-publisher binding authenticates the workflow via OIDC.
10. Resolve the published version into a step output.
11. **Signature verification against the registry**, in a clean `mktemp -d` tree —
    `npm audit signatures` audits the tree it runs in, so it must install the published
    package first. Retries **install and audit together, 8 attempts with linear backoff
    (~4.5 min), using `--prefer-online`.** Two real incidents are recorded in the comment
    and both are worth preserving: packument lag turned `0.6.1` red (`ETARGET`, five
    attempts inside ~50 s, package fine minutes later) and attestation lag turned `0.6.0`
    red. `--prefer-online` is required because npm caches the negative packument.
12. `nimbus-agent/.github/actions/verify-npm-provenance@5fb42792fa88287048fd24f704183b9a9b807a67`
    with `severity: gate`, asserting the provenance names the expected repo, workflow and
    commit SHA.

The PR that added steps 8, 11 and 12 is `nimbus-client#5`, titled
**"ci: gate releases on npm provenance"** (the sibling of `nimbus-sdk#12`).

---

## 4. What to change for `nimbus-mcp` — exactly four identifiers

1. `repositories: nimbus-client` → `nimbus-mcp` (App-token step).
2. `@nimbus-dev/client` → `@nimbus-dev/mcp` (the install line in the signature-verify
   step, its error message, and the `package:` input of the provenance action).
3. `expected-repo: nimbus-agent/nimbus-client` → `nimbus-agent/nimbus-mcp`.
4. Nothing else. `expected-workflow: .github/workflows/release.yml` stays, as does every
   pinned SHA.

Do **not** re-derive the preflight or the two verification steps.

---

## 5. release-please configuration — and the tag prefix, which is NOT `v*`

`nimbus-client/release-please-config.json`:

```json
{
  "$schema": "https://raw.githubusercontent.com/googleapis/release-please/main/schemas/config.json",
  "bootstrap-sha": "7cdb6e22ec806c0e204638f06ad7aab36bd975b7",
  "bump-minor-pre-major": true,
  "packages": { ".": { "release-type": "node", "package-name": "@nimbus-dev/client" } }
}
```

`.release-please-manifest.json`: `{ ".": "0.17.3" }`.

**The correction that matters.** The extraction plan assumed release-please would tag
`vX.Y.Z` for a single-component repo. It does not. Observed live tags:

| Repo | Tags |
| --- | --- |
| `nimbus-client` | `client-v0.17.3`, `client-v0.17.2`, `client-v0.17.1`, … |
| `nimbus-sdk` | `typescript-v1.19.0`, `typescript-v1.18.0`, … |

Neither config sets `component` or `include-component-in-tag` explicitly — the manifest
strategy defaults to including the component, and the component defaults to the last
segment of the package name (`@nimbus-dev/client` → `client`; the sdk's TypeScript
package lives under `sdks/typescript` → `typescript`).

**So `@nimbus-dev/mcp` will tag `mcp-vX.Y.Z`**, and the `Protected release tags` ruleset
must use `refs/tags/mcp-v*`. A ruleset on `refs/tags/v*` would protect nothing and the
real tags would be mutable — a silent failure, since nothing reports an unmatched
ruleset. Verify against `gh api repos/nimbus-agent/nimbus-mcp/tags` after the first
release regardless.

`bootstrap-sha` pins where release-please starts reading history; set it to the seed
commit of the new repo so it does not attempt to walk a history that does not exist.

---

## 6. Repo settings to reproduce

`nimbus-client`:

```json
{"allow_squash_merge": true, "allow_merge_commit": false,
 "allow_rebase_merge": false, "delete_branch_on_merge": true,
 "has_issues": true, "has_wiki": false}
```

---

## 7. Secrets — org-level, `SELECTED` visibility

**No satellite carries repo-level secrets.** `gh secret list --repo` returns empty for
both `nimbus-client` and `nimbus-sdk`. Everything comes from the org, and four of the
five entries are `SELECTED` visibility with an explicit repo list:

| Secret | Visibility | Granted to |
| --- | --- | --- |
| `SONAR_TOKEN` | SELECTED (7) | awesome-nimbus, create-nimbus-connector, Nimbus, nimbus-client, nimbus-sdk, nimbus-vscode, nimbus-web-clipper |
| `CLA_BOT_CLIENT_ID` | SELECTED (7) | same seven |
| `CLA_BOT_PRIVATE_KEY` | SELECTED (7) | same seven |
| `RELEASE_BOT_PRIVATE_KEY` | SELECTED (5) | create-nimbus-connector, Nimbus, nimbus-client, nimbus-sdk, nimbus-vscode |
| `RELEASE_BOT_CLIENT_ID` | **ALL** | every repo |

`nimbus-mcp` must be added to the four `SELECTED` lists. Consequences of missing each are
in the plan (Task 2b Step 10b); the sharp ones are that `cla` is a **required check**, so
two of the four block every PR, and `RELEASE_BOT_PRIVATE_KEY` blocks the release itself.

**No `NPM_TOKEN` appears anywhere in the precedent** — grep over every file fetched here
returns nothing, consistent with `scripts/release/credential-registry.ts` recording it as
`forbidden`.

---

## 8. MCP Registry submission — `server.json`, and an ordering trap

Read live from `modelcontextprotocol/registry` (`README.md`, `docs/modelcontextprotocol-io/quickstart.mdx`).
The registry is **in preview**; breaking changes and data resets are possible.

**Submission is via the `mcp-publisher` CLI, not a pull request.** Commands: `init`,
`login`, `publish`, `status`, `validate`. Install via a released binary or
`brew install mcp-publisher`.

`server.json` is generated by `mcp-publisher init` and looks like:

```json
{
  "$schema": "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  "name": "io.github.nimbus-agent/nimbus",
  "description": "...",
  "repository": { "url": "https://github.com/nimbus-agent/nimbus-mcp", "source": "github" },
  "version": "0.1.1",
  "packages": [
    { "registryType": "npm", "identifier": "@nimbus-dev/mcp", "version": "0.1.1",
      "transport": { "type": "stdio" } }
  ]
}
```

### The ordering trap — `mcpName` must be in `package.json` BEFORE the npm publish

Ownership verification for an npm package is a **`mcpName` property in `package.json`**,
and the registry checks it against the *published tarball*. Adding it after the fact means
publishing another npm version purely to carry it.

So `mcpName` belongs in Task 2b (alongside `publishConfig`), **not** Task 5. The plan's
conditional — "if the manifest is version-independent, seed it early" — resolves as:

- `server.json` itself **is** version-dependent (`version` and `packages[].version` name a
  published version) → it stays in Task 5, after the first publish.
- `mcpName` in `package.json` is **not** → it must land before the publish, in Task 2b.

### Namespace

With GitHub authentication the name must start with `io.github.<owner>/`. For an
org-owned repo that is `io.github.nimbus-agent/`, and it is satisfied either by logging in
as a member of `nimbus-agent` or *"be in a GitHub Action on"* the org's repos — so a
future automated publish from the `nimbus-mcp` repo qualifies via GitHub OIDC.

DNS verification against `nimbus-agent.dev` is an alternative (it would allow a
`dev.nimbus-agent/...` name) but is more work for no gain here.

---

## 9. Open items this record does NOT close

- **The npm trusted-publisher web UI field order.** Still not verified — it has no API
  equivalent. Record it while performing Task 4 Step 3 so the next package does not have
  to rediscover it.
- **Whether the org's SonarCloud project for `nimbus-mcp` exists.** The operator has
  confirmed it will; the import step remains manual.
- **The exact `mcpName` value.** `io.github.nimbus-agent/nimbus` is the natural choice but
  it is a public identity decision, not a mechanical one — confirm before publishing,
  because it is baked into a published tarball.
