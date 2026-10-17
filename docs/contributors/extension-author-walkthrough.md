# Extension author walkthrough

This is a short path from zero to a locally installed Nimbus extension. For the full contract, see `docs/architecture.md` (Extension Registry) and `packages/gateway/src/extensions/manifest.ts`.

> **Installing does not run an extension; approving it does.** Install hashes, Ed25519-verifies, records and enables an extension. Since extension runtime PR 3 (2026-10-17), the owner can then approve it to run (`nimbus extension approve <id>`), and it runs as a sandboxed MCP stdio server on first use, from a verified per-spawn copy of its install tree that is also its working directory (invariant I43). Its tools are invoked by the owner with `nimbus connector tools|call ext_<id>`, each call behind an approval prompt; they are **not** offered to the agent's model yet (that is PR 4). Tracked in [`ecosystem-roadmap.md` § Track 0](../ecosystem-roadmap.md#track-0--shipped-but-dark).

## 1. Create `nimbus.extension.json`

At the root of your package, add a manifest with at least:

- `id` — stable reverse-DNS id (no `..` segments).
- `version` — semver string.
- `name` — human-readable label.
- `entry` — relative path to the compiled entry (default `dist/index.js` if omitted).

The Gateway hashes this file and the entry file at install time; any on-disk change that does not match the registry disables the extension on the next verify pass.

## 2. Build the entry

The entry must exist at the path declared in `entry`. Use your normal TypeScript → JavaScript build; the Gateway spawns the entry as a sandboxed Bun child process with service-scoped env only (no Vault API across the boundary), once the owner has approved it to run (see the note at the top). The entry should start an MCP stdio server. Its working directory is a fresh copy of your package made for that one run, so do not keep state there: write only to the paths your manifest declares under `permissions.filesystem.write`, which are its only persistence.

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

## 6. CI for your extension repo

Copy [`docs/templates/nimbus-extension-ci.yml`](../templates/nimbus-extension-ci.yml) into your extension repository as `.github/workflows/ci.yml`. Install the `nimbus` CLI on the runner (release binary or build from source) before the `nimbus test` step if it is not already on `PATH`.

## See also

- [Filesystem code search smoke](./filesystem-code-search-smoke.md) — manual `nimbus search` checks for indexed symbols under `[[filesystem.roots]]`.
