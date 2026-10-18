# nimbus-agent/registry-action

First-party GitHub Action run by a Nimbus extension registry repository (the repository
`nimbus registry maintain init <dir> --github` creates). One action, two modes:

- **`check`** — on a publish pull request: the reviewer aid. Validates the one new
  `extensions/<id>/<version>/` against the signed index on `gh-pages` and writes a job summary for
  the reviewer. A green check is not the security boundary.
- **`sign`** — on a push to the default branch, behind the `registry-signing` environment's
  required approval: the content boundary. Re-validates every unsigned extension version, signs
  the index with the registry root key and pushes the site to `gh-pages`.

Both modes read the registry from the git tree, never the working directory: an entry under
`extensions/` that is not a regular `100644` file (a symlink or a submodule above all) is refused.

## Inputs

| Input | Required | Description |
| --- | --- | --- |
| `mode` | yes | `check` or `sign`. Anything else fails. |
| `root-key` | `sign` only | The registry root signing key. Pass it from an environment secret, never inline. |

## Building

The action runs on `node24` from the committed `dist/index.js`; the runner installs nothing. After
changing `src/`, rebuild with `bun run build` and commit `dist/index.js`. The bundle must be built
with the Bun release line CI uses (the `bun-version` default of
`.github/actions/setup-nimbus-ci/action.yml`): `bun run audit:action-dist` fails when the committed
bundle is not the build of the current sources. `src/closure.test.ts` fails when the bundle reaches
a `bun:*` module, the gateway, the CLI or a database module.

## License

AGPL-3.0-only. The bundle inlines `packages/registry-format`, which is AGPL-3.0-only, so this
action is too (unlike the MIT-licensed annotate and preflight-query actions).
