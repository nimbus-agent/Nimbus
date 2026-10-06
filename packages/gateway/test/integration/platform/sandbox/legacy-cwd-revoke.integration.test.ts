import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createSandboxRunner } from "../../../../src/platform/sandbox/sandbox-runner.ts";
import { helperRunner } from "../../../../src/platform/sandbox/win32.ts";
import { revokeLegacyDataDirGrants } from "../../../../src/platform/sandbox/win32-reap.ts";

/**
 * Self-validating: a confined spawn with cwd = a temp "dataDir" must RAISE its app-container ACE
 * count (the premise), and the legacy revoke must bring it back. Without the premise assertion the
 * revoke check would pass vacuously.
 */
const IS_WIN = process.platform === "win32";
const WIN_HELPER =
  process.env["NIMBUS_SANDBOX_HELPER_PATH"] ??
  resolve(import.meta.dir, "../../../../src-native/sandbox-helper-win32/nimbus-sandbox-helper.exe");
if (IS_WIN && process.env["NIMBUS_SANDBOX_HELPER_PATH"] === undefined) {
  process.env["NIMBUS_SANDBOX_HELPER_PATH"] = WIN_HELPER;
}
const READY = IS_WIN && existsSync(WIN_HELPER);

const root = realpathSync(mkdtempSync(join(tmpdir(), "nimbus-legacy-revoke-")));
afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* Windows handle race; harmless */
  }
});

function aceCount(path: string): number {
  const r = spawnSync("icacls", [path], { encoding: "utf8", windowsHide: true });
  if (r.status !== 0) throw new Error(`icacls failed: ${r.stderr}`);
  return r.stdout.split(/\r?\n/).filter((l) => /S-1-15-2-[\d-]+:/.test(l)).length;
}

describe.skipIf(!READY)("legacy data-dir ACE revoke (real helper)", () => {
  it("removes the ACE a confined spawn left on its cwd and writes the marker", async () => {
    const id = `com.nimbus.revoke-it-${Math.floor(Math.random() * 1e9)}`;
    const before = aceCount(root);
    const runner = await createSandboxRunner();
    const child = runner.spawn(process.execPath, ["-e", "0"], {
      policy: { id, permissions: { network: [], filesystem: { read: [], write: [] } } },
      env: { PATH: process.env["PATH"] ?? "" },
      cwd: root,
      stdio: "ignore",
    });
    await new Promise<void>((res) => child.once("exit", () => res()));
    const afterSpawn = aceCount(root);
    expect(afterSpawn).toBeGreaterThan(before); // the premise

    const marker = join(root, "marker.done");
    const result = await revokeLegacyDataDirGrants({
      dataDir: root,
      ids: [id],
      run: helperRunner(WIN_HELPER),
      markerExists: () => existsSync(marker),
      writeMarker: () => writeFileSync(marker, "x"),
      logger: { info: () => {}, warn: () => {} },
    });
    expect(result).toBe("done");
    expect(aceCount(root)).toBe(before);
    expect(existsSync(marker)).toBe(true);
  });
});
