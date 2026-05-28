import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";

import "../../test/helpers/cli-mocks.ts";
import { clearFixture, setFixture } from "../../test/helpers/cli-mocks.ts";
import { captureOutput } from "../../test/helpers/cli-output.ts";
import { createMockIpcClient } from "../../test/helpers/mock-ipc-client.ts";

const mod = await import("./update.ts");
const { parseUpdateArgs, runUpdate, runUpdateApply, runUpdateCheck } = mod;

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

describe("runUpdate dispatcher", () => {
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

  it("--check routes through withGatewayIpc to updater.checkNow", async () => {
    const mock = createMockIpcClient([
      { currentVersion: "0.1.0", latestVersion: "0.1.0", updateAvailable: false },
    ]);
    setFixture({ gatewayState: { socketPath: "/tmp/fake.sock" }, ipcClient: mock.client });
    await runUpdate(["--check"]);
    expect(mock.calls.map((c) => c.method)).toEqual(["updater.checkNow"]);
    expect(out.stdout).toContain("current: 0.1.0");
    expect(process.exitCode).toBe(0);
  });

  it("--yes applies without prompting", async () => {
    const mock = createMockIpcClient([null]);
    setFixture({ gatewayState: { socketPath: "/tmp/fake.sock" }, ipcClient: mock.client });
    await runUpdate(["--yes"]);
    expect(mock.calls.map((c) => c.method)).toEqual(["updater.applyUpdate"]);
    expect(out.stdout).toContain("Update applied. Gateway will restart.");
  });

  it("bare invocation with no update available prints No update available.", async () => {
    const mock = createMockIpcClient([
      { currentVersion: "0.1.0", latestVersion: "0.1.0", updateAvailable: false },
    ]);
    setFixture({ gatewayState: { socketPath: "/tmp/fake.sock" }, ipcClient: mock.client });
    await runUpdate([]);
    expect(out.stdout).toContain("No update available.");
  });

  it("bare invocation with update available aborts under non-TTY stdin", async () => {
    const mock = createMockIpcClient([
      {
        currentVersion: "0.1.0",
        latestVersion: "0.1.1",
        updateAvailable: true,
        notes: "Bug fixes",
      },
    ]);
    setFixture({ gatewayState: { socketPath: "/tmp/fake.sock" }, ipcClient: mock.client });
    await runUpdate([]);
    expect(out.stdout).toContain("Aborted.");
  });
});
