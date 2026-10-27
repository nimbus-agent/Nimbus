# nimbus-agent/registry-action

First-party GitHub Action run by a Nimbus extension registry repository (the repository
`nimbus registry maintain init <dir> --github` creates). One action, two modes:

- **`check`** — on a publish pull request: the reviewer aid. Admits the pull request's
  `statements/<statement id>.json` files (publisher-signed `key.rotate` / `key.revoke`) exactly as
  `sign` will, failing on any it would skip, then validates the new `extensions/<id>/<version>/`
  (if any: a statement-only pull request is valid) against the signed index on `gh-pages` with
  those statements admitted, and writes a job summary for the reviewer. A green check is not the
  security boundary.
- **`sign`** — on a push to the default branch, behind the `registry-signing` environment's
  required approval: the content boundary. Admits every `statements/` file it can (skipping and
  naming the rest; a statement once in the index is never removed), re-validates every unsigned
  extension version against the result, moves an extension's entry to its publisher's rotated key
  when a version signed by that key is added, signs the index with the registry root key and
  pushes the site to `gh-pages`. A run that admits only statements still re-signs, so a
  revocation reaches clients.

Both modes read the registry from the git tree, never the working directory: an entry under
`extensions/` that is not a regular `100644` file (a symlink or a submodule above all) is refused.

## Inputs

| Input | Required | Description |
| --- | --- | --- |
| `mode` | yes | `check` or `sign`. Anything else fails. |
| `default-branch` | no (`sign` only) | The branch publish pull requests merge into. `init --github` writes it into the sign workflow. When empty, `sign` asks for `origin`'s `HEAD`, which is `gh-pages` if that branch was pushed first to an empty repository. |
| `root-key` | `sign` only | The registry root signing key. Pass it from an environment secret, never inline. |

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
