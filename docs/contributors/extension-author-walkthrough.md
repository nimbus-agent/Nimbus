# Extension author walkthrough

This is a short path from zero to a locally installed Nimbus extension. For the full contract, see `docs/architecture.md` (Extension Registry) and `packages/gateway/src/extensions/manifest.ts`.

> **Installed extensions are not executed yet.** Install hashes, Ed25519-verifies, records and enables an extension, and `nimbus extension list` shows it — but no code path spawns an installed extension's entry, so it adds no tools to the agent today. The steps below are what install and verification do; the spawn behaviour described in step 2 is the design, not current behaviour. To run your own MCP server now, use `nimbus scaffold mcp` and `nimbus connector add --mcp`. Tracked in [`ecosystem-roadmap.md` § Track 0](../ecosystem-roadmap.md#track-0--shipped-but-dark).

## 1. Create `nimbus.extension.json`

At the root of your package, add a manifest with at least:

- `id` — stable reverse-DNS id (no `..` segments).
- `version` — semver string.
- `name` — human-readable label.
- `entry` — relative path to the compiled entry (default `dist/index.js` if omitted).

The Gateway hashes this file and the entry file at install time; any on-disk change that does not match the registry disables the extension on the next verify pass.

## 2. Build the entry

The entry must exist at the path declared in `entry`. Use your normal TypeScript → JavaScript build; by design the Gateway will spawn the entry as a Bun child process with service-scoped env only (no Vault API across the boundary) — **not yet implemented**: today nothing spawns it (see the note at the top).

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
