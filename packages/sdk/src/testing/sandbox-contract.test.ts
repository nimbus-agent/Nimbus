import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  __defaultRunProbe,
  type ProbeResult,
  type ProbeRunner,
  runSandboxContractTests,
} from "./sandbox-contract.ts";

function makeProbeRunner(
  responses: ReadonlyArray<{ probe: string; arg?: string; result: ProbeResult }>,
): { runner: ProbeRunner; calls: Array<{ probe: string; arg: string }> } {
  const calls: Array<{ probe: string; arg: string }> = [];
  const runner: ProbeRunner = (probe, arg) => {
    calls.push({ probe, arg });
    const match = responses.find(
      (r) => r.probe === probe && (r.arg === undefined || r.arg === arg),
    );
    if (match === undefined) {
      throw new Error(`unexpected probe call: ${probe} arg=${arg}`);
    }
    return match.result;
  };
  return { runner, calls };
}

function writeManifest(perms: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "sdk-contract-stub-"));
  const manifestPath = join(dir, "nimbus.extension.json");
  writeFileSync(manifestPath, JSON.stringify({ id: "test", permissions: perms }));
  return manifestPath;
}

describe("runSandboxContractTests", () => {
  it("rejects when the manifest file does not exist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sdk-contract-missing-"));
    const manifestPath = join(dir, "missing.json");
    await expect(runSandboxContractTests(manifestPath)).rejects.toThrow();
  });

  it("rejects when the manifest is not valid JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sdk-contract-bad-"));
    const manifestPath = join(dir, "nimbus.extension.json");
    writeFileSync(manifestPath, "{not-json");
    await expect(runSandboxContractTests(manifestPath)).rejects.toThrow();
  });

  it("handles a manifest with no declared network hosts without crashing", async () => {
    // No declared hosts → probes 1 and 2 are both skipped. Only probe 3
    // (fs-denied) runs. Outside the gateway sandbox harness, probe 3's
    // outcome depends on OS-level ACLs:
    //   - POSIX: /etc/passwd is world-readable → probe exits 2 → harness throws.
    //   - Windows: SAM hive is owner-locked → probe exits 10 → harness passes.
    // We only assert the "harness runs to completion" property here; the
    // pass/fail outcome is platform-dependent and that asymmetry is the
    // documented UX for third-party authors who invoke this outside the
    // gateway test helper. The gateway test helper wraps the probe with
    // `createSandboxRunner` and gets uniform enforcement across platforms.
    const dir = mkdtempSync(join(tmpdir(), "sdk-contract-empty-"));
    const manifestPath = join(dir, "nimbus.extension.json");
    writeFileSync(manifestPath, JSON.stringify({ id: "test.empty", permissions: {} }));
    let outcome: "pass" | "fail" = "pass";
    try {
      await runSandboxContractTests(manifestPath);
    } catch {
      outcome = "fail";
    }
    if (process.platform === "win32") {
      // Windows SAM hive is OS-protected → fs-denied probe gets EACCES → pass.
      expect(outcome).toBe("pass");
    } else {
      // POSIX /etc/passwd is world-readable → fs-denied probe exits 2 → harness throws.
      expect(outcome).toBe("fail");
    }
  }, 30_000);

  it("runs all three probes when manifest declares hosts (Linux/macOS)", async () => {
    const manifestPath = writeManifest({ network: ["api.github.com"] });
    const { runner, calls } = makeProbeRunner([
      {
        probe: "network-listed",
        arg: "api.github.com",
        result: { status: 0, stderr: "", stdout: "" },
      },
      { probe: "network-unlisted", arg: "", result: { status: 11, stderr: "", stdout: "" } },
      { probe: "fs-denied", arg: "", result: { status: 10, stderr: "", stdout: "" } },
    ]);
    await runSandboxContractTests(manifestPath, { runProbe: runner, platform: "linux" });
    expect(calls).toEqual([
      { probe: "network-listed", arg: "api.github.com" },
      { probe: "network-unlisted", arg: "" },
      { probe: "fs-denied", arg: "" },
    ]);
  });

  it("skips the network-unlisted probe on Windows", async () => {
    const manifestPath = writeManifest({ network: ["api.github.com"] });
    const { runner, calls } = makeProbeRunner([
      { probe: "network-listed", result: { status: 0, stderr: "", stdout: "" } },
      { probe: "fs-denied", result: { status: 10, stderr: "", stdout: "" } },
    ]);
    await runSandboxContractTests(manifestPath, { runProbe: runner, platform: "win32" });
    expect(calls.map((c) => c.probe)).toEqual(["network-listed", "fs-denied"]);
  });

  it("throws when the listed-host probe exits non-zero", async () => {
    const manifestPath = writeManifest({ network: ["api.github.com"] });
    const { runner } = makeProbeRunner([
      { probe: "network-listed", result: { status: 7, stderr: "connect refused", stdout: "" } },
    ]);
    await expect(
      runSandboxContractTests(manifestPath, { runProbe: runner, platform: "linux" }),
    ).rejects.toThrow(/network-listed probe failed for api\.github\.com.*exit 7.*connect refused/);
  });

  it("throws when the unlisted-host probe does NOT return exit 11", async () => {
    const manifestPath = writeManifest({ network: ["api.github.com"] });
    const { runner } = makeProbeRunner([
      { probe: "network-listed", result: { status: 0, stderr: "", stdout: "" } },
      {
        probe: "network-unlisted",
        result: { status: 2, stderr: "unexpected fetch success", stdout: "" },
      },
    ]);
    await expect(
      runSandboxContractTests(manifestPath, { runProbe: runner, platform: "linux" }),
    ).rejects.toThrow(/network-unlisted probe should have failed.*exit 2.*platform-asymmetry/s);
  });

  it("throws when fs-denied probe does NOT return exit 10", async () => {
    const manifestPath = writeManifest({});
    const { runner } = makeProbeRunner([
      { probe: "fs-denied", result: { status: 2, stderr: "unexpected file read", stdout: "" } },
    ]);
    await expect(
      runSandboxContractTests(manifestPath, { runProbe: runner, platform: "linux" }),
    ).rejects.toThrow(/fs-denied probe should have returned EACCES.*exit 2.*unexpected file read/s);
  });

  it("tolerates a manifest with `permissions: string[]` (legacy array form)", async () => {
    // The validator at registry-load normalizes legacy array form; the SDK
    // harness sees it on disk and must not crash — it just skips the
    // network probes and runs fs-denied.
    const manifestPath = writeManifest(["read-files", "trash"]);
    const { runner, calls } = makeProbeRunner([
      { probe: "fs-denied", result: { status: 10, stderr: "", stdout: "" } },
    ]);
    await runSandboxContractTests(manifestPath, { runProbe: runner, platform: "linux" });
    expect(calls).toEqual([{ probe: "fs-denied", arg: "" }]);
  });

  it("`__defaultRunProbe` returns a well-formed envelope on a probe that exits non-zero", () => {
    // Smoke-test the production runProbe by invoking it with an unknown
    // probe name; the probe binary exits 2 (unexpected) without touching
    // the sandbox so it's safe everywhere.
    const r = __defaultRunProbe("definitely-not-a-probe", "");
    expect(typeof r.status).toBe("number");
    expect(typeof r.stderr).toBe("string");
    expect(typeof r.stdout).toBe("string");
  }, 30_000);
});
