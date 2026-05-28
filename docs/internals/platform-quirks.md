# Platform quirks

Platform-specific behavior that warrants narrative beyond the code itself, migrated from inline comments. For sandbox-specific quirks see `docs/sandbox.md`.

## Entries

### Cast-driver socket path: named pipe on Windows, UNIX socket elsewhere

**Source:** `scripts/cast-driver/harness.ts:25` — added 2026-05-28
**Original comment (excerpt):** `Platform-specific dataDir derivation (mirrors packages/cli/src/paths.ts): Windows: join(LOCALAPPDATA, "Nimbus", "data"); macOS: join(HOME, "Library", "Application Support", "Nimbus") NOTE: on macOS dataDir == configDir == root (no "data" subdir); Linux: join(XDG_DATA_HOME, "nimbus")`

The cast-driver harness overrides `LOCALAPPDATA` (Windows), `HOME` (macOS), and `XDG_DATA_HOME` (Linux) so the CLI's `getCliPlatformPaths()` resolves `dataDir` to the harness-controlled temp directory. The derivation logic mirrors `packages/cli/src/paths.ts` exactly: Windows appends `Nimbus/data` to `LOCALAPPDATA`; macOS uses `Library/Application Support/Nimbus` directly under `HOME` with no trailing `data` segment (macOS `dataDir` equals `configDir`); Linux uses `XDG_DATA_HOME/nimbus`. Any change to `paths.ts` must be reflected here to keep the cast-driver harness aligned with the production path logic.

---

### Cast-driver socket path differs by platform

**Source:** `scripts/cast-driver/harness.ts:66` — added 2026-05-28
**Original comment (excerpt):** `socketPathFor: if process.platform === "win32" return named-pipe path; else return join(tmpDir, "gw.sock")`

The Gateway IPC socket is a Windows named pipe (`\\.\pipe\nimbus-cast-<pid>-<ts>`) on Windows and a UNIX domain socket (`<tmpDir>/gw.sock`) on macOS and Linux. The cast-driver harness constructs the correct path for each platform and passes it to the CLI subprocess via environment variables, mirroring the same branch that `PlatformServices` uses in production. Keeping a single authoritative branching function here (rather than inlining the condition at each call site) ensures the test harness and production code stay in sync.
