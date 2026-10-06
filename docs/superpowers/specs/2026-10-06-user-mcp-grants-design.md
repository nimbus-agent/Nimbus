# User MCP servers that actually run — Design

**Date:** 2026-10-06
**Status:** Approved in conversation 2026-10-06; this document is the written spec.
**Branch:** `dev/asaf/user-mcp-grants`
**Scope:** one PR. Item 4 of the same session ("ship what we claim" PR 3) is a separate PR.

## Goal

`nimbus scaffold mcp <name>` produces a minimal MCP server that a user can build, register with
`nimbus connector add --mcp`, and see answer inside Nimbus — on Windows, macOS and Linux — and the
sandbox it runs in gives it exactly what the owner approved and nothing else.

## The defects this closes

Found while exploring the scaffold (2026-10-05), all from code reading plus one live Windows spike:

1. **The scaffold scaffolds nothing runnable.** `packages/cli/src/commands/scaffold.ts` emits a
   manifest, `dist/index.js` = `export default {}`, and a test asserting `expect(1).toBe(1)`.
   Installed extensions are never spawned by the gateway; the SDK's `NimbusExtensionServer` is a
   stub. `docs/architecture.md` § Extension Scaffold shows generated code that has never existed.
2. **No user MCP server can start on Linux or Windows.** `lazy-mesh/user-mcp.ts`'s
   `userMcpDefaultManifest` grants `network: []`, `filesystem.read: []`. Linux bwrap binds only
   `/usr`, `/etc`, `/lib`, `/lib64` plus the cwd, so `/home` does not exist inside the sandbox;
   the Windows helper adds ACEs only for the cwd and declared grants; macOS cannot read `/Users`.
   `docs/internals/known-todos.md` already records the missing per-server manifest. The CLI's own
   usage example (`npx -y @some/mcp-server`) needs network and `~/.npm` and cannot work.
3. **Every sandboxed connector can read and write the whole Nimbus data directory.**
   `lazy-mesh/mesh.ts:114` sets `sandboxCwd: paths.dataDir`, and every runner grants the cwd
   read+WRITE (`linux.ts` `--bind cwd cwd`, darwin `file-read*`/`file-write*` subpath, the
   Windows helper's Read/Execute/Write ACE). The index database lives there. The same value is
   threaded through `platform/assemble.ts` (team-tool invoke/list, write transport, warehouse sync
   transport, the ChatOps tool runner). For a user MCP — an arbitrary owner-approved command —
   that is read/write access to the entire index. No bundled connector needs any file there
   (checked: no `process.cwd()`, no relative writes, no dataDir references in
   `@nimbus-dev/connectors` 0.2.1 or `run-bundled-connector.ts`).
4. **Bun cannot run a script inside the Windows AppContainer** (`CouldntReadCurrentDirectory`,
   measured in `src-native/sandbox-helper-win32/README.md`). Script-mode user servers are
   therefore impossible on Windows regardless of grants.

### Spike (Windows, 2026-10-05)

A `bun build --compile` MCP server (SDK 1.32.0, one `echo` tool) spawned through
`createWin32SandboxRunner` with the real helper, `network: []`, under the gateway's real
`extensionProcessEnv({})`:

- answered `initialize`, `tools/list` and `tools/call` over stdio;
- started even with NO read grant on its own executable (the image is opened by the creating
  process, not the AppContainer) — so Windows needs no grant for the binary, Linux and macOS do;
- was confined: `EPERM` reading `C:\gitrep\Nimbus\package.json` and a file in its own,
  never-granted directory, while an unconfined control read the same file.

An env of only `SYSTEMROOT` failed with `CreateProcessW: 203`; the real `extensionProcessEnv`
works. Linux and macOS were not spiked; the E2E test below is their first proof.

## Design

### A. Per-connector sandbox working directory

- New `PlatformPaths.sandboxDir`, the root of per-spawn working directories:
  - Windows `%LOCALAPPDATA%\Nimbus\sandbox` (a sibling of `data`, so no ACE inherited from it);
  - macOS `~/Library/Caches/Nimbus/sandbox` (`dataDir === configDir === ~/Library/Application
    Support/Nimbus`, so nothing under that root qualifies);
  - Linux `${XDG_CACHE_HOME:-~/.cache}/nimbus/sandbox`;
  - demo (I41) `<demoRoot>/sandbox`, inside the demo subtree and outside its `data`/`config`.
- Property, tested on all three resolvers plus demo: `sandboxDir` is not equal to, inside, or an
  ancestor of `dataDir` or `configDir`.
- `wrapServerSpec`'s `cwd` argument becomes a per-policy directory
  `<sandboxDir>/<sanitised manifest id>`, created (recursive) before the spawn — `canonical-path.ts`
  falls back to the input spelling when the path does not exist, which would mis-apply the ACE.
  One helper owns derivation + creation; every producer that passed `paths.dataDir` passes
  `sandboxDir` instead and the helper derives the leaf from the manifest id, so the leaf cannot
  disagree with the policy.
- The `filesystem` MCP's deliberate, explicit grant on `dataDir` (mesh.ts ~95-108) is unchanged
  and out of scope; stated in `docs/sandbox.md`.
- Windows boot step: revoke the stale data-directory ACEs every first-party connector SID already
  holds (`buildRevokeGrantsArgv`, existing). Idempotent, runs every boot, skipped for demo-rooted
  gateways (I41 already skips the AppContainer reap for the same reason), failure logged not
  fatal. Without it the old inheritable ACEs keep the access this section removes.
- Residual, stated: concurrent spawns of the SAME policy id (mesh slot + teamvault session +
  write transport) still share one directory and one SID, so the unlocked DACL read-modify-write
  race for that id remains; cross-connector contention is gone.

### B. User MCP grants

CLI:
```
nimbus connector add --mcp <mcp_id> [--read <path>]... [--net <host[:port]>]... -- <command> [args...]
```

- The CLI resolves each `--read` to an absolute path against its cwd and sends structured
  `argv: string[]` (exact tokens — the old `commandLine` whitespace split breaks any path with a
  space, e.g. `C:\Users\Jane Doe\...`). `commandLine` stays accepted for compatibility.
- The gateway validates and RESOLVES before prompting, so the owner approves the final values:
  - command: absolute path kept; a bare name resolved with `Bun.which` against the gateway's
    `PATH`, refused if unresolvable; the stored command is the absolute path;
  - read grants: absolute, existing, canonicalised; refused if equal to, inside, or an ancestor of
    `dataDir`, `configDir` or `sandboxDir`; the command's own directory is appended automatically;
  - net grants: `host` or `host:port`, lowercase hostname or IP literal, no scheme/path/wildcard;
  - no write grants in this slice — the per-connector working directory is the only writable place.
- Gate payload (`connector.addMcp`, unchanged action type, still HITL + LAN-forbidden) carries
  `serviceId`, `command`, `args`, `readPaths`, `netHosts`, so the prompt and audit row show what is
  approved. On Windows a non-empty `netHosts` adds the line that AppContainer network access is
  all-or-nothing (`internetClient`), not per host.
- Schema V65: `ALTER TABLE user_mcp_connector ADD COLUMN read_paths_json TEXT NOT NULL DEFAULT
  '[]'` and `net_hosts_json` likewise. Existing rows keep today's deny-all behaviour.
- `userMcpDefaultManifest` is replaced by a manifest built from the row; a malformed JSON column is
  recorded as a persistent health error, the same path `recordArgsJsonFailure` uses. The
  known-todos entry is deleted.
- Stated bound (unchanged): a user MCP's tool CALLS are not in the HITL set; each dispatch through
  the executor appends an egress row whose destination is the service id, not the host.

### C. Scaffold

- `nimbus scaffold mcp <name>`; `scaffold extension <name>` remains as an alias that prints one
  line naming the new command. `<name>` must satisfy the user-MCP id rule minus the `mcp_` prefix
  (lowercase letters, digits, underscores, 1-62); the README uses `mcp_<name>`.
- Generated into `./<name>/` (refuses if it exists):
  - `package.json` — `type: module`; deps `@modelcontextprotocol/sdk` pinned to the CLI's own pin
    (`1.32.0`, read from one constant so they cannot drift) and `zod` `^4`; scripts `build`
    (`bun build --compile src/server.ts --outfile dist/<name>`), `test`, `start`;
  - `src/server.ts` — exported `createServer()` registering one `echo` tool, plus an
    `import.meta.main` guard that connects a stdio transport;
  - `src/server.test.ts` — connects `createServer()` to an SDK `Client` over the SDK's in-memory
    transport and asserts `tools/list` contains `echo` and `tools/call` echoes its input;
  - `README.md` — install, test, build, and the exact `nimbus connector add --mcp mcp_<name>
    --read <abs dist dir> -- <abs dist/<name>[.exe]>` line for the current OS;
  - `.gitignore` — `node_modules/`, `dist/`.

### D. Documentation

`docs/architecture.md` (delete the `NimbusExtensionServer` example, describe the real scaffold),
`docs/cli-reference.md` (`scaffold mcp`, `connector add --mcp` flags), `docs/README.md` (lines ~65
and ~821), `docs/CONTRIBUTING.md` (scaffold paragraph), `docs/sandbox.md` (per-connector
directories, user-MCP grants, the Windows network asymmetry for user MCPs, the remaining same-id
race, the `filesystem` exception), `docs/SECURITY-INVARIANTS.md` I15 (cwd is a per-policy directory
outside data/config; user-MCP grants are owner-approved), `docs/internals/known-todos.md`,
`docs/CHANGELOG.md`, `docs/roadmap.md`; `CLAUDE.md`/`GEMINI.md` schema `V64` → `V65`.

## Testing

- **Unit:** `sandboxDir` placement property per resolver + demo; cwd derivation/creation helper;
  grant validation (each refusal: relative, missing, data/config/sandbox overlap in all three
  directions, bad host shapes); command resolution; V65 migration on a pre-V65 DB; manifest
  construction from a row incl. malformed JSON; gate payload contents; CLI flag parsing; scaffold
  file set and the template's `server.ts`/`server.test.ts` content.
- **Security invariants test (I15):** a wrapped spawn's cwd is never `dataDir`/`configDir`, and a
  user-MCP read grant overlapping them is refused before any prompt.
- **E2E (gateway e2e tree, all three OSes in CI):** scaffold into a temp dir, compile it (SDK
  resolved from the repo's install, no network), register through the real `connector.addMcp`
  with an auto-approving test client, see `echo` in the mesh tool list, call it, and call a probe
  tool that must be refused reading a sentinel outside its grants — with an unconfined positive
  control reading the same sentinel first, so a refusal cannot pass for an unrelated reason.
- Windows-only boot revoke: unit test over the argv; integration test on the Windows leg that a
  stale ACE on a temp "data" dir is gone after the boot step.

## Out of scope

Write grants for user MCPs; HITL on user-MCP tool calls; per-host egress attribution; script-mode
(`bun src/server.ts`) servers; the `filesystem` MCP's dataDir grant; extension execution.
