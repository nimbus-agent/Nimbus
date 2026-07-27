import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";

import { clearFixture, FAKE_SOCKET_PATH, setFixture } from "../../test/helpers/cli-mocks.ts";
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
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH } });
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
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH } });
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

describe("runUpdate channel-managed short-circuit", () => {
  it("runUpdate prints the channel hint and skips IPC when channel-managed", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (m?: unknown) => {
      logs.push(String(m));
    };
    try {
      await runUpdate([], { channel: "homebrew" });
    } finally {
      console.log = origLog;
    }
    expect(logs.join("\n")).toContain("brew upgrade nimbus");
  });

  it("still rejects an unknown flag on a managed install (validation before short-circuit)", async () => {
    await expect(runUpdate(["--bogus"], { channel: "homebrew" })).rejects.toThrow(/unknown flag/);
  });
});

describe("runUpdate dispatcher", () => {
  let origExitCode: typeof process.exitCode;

  beforeEach(() => {
    out.reset();
    origExitCode = process.exitCode;
    process.exitCode = 0;
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH } });
  });
  afterEach(() => {
    process.exitCode = origExitCode;
    clearFixture();
  });

  // Every dispatcher test passes `{ channel: null }` EXPLICITLY. Omitting it
  // lets `runUpdate` call the real `resolveDistributionChannel()`, which reads
  // the ambient `NIMBUS_DISTRIBUTION_CHANNEL` env var — so on a machine that has
  // it set (a dev box that installed the .msi, say) the dispatcher
  // short-circuits with an upgrade hint and never opens IPC, and all of these
  // fail with an empty call list. CI passes only because the var is unset there,
  // which makes the coverage accidental rather than guaranteed.
  it("still dispatches with an install channel set in the environment", async () => {
    // The real regression guard: force the exact ambient state that broke these
    // tests and assert the dispatcher STILL reaches IPC. Fails if anyone drops
    // the explicit `{ channel: null }` again.
    const prev = process.env["NIMBUS_DISTRIBUTION_CHANNEL"];
    process.env["NIMBUS_DISTRIBUTION_CHANNEL"] = "msi";
    try {
      const mock = createMockIpcClient([null]);
      setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });
      await runUpdate(["--yes"], { channel: null });
      expect(mock.calls.map((c) => c.method)).toEqual(["updater.applyUpdate"]);
    } finally {
      if (prev === undefined) delete process.env["NIMBUS_DISTRIBUTION_CHANNEL"];
      else process.env["NIMBUS_DISTRIBUTION_CHANNEL"] = prev;
    }
  });

  it("--check routes through withGatewayIpc to updater.checkNow", async () => {
    const mock = createMockIpcClient([
      { currentVersion: "0.1.0", latestVersion: "0.1.0", updateAvailable: false },
    ]);
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });
    await runUpdate(["--check"], { channel: null });
    expect(mock.calls.map((c) => c.method)).toEqual(["updater.checkNow"]);
    expect(out.stdout).toContain("current: 0.1.0");
    expect(process.exitCode).toBe(0);
  });

  it("--yes applies without prompting", async () => {
    const mock = createMockIpcClient([null]);
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });
    await runUpdate(["--yes"], { channel: null });
    expect(mock.calls.map((c) => c.method)).toEqual(["updater.applyUpdate"]);
    expect(out.stdout).toContain("Update applied. Gateway will restart.");
  });

  it("bare invocation with no update available prints No update available.", async () => {
    const mock = createMockIpcClient([
      { currentVersion: "0.1.0", latestVersion: "0.1.0", updateAvailable: false },
    ]);
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });
    await runUpdate([], { channel: null });
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
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });
    await runUpdate([], { channel: null });
    expect(out.stdout).toContain("Aborted.");
  });

  it("bare invocation prints Release notes when update available and notes present", async () => {
    // The non-TTY path: readLine() resolves "" → Aborted. But "Release notes:" is still printed.
    const mock = createMockIpcClient([
      {
        currentVersion: "0.5.0",
        latestVersion: "0.5.1",
        updateAvailable: true,
        notes: "Performance improvements",
      },
    ]);
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });
    await runUpdate([], { channel: null });
    expect(out.stdout).toContain("Release notes: Performance improvements");
    expect(out.stdout).toContain("Aborted.");
  });

  it("bare invocation applies update when TTY stdin returns answer immediately (chunk !== null)", async () => {
    // Cover readLine() branch: isTTY=true, read() returns a Buffer immediately.
    // Also covers the "yes" answer branch (line 79 closing brace reached).
    const origIsTTY = process.stdin.isTTY;
    const origRead = process.stdin.read.bind(process.stdin);
    process.stdin.isTTY = true;
    process.stdin.read = (): Buffer => Buffer.from("y\n");
    try {
      const mock = createMockIpcClient([
        {
          currentVersion: "0.5.0",
          latestVersion: "0.5.1",
          updateAvailable: true,
        },
        null, // updater.applyUpdate
      ]);
      setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });
      await runUpdate([], { channel: null });
      expect(mock.calls.map((c) => c.method)).toEqual(["updater.checkNow", "updater.applyUpdate"]);
      expect(out.stdout).toContain("Update applied. Gateway will restart.");
    } finally {
      process.stdin.isTTY = origIsTTY;
      process.stdin.read = origRead;
    }
  });

  it("bare invocation applies update when TTY stdin emits data event (chunk === null path)", async () => {
    // Cover readLine() branch: isTTY=true, read() returns null → waits for 'data' event.
    const origIsTTY = process.stdin.isTTY;
    const origRead = process.stdin.read.bind(process.stdin);
    process.stdin.isTTY = true;
    process.stdin.read = (): null => null;
    try {
      const mock = createMockIpcClient([
        {
          currentVersion: "0.5.0",
          latestVersion: "0.5.1",
          updateAvailable: true,
        },
        null, // updater.applyUpdate
      ]);
      setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });
      // Emit 'data' on a short delay, after readLine() has registered its listener.
      const emitTimer = setTimeout(() => {
        process.stdin.emit("data", Buffer.from("yes\n"));
      }, 20);
      try {
        await runUpdate([], { channel: null });
      } finally {
        clearTimeout(emitTimer);
      }
      expect(mock.calls.map((c) => c.method)).toEqual(["updater.checkNow", "updater.applyUpdate"]);
      expect(out.stdout).toContain("Update applied. Gateway will restart.");
    } finally {
      process.stdin.isTTY = origIsTTY;
      process.stdin.read = origRead;
    }
  });

  it("bare invocation aborts when TTY stdin answers 'n'", async () => {
    // Confirm the 'no' branch is explicit: answer fails regex, prints Aborted.
    const origIsTTY = process.stdin.isTTY;
    const origRead = process.stdin.read.bind(process.stdin);
    process.stdin.isTTY = true;
    process.stdin.read = (): Buffer => Buffer.from("n\n");
    try {
      const mock = createMockIpcClient([
        {
          currentVersion: "0.5.0",
          latestVersion: "0.5.1",
          updateAvailable: true,
        },
      ]);
      setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });
      await runUpdate([], { channel: null });
      expect(mock.calls.map((c) => c.method)).toEqual(["updater.checkNow"]);
      expect(out.stdout).toContain("Aborted.");
    } finally {
      process.stdin.isTTY = origIsTTY;
      process.stdin.read = origRead;
    }
  });
});
