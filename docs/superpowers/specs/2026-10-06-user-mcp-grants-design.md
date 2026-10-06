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
  disagree with the policy. The leaf is `id.toLowerCase().replaceAll(/[^a-z0-9_-]/g, "_")`: a
  fixed prefix-free character class, so no Windows reserved name (`CON`, `NUL`, `COM1`...) or
  trailing dot/space can be produced from a real id, and the mapping matches
  `mcpServerKeyForUserConnector`'s. A test asserts no two first-party manifest ids, and no
  first-party id and a `user.mcp_*` id, map to the same leaf.
- The CLI's mirror resolver (`packages/cli/src/paths.ts` + its demo derivation) gains the same
  `sandboxDir`, because `scripts/parity/demo-root.parity.test.ts` compares the CLI and gateway
  `deriveDemoPaths` results with an exact `toEqual`.
- Lifecycle: `nimbus connector remove` of a user MCP deletes its leaf best-effort (a locked file
  is logged, never fails the remove). Leaves of bundled connectors persist (bounded: one empty-ish
  directory per connector). A boot sweep of orphaned leaves is deferred — see Out of scope.
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

- The CLI resolves each `--read` to an absolute path against ITS cwd, and does the same for the
  command when it is relative-with-a-separator (`./dist/x`, `..\x.exe`, `dist/x`) — the gateway is
  a daemon with its own cwd, so resolving there would pick the wrong directory. A bare name
  (`python`, `my-tool`) is sent bare. The CLI sends structured `argv: string[]` (exact tokens —
  the old `commandLine` whitespace split breaks any path with a space, e.g.
  `C:\Users\Jane Doe\...`). `commandLine` stays accepted for compatibility.
- The gateway validates and RESOLVES before prompting, so the owner approves the final values:
  - command: an absolute path is kept; a bare name is resolved with `Bun.which` against the
    gateway's `PATH`, refused if unresolvable; the stored command is always the absolute path the
    owner approved, so a later `PATH` change cannot swap the binary (re-register to move it);
  - read grants: absolute, existing, canonicalised; refused if equal to, inside, or an ancestor of
    `dataDir`, `configDir` or `sandboxDir`;
  - the command's own directory is appended to the read grants on Linux and macOS only, where
    bwrap and SBPL need it to exec the binary. NOT on Windows: the spike showed the image is opened
    by the creating process, so no grant is needed, and the helper aborts the spawn with exit 66
    when it cannot write the ACE — which a standard user cannot on `C:\Program Files\...` or
    `C:\Windows\...`. Stated bound: an explicit Windows `--read` on such a directory fails the
    same way at spawn time, surfacing as the connector's persistent health error naming the path;
  - net grants: `host` or `host:port`, lowercase hostname or IP literal, no scheme/path/wildcard;
  - no write grants in this slice — the per-connector working directory is the only writable place.
- Gate payload (`connector.addMcp`, unchanged action type, still HITL + LAN-forbidden) carries
  `serviceId`, `command`, `args`, `readPaths`, `netHosts`, so the prompt and audit row show what is
  approved. On Windows a non-empty `netHosts` adds the line that AppContainer network access is
  all-or-nothing (`internetClient`), not per host.
- Schema V65: `ALTER TABLE user_mcp_connector ADD COLUMN read_paths_json TEXT NOT NULL DEFAULT
  '[]'` and `net_hosts_json` likewise. Existing rows keep today's deny-all behaviour.
- `userMcpDefaultManifest` is replaced by a manifest built from the row; a malformed JSON column is
  recorded as a persistent health error: `recordArgsJsonFailure` generalises to one
  `recordUserMcpRowFailure(ctx, serviceId, column, reason)` covering all three JSON columns. The
  known-todos entry is deleted.
- Stated bound (unchanged): a user MCP's tool CALLS are not in the HITL set; each dispatch through
  the executor appends an egress row whose destination is the service id, not the host.

### C. Scaffold

- `nimbus scaffold mcp <name>`; `scaffold extension <name>` remains as an alias that prints one
  line naming the new command. `<name>` must satisfy the user-MCP id rule minus the `mcp_` prefix
  (lowercase letters, digits, underscores, 1-62); the README uses `mcp_<name>`.
- Generated into `./<name>/` (refuses if it exists):
  - `package.json` — `type: module`; deps `@modelcontextprotocol/sdk` pinned to the CLI's own pin
    (`1.32.0`, a constant in `scaffold.ts` that a test asserts equals the
    `packages/cli/package.json` pin, so the two cannot drift silently) and `zod` `^4`; scripts `build`
    (`bun build --compile src/server.ts --outfile dist/<name>`), `test`, `start`;
  - `src/server.ts` — exported `createServer()` registering one `echo` tool, plus an
    `import.meta.main` guard that connects a stdio transport;
  - `src/server.test.ts` — connects `createServer()` to an SDK `Client` over the SDK's in-memory
    transport and asserts `tools/list` contains `echo` and `tools/call` echoes its input;
  - `README.md` — install, test, build, and the exact `nimbus connector add --mcp mcp_<name>
    -- <abs dist/<name>[.exe]>` line for the current OS (`bun build --compile` appends `.exe` on
    Windows; the README is rendered for the OS that ran the scaffold). The binary's own directory
    needs no `--read` (granted automatically where needed, § B); a short note shows `--read` and
    `--net` for a server that must reach other directories or hosts;
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
  resolved from the repo's install, no network: compiling for the HOST target, with no `--target`, embeds the running `bun` executable and downloads nothing; the spike compiled the same way), register through the real `connector.addMcp`
  with an auto-approving test client, see `echo` in the mesh tool list, call it, and call a probe
  tool that must be refused reading a sentinel outside its grants — with an unconfined positive
  control reading the same sentinel first, so a refusal cannot pass for an unrelated reason.
- Windows-only boot revoke: unit test over the argv; integration test on the Windows leg that a
  stale ACE on a temp "data" dir is gone after the boot step.

## Out of scope

Write grants for user MCPs; HITL on user-MCP tool calls; per-host egress attribution; script-mode
(`bun src/server.ts`) servers; the `filesystem` MCP's dataDir grant; extension execution; a boot-time sweep of orphaned sandbox leaves (bounded: one directory per removed-while-the-gateway-was-down user MCP); a registration-time probe that a Windows `--read` directory is ACL-writable (the spawn-time failure is the stated bound).
