# nimbus-agent/registry-action

First-party GitHub Action run by a Nimbus extension registry repository (the repository
`nimbus registry maintain init <dir> --github` creates), and by the Nimbus trust feed's repository
(`nimbus trust maintain init <dir> --github`). One action, five modes:

- **`check`** — on a publish pull request: the reviewer aid. Admits the pull request's
  `statements/<statement id>.json` files (publisher-signed `key.rotate` / `key.revoke`) exactly as
  `sign` will, failing on any it would skip, then validates the new `extensions/<id>/<version>/`
  (if any: a statement-only pull request is valid) against the signed index on `gh-pages` with
  those statements admitted, and writes a job summary for the reviewer. With the `nimbus-gateway`
  input, a version whose package holds an eval suite is scored as the `score` mode scores it, and
  the summary reports `quality N/100` or `could not score: <code>`. Scoring runs extension code, so
  `nimbus-gateway` and `github-token` are mutually exclusive in `check` (both set fails the check),
  and with the gateway set the summary leaves provenance to the sign job. A green check is not the
  security boundary.
- **`sign`** — on a push to the default branch, behind the `registry-signing` environment's
  required approval: the content boundary. Admits every `statements/` file it can (skipping and
  naming the rest; a statement once in the index is never removed), re-validates every unsigned
  extension version against the result, moves an extension's entry to its publisher's rotated key
  when a version signed by that key is added, signs the index with the registry root key and
  pushes the site to `gh-pages`. A run that admits only statements still re-signs, so a
  revocation reaches clients. It also signs each maintainer request under `trust-requests/`
  (an unsigned `key.revoke` / `extension.takedown`) with the root key, once per block, and sets the
  index's `reportUrl` to this repository's issue form when it has none. `check` admits a
  request-only pull request under a `MAINTAINER REQUEST` banner. With the `scores` input it reads
  the score job's `scores.json` once, as untrusted input: a version whose package holds an eval
  suite is signed only with an entry under its own `<id>@<version>`, for its own `packageSha256`,
  holding a quality `parseEvalQuality` accepts, and that quality (exactly `scorer`, `score`,
  `cases`, `passed`, `rubrics`) becomes the entry's registry-signed `quality`. A missing, failed,
  mismatched or invalid entry skips that version with a warning naming why (it binds nothing for
  later versions in the run); a version without `evals/` is signed with no `quality`. A
  `scores.json` that is unreadable, over 4 MiB or not a JSON object fails the run. Without the
  input nothing changes.
- **`score`** — on a push to the default branch, in its own job with NO secrets, no environment
  and a read-only token, before `sign`: runs extension code, so never in the job that holds the
  root key. Validates every unsigned extension version exactly as `sign` will and, for each whose
  package holds an eval suite (`evals/<name>.eval.json`), unpacks the package into a directory of
  its own and runs `<nimbus-gateway> __nimbus-eval --package <dir> --json` (the gateway confines
  the extension in the platform sandbox with no network; 12-minute deadline, 8 MiB stdout cap,
  a minimal environment with a private `HOME`). Writes `scores.json`,
  `{ "<id>@<version>": { "packageSha256", "quality" } | { "packageSha256", "error" } }`, always
  (`{}` when there is nothing to score) and atomically. A timeout, an overflow, a non-zero exit,
  output that is not one valid eval document, or a document naming another `<id>@<version>` is an
  `error` entry, never a partial score. The whole run has a 14-minute budget: each role run's
  deadline is 12 minutes or what is left of the budget, whichever is shorter, and once under a
  minute is left every further version with eval suites gets an `ERR_EVAL_BUDGET` entry without
  running (it is scored on a later run), so hanging suites cannot fail the job. That matters
  because `sign` needs this job: a red score job (an infrastructure failure such as the apt
  install or the release download) skips the whole sign run, trust requests (takedowns, key
  revocations) included, until the workflow is re-run. Refuses a `root-key` or `github-token`
  input.
- **`trust-check`** — on a pull request to the trust feed: the reviewer aid. Refuses a pull
  request that changes anything outside `publishers/`, `requests/` and `statements/`, or adds a
  source file the feed would not sign, and summarises what the merged result would sign under a
  `NIMBUS TRUST FEED` banner.
- **`trust-sign`** — on a push to the feed's default branch, behind the `trust-signing`
  environment's required approval: builds the next `trust.json` from the source with the same
  builder `nimbus trust maintain sign` runs (`buildTrustFeed` in `registry-format`), signs it with
  the Nimbus trust root key and pushes it to `gh-pages`. Every block already in the feed is
  carried; nothing new means no commit.

All five modes read the repository from the git tree, never the working directory: an entry under
`extensions/` (or a trust feed's `publishers/`, `requests/`, `statements/`) that is not a regular
`100644` file (a symlink or a submodule above all) is refused or skipped.

## Packages with `evals/`

A package may now carry an `evals/` directory (extension eval suites, `evals/<name>.eval.json`);
the file set the registry validates (rule 13) includes it. A registry whose workflow still pins an
older action release refuses such a package under rule 13 until the pin is updated. A starter pack
(`kind: "starter-pack"`) may not carry `evals/`. The `score` mode runs a package's suites and `sign`
signs the result into the index entry's `quality` (above).

## Inputs

| Input | Required | Description |
| --- | --- | --- |
| `mode` | yes | `check`, `sign`, `score`, `trust-check` or `trust-sign`. Anything else fails. |
| `default-branch` | no (`sign`, `score`, `trust-sign`) | The branch pull requests merge into. `init --github` writes it into the sign workflow. When empty, `sign` asks for `origin`'s `HEAD`, which is `gh-pages` if that branch was pushed first to an empty repository. |
| `github-token` | no (`check`, `sign`) | The token `gh attestation verify` fetches a version's build provenance with — pass `${{ github.token }}`. Empty means provenance is not verified; nothing is refused either way. In `check`, mutually exclusive with `nimbus-gateway` (both set fails the check). |
| `nimbus-gateway` | `score`; no (`check`) | The ABSOLUTE path to a Nimbus gateway executable (its `__nimbus-eval` role). Anything else fails the mode. In `check`, empty means the pull request's version is not scored; mutually exclusive with `github-token` (both set fails the check, and provenance is left to the sign job). Never pass it to a job that holds secrets. |
| `scores` | no (`score`, `sign`) | `score`: where it writes `scores.json`, relative to the workspace; empty means `scores.json`. `sign`: the `scores.json` to sign qualities from; empty means no `quality` is signed. |
| `root-key` | `sign`, `trust-sign` | The registry root signing key (`sign`) or the Nimbus trust root key (`trust-sign`). Pass it from an environment secret, never inline. |

## Building

The action runs on `node24` from the committed `dist/index.js`; the runner installs nothing. After
changing `src/` (or a dependency version), rebuild with `bun run build` and commit
`dist/index.js`. The build writes a first-line header recording the exact Bun that built the
bundle and an `inputHash` over every bundled input. `bun run audit:action-dist` always checks the
input hash, and byte-compares the bundle with a fresh build by that exact Bun (in CI through
`bun x bun@<version>`; locally only when you run that version). Build with the Bun CI uses, in
Docker `oven/bun:1.4` if yours differs. `src/closure.test.ts` fails when the bundle reaches a
`bun:*` module, the gateway, the CLI or a database module.

## License

AGPL-3.0-only. The bundle inlines `packages/registry-format`, which is AGPL-3.0-only, so this
action is too (unlike the MIT-licensed annotate and preflight-query actions).
