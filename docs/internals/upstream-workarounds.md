# Upstream-library workarounds

Workarounds for external library bugs (Bun, Node, third-party packages), migrated from inline comments. Each entry cites the source file:line and the upstream issue if known.

## Entries

### Windows EBUSY retry loop in platform teardown tests

**Source:** `packages/gateway/src/platform/platform.test.ts:41` — added 2026-05-28
**Original comment (excerpt):** `Async fs.promises.rm with retries — the documented Windows-EBUSY workaround. Several tests in this file import ./index.ts, which constructs full PlatformServices (sync scheduler, connector mesh, lazy-loaded embedding runtime); under full-suite parallelism those services may still hold OS file handles inside tmpDir when this hook runs. POSIX unlinks open files happily and won't retry; Windows refuses deletion. If retries still fail (services that hold handles longer than the retry budget), the cleanup is logged-and-deferred to the OS temp reaper — failing the suite over a racy cleanup of a temp dir is worse than the leak.`

Windows does not allow deleting files with open handles, unlike POSIX where `unlink` succeeds immediately and the file persists until all handles close. The `platform.test.ts` teardown uses `fs.promises.rm` with a retry loop to tolerate the window during which `PlatformServices` components (sync scheduler, connector mesh, embedding runtime) may still hold file handles on the temp directory. If retries exhaust, the cleanup is logged and deferred to the OS temp reaper rather than failing the test suite over a transient timing race.
