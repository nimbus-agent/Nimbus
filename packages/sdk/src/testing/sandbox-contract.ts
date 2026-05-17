/**
 * `runSandboxContractTests` — verifies the declared sandbox permissions in a
 * manifest match the runtime enforcement seen by a forked probe.
 *
 * Phase 5 T2 PR 1.
 *
 * Three probes run sequentially:
 *
 *   1. **network-listed** — for the first declared host in
 *      `permissions.network`, a HEAD fetch must succeed (2xx–4xx).
 *      Skipped if no hosts are declared.
 *
 *   2. **network-unlisted** — a fetch to `192.0.2.1` (TEST-NET-1, never
 *      routable) must fail with ECONNREFUSED / EPERM / EHOSTUNREACH /
 *      ENETUNREACH. Skipped on Windows because AppContainer network
 *      filtering is host-allow + deny-by-default at a different layer — the
 *      probe sees a generic socket failure that is indistinguishable from
 *      the unsandboxed case. See `docs/sandbox.md#platform-asymmetry`.
 *      Skipped on every platform if no hosts are declared (the
 *      sandbox-runner would deny network entirely in that case, and the
 *      probe's expectation collapses to "no network at all", which the
 *      first probe doesn't exercise).
 *
 *   3. **fs-denied** — a read of a known-protected path
 *      (`/etc/passwd` POSIX, `C:\Windows\System32\config\SAM` Windows)
 *      must fail with EACCES / EPERM. This probe always runs.
 *
 * Each probe is invoked via `child_process.spawnSync(process.execPath, …)`
 * directly. **The probe is *not* sandbox-wrapped by the SDK harness alone.**
 * For the SDK to assert real enforcement, a wrapping helper (typically
 * `packages/gateway/test/helpers/sandbox-harness.ts`) needs to fork
 * `runSandboxContractTests` inside a process that is itself sandbox-wrapped,
 * or substitute a sandboxed `execPath`.
 *
 * Used by:
 *   - First-party connector contract tests via the gateway test harness.
 *   - Third-party extension authors invoking
 *     `import { runSandboxContractTests } from "@nimbus-dev/sdk/testing"`.
 *
 * When invoked **outside** a sandboxed harness on Linux/macOS, probes 2 and
 * 3 will either succeed (return exit 2) — which the harness reports as a
 * test failure — or fail with codes other than 10/11. Either way the harness
 * throws. That's the third-party UX: "your contract test failed because the
 * sandbox isn't enforcing the manifest", which is the correct signal even
 * though the UX could be friendlier.
 */

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROBE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "sandbox-probe.ts");

interface ManifestPermissions {
  network?: string[];
  filesystem?: { read?: string[]; write?: string[] };
}

interface Manifest {
  id?: string;
  permissions?: ManifestPermissions | unknown[];
}

export interface ProbeResult {
  status: number;
  stderr: string;
  stdout: string;
}

/** Probe-runner shape — exposed for testability (see `__defaultRunProbe`). */
export type ProbeRunner = (probe: string, arg: string) => ProbeResult;

export interface RunSandboxContractTestsOptions {
  /**
   * Override the probe runner. Default is `__defaultRunProbe` (a
   * `child_process.spawnSync` wrapper around the bundled probe binary).
   * Tests inject a stub here; production callers leave this undefined.
   */
  runProbe?: ProbeRunner;
  /**
   * Override `process.platform` for testability of the Windows skip
   * branch. Default is the live `process.platform`.
   */
  platform?: NodeJS.Platform;
}

/**
 * Read the manifest at `manifestPath`, fork the probe binary for each
 * declared capability + the FS-denied negative case, and throw if the
 * observed enforcement does not match.
 *
 * Throws on first failure with a message that names the probe, the
 * observed exit code, and the probe's stderr.
 */
export async function runSandboxContractTests(
  manifestPath: string,
  opts: RunSandboxContractTestsOptions = {},
): Promise<void> {
  const runProbe = opts.runProbe ?? __defaultRunProbe;
  const platform = opts.platform ?? process.platform;

  const raw = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(raw) as Manifest;

  const perms = manifest.permissions;
  const objectForm =
    perms && typeof perms === "object" && !Array.isArray(perms)
      ? (perms as ManifestPermissions)
      : null;
  const hosts = objectForm?.network ?? [];

  // Probe 1 — listed host succeeds (skip if no hosts declared).
  const firstHost = hosts[0];
  if (firstHost !== undefined) {
    const r = runProbe("network-listed", firstHost);
    if (r.status !== 0) {
      throw new Error(
        `network-listed probe failed for ${firstHost}: exit ${r.status}; stderr: ${r.stderr.trim()}`,
      );
    }
  }

  // Probe 2 — unlisted host must be blocked. Skipped on Windows (asymmetry).
  if (platform !== "win32" && hosts.length > 0) {
    const r = runProbe("network-unlisted", "");
    if (r.status !== 11) {
      throw new Error(
        `network-unlisted probe should have failed with ECONNREFUSED/EPERM/EHOSTUNREACH/ENETUNREACH; ` +
          `got exit ${r.status}; stderr: ${r.stderr.trim()}. ` +
          `See docs/sandbox.md#platform-asymmetry.`,
      );
    }
  }

  // Probe 3 — FS-denied always runs.
  const r3 = runProbe("fs-denied", "");
  if (r3.status !== 10) {
    throw new Error(
      `fs-denied probe should have returned EACCES (exit 10); got exit ${r3.status}; ` +
        `stderr: ${r3.stderr.trim()}.`,
    );
  }
}

/**
 * Default probe runner — forks the bundled probe binary via
 * `child_process.spawnSync`. Exported for direct use in test scaffolding
 * that wants to assert the production wiring without re-implementing the
 * `spawnSync` envelope.
 */
export function __defaultRunProbe(probe: string, arg: string): ProbeResult {
  const result = spawnSync(process.execPath, [PROBE_PATH, `--probe=${probe}`, `--arg=${arg}`], {
    encoding: "utf8",
  });
  return {
    status: result.status ?? -1,
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
  };
}
