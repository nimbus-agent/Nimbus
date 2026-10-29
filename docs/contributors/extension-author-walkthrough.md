# Extension author walkthrough

This is a short path from zero to a locally installed Nimbus extension. For the full contract, see `docs/architecture.md` (Extension Registry) and `packages/gateway/src/extensions/manifest.ts`.

> **Installing does not run an extension; approving it does.** Install hashes, Ed25519-verifies, records and enables an extension. Since extension runtime PR 3 (2026-10-17), the owner can then approve it to run (`nimbus extension approve <id>`), and it runs as a sandboxed MCP stdio server on first use, from a verified per-spawn copy of its install tree that is also its working directory (invariant I43). Its tools are invoked by the owner with `nimbus connector tools|call ext_<id>`, each call behind an approval prompt; they are **not** offered to the agent's model yet (that is PR 4). Tracked in [`ecosystem-roadmap.md` § Track 0](../ecosystem-roadmap.md#track-0--shipped-but-dark).

## 1. Scaffold

```bash
nimbus scaffold extension my_ext --publisher acme
cd my_ext && bun install && bun test
```

This writes `./my_ext/` with a `nimbus.extension.json` (`id` `acme/my_ext`, `version` `0.1.0`, `entry` `dist/index.js`, empty permissions, `publisher: { id: "acme" }`), an MCP server with one `echo` tool and its test. Without `--publisher` the id is just `my_ext`, which a registry that requires namespaced ids will refuse.

The manifest needs at least `id` (stable, no `..` segments), `version` (semver), `name` and `entry` (default `dist/index.js`). The Gateway hashes the manifest and the entry file at install time; any on-disk change that does not match the recorded hashes disables the extension on the next verify pass.

## 2. Build the entry

```bash
bun run build
```

This runs `bun build src/server.ts --target=bun --outfile dist/index.js`: one self-contained JavaScript file with its dependencies bundled in. Do not use `--compile`: the extension runtime `import()`s the entry with no `node_modules`. The entry starts an MCP stdio server; the Gateway spawns it as a sandboxed Bun child process with service-scoped env only (no Vault API across the boundary), once the owner has approved it to run (see the note at the top). Its working directory is a fresh copy of your package made for that one run, so do not keep state there: write only to the paths your manifest declares under `permissions.filesystem.write`, which are its only persistence.

## 3. Install from a directory or tarball

With the Gateway running and the CLI connected:

- **Directory:** `nimbus extension install <path-to-folder>`
- **Archive:** package the same layout as the directory into `.tar.gz` / `.tgz`; `nimbus extension install <path-to-archive>`

The tool copies into the configured extensions directory, records SHA-256 manifest and entry hashes, and inserts a row in the local SQLite `extension` table.

## 4. Enable, list, verify

- `nimbus extension list` — ids, versions, paths, enabled flag.
- Startup verification compares on-disk bytes to stored hashes; manifest or entry hash mismatch logs at ERROR and sets `enabled = 0` (which would precede any spawn, once extensions are executed).

## 5. Test locally

Use a scratch config dir and `nimbus start` so you do not touch your primary index. After changing code, bump `version` or reinstall so hashes stay consistent with the registry row.

Run **`nimbus test .`** from the extension package root: it validates the manifest contract (`runContractTests` from `@nimbus-dev/sdk`) and, when `package.json` defines a `test` script, runs `bun test`.

## 6. Sign and publish to a registry

```bash
nimbus extension keygen            # once; prints your public key
nimbus extension sign .
nimbus extension publish . --registry-repo <owner>/<repo>
```

`sign` fills the manifest's `publisher.key` with the public half of your signing key (when `publisher.id` is set and no key is), then signs it; it refuses to re-key a manifest that already names a different key. `publish` packs the package file set (`nimbus.extension.json`, everything under `dist/` and `evals/`, top-level `README*`/`LICENSE*`), checks it against the registry's published state and opens a pull request that adds it to the registry repository. It needs `git` and, to open the pull request itself, a signed-in `gh`; otherwise it prints the commands to finish by hand. Re-sign after any change to the manifest, and bump `version` for each publish: a published `<id>@<version>` is never overwritten. See [`docs/cli-reference.md`](../cli-reference.md#nimbus-extension-publish-dir---registry-repo-ownerrepo---clone-path---channel-stablebeta---no-pr).

A registry hosted on GitHub runs its own CI over your pull request: a **Registry check** job validates it for the reviewer, and after the merge a maintainer approves the **Registry sign** run in the registry's `registry-signing` environment, which signs your version into the published index (see [`docs/registry-hosting.md`](../registry-hosting.md)). A folder registry has no CI; its maintainer adds accepted packages with `nimbus registry maintain add`.

**Build provenance (optional).** Add `"repository": "<owner>/<repo>"` to `nimbus.extension.json` (before `sign`), and publish from a GitHub Actions workflow in that repository that attests the exact package it publishes: run `nimbus extension publish . --registry-repo <owner>/<repo> --clone <path> --no-pr`, then `actions/attest-build-provenance` with `subject-path: <path>/extensions/<id>/<version>/package.tgz` (the job needs `id-token: write` and `attestations: write`), then open the pull request. When the registry signs the version it verifies that attestation and users see "Provenance verified by <registry>: built from <owner>/<repo> at <commit> by <workflow>". Without it nothing is refused; the version simply carries no provenance.

Extension ids a registry accepts are narrower than ids the gateway installs: every `/` segment must start with a letter or digit, hold only letters, digits, `.`, `_` and `-`, and not end in `.` or `.lock`. `nimbus scaffold extension` only produces such ids.

## 7. CI for your extension repo

Copy [`docs/templates/nimbus-extension-ci.yml`](../templates/nimbus-extension-ci.yml) into your extension repository as `.github/workflows/ci.yml`. Install the `nimbus` CLI on the runner (release binary or build from source) before the `nimbus test` step if it is not already on `PATH`.

## See also

- [Filesystem code search smoke](./filesystem-code-search-smoke.md) — manual `nimbus search` checks for indexed symbols under `[[filesystem.roots]]`.
