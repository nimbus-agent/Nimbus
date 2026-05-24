// packages/cli/src/commands/update.test.ts
//
// Unit tests for `nimbus update` — argv parser + sub-handlers driven by a
// fixture IPCClient mock. Tests the IPC calls to `updater.checkNow` and
// `updater.applyUpdate` without spawning a real gateway socket.

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";

import "../../test/helpers/cli-mocks.ts";
import { clearFixture, setFixture } from "../../test/helpers/cli-mocks.ts";
import { captureOutput } from "../../test/helpers/cli-output.ts";
import { createMockIpcClient } from "../../test/helpers/mock-ipc-client.ts";

const mod = await import("./update.ts");
const { parseUpdateArgs, runUpdateApply, runUpdateCheck } = mod;

const out = captureOutput();

afterAll(() => {
  out.restore();
});

describe("parseUpdateArgs", () => {
  beforeEach(() => {
    out.reset();
  });

  it("default form — apply update with prompt", () => {
    expect(parseUpdateArgs([])).toEqual({ mode: "apply", yes: false });
  });

  it("--check flag", () => {
    expect(parseUpdateArgs(["--check"])).toEqual({ mode: "check", yes: false });
  });

  it("--yes suppresses prompt", () => {
    expect(parseUpdateArgs(["--yes"])).toEqual({ mode: "apply", yes: true });
  });

  it("--check with --yes", () => {
    expect(parseUpdateArgs(["--check", "--yes"])).toEqual({ mode: "check", yes: true });
  });

  it("-y short form", () => {
    expect(parseUpdateArgs(["-y"])).toEqual({ mode: "apply", yes: true });
  });

  it("rejects unknown flag", () => {
    expect(() => parseUpdateArgs(["--bogus"])).toThrow(/unknown/i);
  });
});

describe("runUpdateCheck", () => {
  // Snapshot + restore the process.exitCode so cross-test bleed-through
  // doesn't leak into adjacent suites. `process.exitCode` is typed as
  // `number | string | null | undefined` on recent Node — coerce to a
  // plain number on save and re-assign verbatim on restore.
  let origExitCode: typeof process.exitCode;

  beforeEach(() => {
    out.reset();
    origExitCode = process.exitCode;
    process.exitCode = 0;
    setFixture({ gatewayState: { socketPath: "/tmp/fake.sock" } });
  });
  afterEach(() => {
    process.exitCode = origExitCode;
    clearFixture();
  });

  it("prints current/latest and sets exit code 0 when no update available", async () => {
    const { client, calls } = createMockIpcClient([
      { currentVersion: "0.1.0", latestVersion: "0.1.0", updateAvailable: false },
    ]);
    await runUpdateCheck(client);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ method: "updater.checkNow", params: {} });
    expect(out.stdout).toContain("current: 0.1.0");
    expect(out.stdout).toContain("latest:  0.1.0");
    expect(process.exitCode).toBe(0);
  });

  it("sets exit code 1 when an update is available", async () => {
    const { client } = createMockIpcClient([
      { currentVersion: "0.1.0", latestVersion: "0.1.1", updateAvailable: true },
    ]);
    await runUpdateCheck(client);
    expect(out.stdout).toContain("current: 0.1.0");
    expect(out.stdout).toContain("latest:  0.1.1");
    expect(process.exitCode).toBe(1);
  });

  it("prints release notes when present", async () => {
    const { client } = createMockIpcClient([
      {
        currentVersion: "0.1.0",
        latestVersion: "0.1.1",
        updateAvailable: true,
        notes: "Bug fixes",
      },
    ]);
    await runUpdateCheck(client);
    expect(out.stdout).toContain("notes:   Bug fixes");
  });

  it("propagates IPC errors from updater.checkNow", async () => {
    const { client } = createMockIpcClient([new Error("gateway down")]);
    await expect(runUpdateCheck(client)).rejects.toThrow(/gateway down/);
  });
});

describe("runUpdateApply", () => {
  beforeEach(() => {
    out.reset();
    setFixture({ gatewayState: { socketPath: "/tmp/fake.sock" } });
  });
  afterEach(() => {
    clearFixture();
  });

  it("calls updater.applyUpdate and prints the success message", async () => {
    const { client, calls } = createMockIpcClient([null]);
    await runUpdateApply(client);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ method: "updater.applyUpdate", params: {} });
    expect(out.stdout).toContain("Update applied. Gateway will restart.");
  });

  it("propagates IPC errors from updater.applyUpdate", async () => {
    const { client } = createMockIpcClient([new Error("signature verification failed")]);
    await expect(runUpdateApply(client)).rejects.toThrow(/signature verification failed/);
  });
});
