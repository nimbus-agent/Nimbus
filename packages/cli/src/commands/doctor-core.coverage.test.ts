import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { captureOutput } from "../../test/helpers/cli-output.ts";
import { createMockIpcClient } from "../../test/helpers/mock-ipc-client.ts";
import type { IPCClient } from "../ipc-client/index.ts";
import type { CliPlatformPaths } from "../paths.ts";
import {
  bunVersionOk,
  createDoctorVaultExec,
  type DoctorCoreDeps,
  type DoctorVaultExec,
  type DoctorVaultRun,
  doctorPrintBunCheck,
  doctorPrintEmbeddingFromSnapshot,
  doctorVaultLine,
  doctorVaultStatus,
  formatDoctorVaultLine,
  runDoctor,
} from "./doctor-core.ts";

/**
 * Branches `doctor-core.test.ts` and `doctor-vault.test.ts` leave unexercised: the Bun-version
 * failure line, every way the Secret Service D-Bus reads can fail short of a verdict, a spawn that
 * cannot start, the embedding edge shapes, and `runDoctor`'s IPC edges. Every
 * `runDoctor` run here uses a DEMO-rooted path set, so the real OS keyring is never probed.
 */

const out = captureOutput();
afterAll(() => {
  out.restore();
});

const MISSING_BINARY = "nimbus-doctor-no-such-binary-c03a";

describe("Bun version gate", () => {
  it("accepts 1.2 and later, refuses older, and passes a version it cannot parse", () => {
    expect(bunVersionOk("1.2.0")).toBe(true);
    expect(bunVersionOk("1.10.3")).toBe(true);
    expect(bunVersionOk("2.0.0")).toBe(true);
    expect(bunVersionOk("1.1.9")).toBe(false);
    expect(bunVersionOk("0.9.0")).toBe(false);
    expect(bunVersionOk("canary")).toBe(true);
  });

  it("prints a [fail] line naming the minimum and returns 2 on an old Bun", () => {
    out.reset();
    expect(doctorPrintBunCheck("1.1.0")).toBe(2);
    expect(out.stdout).toBe(
      "Runtime: Bun 1.1.0\n[fail] Nimbus expects Bun >= 1.2 (see repository README).\n",
    );
  });

  it("prints [ok] and returns 0 on a current Bun", () => {
    out.reset();
    expect(doctorPrintBunCheck("1.3.14")).toBe(0);
    expect(out.stdout).toBe("Runtime: Bun 1.3.14\n[ok] Bun version meets minimum.\n");
  });
});

describe("Linux vault probe — D-Bus reads that fail short of a verdict", () => {
  const ALIAS_LOGIN: DoctorVaultRun = {
    code: 0,
    stdout: 'o "/org/freedesktop/secrets/collection/login"\n',
    stderr: "",
  };

  /**
   * `alias` answers the ReadAlias query and `locked` the Locked one. `toolsFor` decides which
   * binaries exist per call, so a test can make the second query find no tool at all.
   */
  function exec(opts: {
    alias: DoctorVaultRun;
    locked?: DoctorVaultRun;
    toolsFor?: (call: number) => readonly string[];
  }): DoctorVaultExec & { queries: string[][] } {
    const queries: string[][] = [];
    let hasBinaryCalls = 0;
    return {
      queries,
      findSecretTool: () => "/usr/bin/secret-tool",
      lookupStderr: () => "",
      hasBinary: (name) => {
        hasBinaryCalls += 1;
        return (opts.toolsFor?.(hasBinaryCalls) ?? ["busctl"]).includes(name);
      },
      runQuery: (cmd) => {
        queries.push([...cmd]);
        if (cmd.includes("Locked")) {
          return opts.locked ?? { code: 0, stdout: "b false\n", stderr: "" };
        }
        return opts.alias;
      },
    };
  }

  it("a failed ReadAlias whose stderr names no provider reports no-secret-service", () => {
    const stderr =
      "Call failed: The name org.freedesktop.secrets was not provided by any .service files\n";
    expect(doctorVaultStatus("linux", exec({ alias: { code: 1, stdout: "", stderr } }))).toEqual({
      state: "no-secret-service",
      exit: 2,
      detail: stderr.trim(),
    });
  });

  it("a failed ReadAlias whose stderr names a missing session bus reports no-session-bus", () => {
    const stderr = "Failed to connect: DBUS_SESSION_BUS_ADDRESS is not set\n";
    const s = doctorVaultStatus("linux", exec({ alias: { code: 1, stdout: "", stderr } }));
    expect(s.state).toBe("no-session-bus");
    expect(s.exit).toBe(2);
  });

  it("a failed ReadAlias with an unrecognised error is unverified — a warning, never a verdict", () => {
    const s = doctorVaultStatus(
      "linux",
      exec({ alias: { code: 1, stdout: "", stderr: "  Call failed: Access denied\n" } }),
    );
    expect(s).toEqual({ state: "unverified", exit: 1, detail: "Call failed: Access denied" });
    expect(formatDoctorVaultLine(s).startsWith("[warn] Vault: ")).toBe(true);
    expect(formatDoctorVaultLine(s).endsWith(" [Call failed: Access denied]")).toBe(true);
  });

  it("a ReadAlias reply with no object path is unverified and carries the raw reply", () => {
    const s = doctorVaultStatus(
      "linux",
      exec({ alias: { code: 0, stdout: "garbled reply\n", stderr: "" } }),
    );
    expect(s).toEqual({ state: "unverified", exit: 1, detail: "garbled reply" });
  });

  it("no tool left for the Locked read is unverified with an empty detail — and nothing is run", () => {
    const e = exec({ alias: ALIAS_LOGIN, toolsFor: (call) => (call === 1 ? ["busctl"] : []) });
    const s = doctorVaultStatus("linux", e);
    expect(s).toEqual({ state: "unverified", exit: 1, detail: "" });
    // Only the ReadAlias ran; the Locked read had nothing to run with.
    expect(e.queries).toHaveLength(1);
    expect(formatDoctorVaultLine(s).endsWith("]")).toBe(false);
  });

  it("a failed Locked read is unverified and carries its stderr", () => {
    const s = doctorVaultStatus(
      "linux",
      exec({ alias: ALIAS_LOGIN, locked: { code: 1, stdout: "", stderr: "No such object\n" } }),
    );
    expect(s).toEqual({ state: "unverified", exit: 1, detail: "No such object" });
  });

  it("a Locked reply with no boolean in it is unverified and carries the raw reply", () => {
    const s = doctorVaultStatus(
      "linux",
      exec({ alias: ALIAS_LOGIN, locked: { code: 0, stdout: 's "maybe"\n', stderr: "" } }),
    );
    expect(s).toEqual({ state: "unverified", exit: 1, detail: 's "maybe"' });
  });

  it("off Linux, the default exec is never consulted and the line names the OS", () => {
    expect(doctorVaultLine("win32")).toBe(
      "[ok] Vault: OS-native store — no Linux Secret Service check. (win32)",
    );
    expect(doctorVaultLine("darwin")).toBe(
      "[ok] Vault: OS-native store — no Linux Secret Service check. (darwin)",
    );
  });
});

describe("createDoctorVaultExec — a real child process", () => {
  // The running Bun binary stands in for secret-tool/busctl: it exists on every platform. It exits
  // NON-zero, so a runQuery that reported a constant 0 instead of the child's own code would fail.
  const script =
    "process.stdout.write('SECRET-VALUE'); process.stderr.write('diag line'); process.exitCode = 3";

  // Both calls below are TIMED `Bun.spawnSync`s (the exec's 5 s probe budget), and on Windows Bun
  // 1.3.14 times one from when the process last ran a `spawnSync`, not from the call itself. When
  // that was more than 5 s earlier (any earlier test file's, in a whole-package run), the call
  // reports a timeout within ~5 ms, before the child has run: exit code null, SIGTERM, no output.
  // That is how this test failed under `build-lcov`'s instrumented CLI run, where everything runs
  // slower. Measured with a probe that sleeps between timed calls: a 2 s timeout misfires after a
  // 2.5 s gap and holds after a 1 s one, a 10 s timeout holds after 2.5 s, any `spawnSync` resets
  // the reference point, and the same probe never misfires on Linux. Production runs this exec on
  // Linux only (the Vault status line and `--fix-keyring`). So each test starts with an untimed
  // `spawnSync`, which leaves the call under test its real 5 s budget.
  const resetSpawnSyncClock = (): void => {
    Bun.spawnSync([process.execPath, "-e", ""], {
      stdout: "ignore",
      stderr: "ignore",
      windowsHide: true,
    });
  };

  it("runQuery captures stdout, stderr and the exit code", () => {
    resetSpawnSyncClock();
    const run = createDoctorVaultExec().runQuery([process.execPath, "-e", script]);
    expect(run).toEqual({ code: 3, stdout: "SECRET-VALUE", stderr: "diag line" });
  });

  it("lookupStderr returns stderr only — the child's stdout is never captured", () => {
    // The lookup runs against a real credential store, so a matched secret must have nowhere to go.
    resetSpawnSyncClock();
    const stderr = createDoctorVaultExec().lookupStderr(process.execPath, ["-e", script]);
    expect(stderr).toBe("diag line");
    expect(stderr).not.toContain("SECRET-VALUE");
  });

  it("lookupStderr does not hand the child's stdout to this process's own stdout either", async () => {
    // The test above cannot see an INHERITED stdout: it bypasses every in-process capture and goes
    // straight to the runner's fd 1 — for `nimbus doctor`, the user's terminal. So the lookup runs
    // inside a driver Bun whose stdout is piped here; a secret the lookup's child printed to an
    // inherited stdout would land in `stdout` below.
    const moduleUrl = pathToFileURL(join(import.meta.dir, "doctor-core.ts")).href;
    const driver = [
      `const { createDoctorVaultExec } = await import(${JSON.stringify(moduleUrl)});`,
      `const stderr = createDoctorVaultExec().lookupStderr(process.execPath, ["-e", ${JSON.stringify(script)}]);`,
      `process.stderr.write("returned: " + stderr);`,
    ].join("\n");
    // Async with a deadline of our own, not `spawnSync`'s `timeout`: on Windows a timed sync spawn
    // can fail at start-up in a way indistinguishable from that deadline (see
    // `tui/dumb-terminal.test.ts`), and a kill here still settles `exited` instead of hanging.
    const proc = Bun.spawn([process.execPath, "-e", driver], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
    const deadline = setTimeout(() => proc.kill(), 20_000);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]).finally(() => clearTimeout(deadline));
    // The driver reached the lookup (so this is not vacuous) and got the child's stderr back...
    expect(stderr).toBe("returned: diag line");
    // ...while the child's stdout, where a matched secret would be printed, reached nobody.
    expect(stdout).toBe("");
    expect(exitCode).toBe(0);
  });
});

describe("createDoctorVaultExec — a binary that cannot be spawned", () => {
  it("runQuery reports the spawn failure as stderr with a null exit code, never throwing", () => {
    const run = createDoctorVaultExec(2_000).runQuery([MISSING_BINARY, "--version"]);
    expect(run.code).toBeNull();
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain(MISSING_BINARY);
  });

  it("lookupStderr returns the same failure text, and hasBinary says the binary is absent", () => {
    const e = createDoctorVaultExec();
    expect(e.lookupStderr(MISSING_BINARY, ["lookup", "a", "b"])).toContain(MISSING_BINARY);
    expect(e.hasBinary(MISSING_BINARY)).toBe(false);
  });
});

describe("doctorPrintEmbeddingFromSnapshot — edge shapes", () => {
  beforeEach(() => {
    out.reset();
  });

  it("warming with a non-finite elapsed time prints no fabricated duration", () => {
    for (const elapsedMs of [Number.POSITIVE_INFINITY, Number.NaN]) {
      out.reset();
      expect(doctorPrintEmbeddingFromSnapshot({ embedding: { state: "warming", elapsedMs } })).toBe(
        1,
      );
      expect(out.stdout).toBe(
        "[warn] Embeddings: still loading — semantic search is not available yet.\n",
      );
    }
  });

  it("a state that is not a string is an unrecognised state, and fails", () => {
    expect(doctorPrintEmbeddingFromSnapshot({ embedding: { state: 42 } })).toBe(2);
    expect(out.stdout).toBe(
      '[fail] Embeddings: unrecognised runtime state "" — treat as not working.\n',
    );
  });
});

describe("runDoctor — IPC edges", () => {
  const roots: string[] = [];
  let priorExitCode: typeof process.exitCode;

  beforeEach(() => {
    out.reset();
    priorExitCode = process.exitCode;
  });
  afterEach(() => {
    // `?? 0`: Bun ignores `process.exitCode = undefined`, so restoring an unset code that way
    // would leave this test's exit code behind for the whole process.
    process.exitCode = priorExitCode ?? 0;
  });
  afterAll(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  });

  function demoPaths(): CliPlatformPaths {
    const root = mkdtempSync(join(tmpdir(), "nimbus-doctor-cov-"));
    roots.push(root);
    const configDir = join(root, "config");
    mkdirSync(configDir, { recursive: true });
    return {
      configDir,
      dataDir: join(root, "data"),
      logDir: join(root, "data", "logs"),
      socketPath: join(root, "gw.sock"),
      extensionsDir: join(root, "ext"),
      tempDir: join(root, "tmp"),
      sandboxDir: join(root, "sandbox"),
      // Demo-rooted: the vault line is the in-memory one, so no OS keyring probe ever runs.
      demo: true,
    };
  }

  function deps(paths: CliPlatformPaths, over: Partial<DoctorCoreDeps> = {}): DoctorCoreDeps {
    return {
      getCliPlatformPaths: () => paths,
      readGatewayState: async () => undefined,
      isProcessAlive: () => true,
      gatewayStatePath: (p) => join(p.dataDir, "gateway.json"),
      makeClient: () => createMockIpcClient([]).client,
      fixKeyringDeps: {
        exec: {
          findSecretTool: () => null,
          lookupStderr: () => "",
          hasBinary: () => false,
          runQuery: () => ({ code: 0, stdout: "", stderr: "" }),
        },
        homeDir: () => paths.tempDir,
        statMode: () => null,
        mkdirMode: () => {},
        writeFileMode: () => {},
        listDir: () => [],
      },
      ...over,
    };
  }

  it("a ping that reports no usable uptime is shown as ~0s, not NaN", async () => {
    const paths = demoPaths();
    for (const ping of [{}, { uptime: Number.NaN }]) {
      out.reset();
      const mock = createMockIpcClient([
        ping,
        { ok: true, errors: [], warnings: [] },
        {
          index: { totalItems: 3 },
          connectorHealth: [{ connectorId: "github", state: "healthy" }],
        },
      ]);
      await runDoctor(
        [],
        deps(paths, {
          readGatewayState: async () => ({ socketPath: paths.socketPath, pid: 1 }),
          makeClient: () => mock.client,
        }),
      );
      expect(out.stdout).toContain("[ok] Gateway: IPC OK (uptime ~0s).\n");
      expect(out.stdout).not.toContain("NaN");
    }
  });

  it("a connect that rejects with a non-Error is reported verbatim, exits 2, and still disconnects", async () => {
    const paths = demoPaths();
    let disconnects = 0;
    const client = {
      connect: async (): Promise<void> => {
        throw "refused by peer";
      },
      disconnect: async (): Promise<void> => {
        disconnects += 1;
      },
      call: async (): Promise<never> => {
        throw new Error("must not be called after a failed connect");
      },
    } as unknown as IPCClient;
    await runDoctor(
      [],
      deps(paths, {
        readGatewayState: async () => ({ socketPath: paths.socketPath, pid: 1 }),
        makeClient: () => client,
      }),
    );
    expect(out.stdout).toContain("[fail] Gateway: IPC failed — refused by peer\n");
    expect(process.exitCode).toBe(2);
    expect(disconnects).toBe(1);
  });

  it("a disconnect that rejects after a complete round trip changes nothing — same report, same exit code", async () => {
    // A differential run: the identical gateway answered twice, the only difference being whether
    // the closing disconnect succeeds. Everything doctor had to say was already printed by then.
    const paths = demoPaths();
    const run = async (
      disconnect: () => Promise<void>,
    ): Promise<{ stdout: string; exitCode: typeof process.exitCode }> => {
      out.reset();
      process.exitCode = 0;
      const mock = createMockIpcClient([
        { uptime: 5000 },
        { ok: true, errors: [], warnings: [] },
        {
          index: { totalItems: 3 },
          connectorHealth: [{ connectorId: "github", state: "healthy" }],
        },
      ]);
      const client = {
        ...(mock.client as unknown as Record<string, unknown>),
        disconnect,
      } as unknown as IPCClient;
      await runDoctor(
        [],
        deps(paths, {
          readGatewayState: async () => ({ socketPath: paths.socketPath, pid: 1 }),
          makeClient: () => client,
        }),
      );
      return { stdout: out.stdout, exitCode: process.exitCode };
    };
    let rejected = 0;
    const control = await run(async () => {});
    const failing = await run(async () => {
      rejected += 1;
      throw new Error("socket already closed");
    });
    expect(rejected).toBe(1);
    expect(failing).toEqual(control);
    expect(control.stdout).toContain("[ok] Gateway: IPC OK (uptime ~5s).\n");
    expect(failing.stdout).not.toContain("socket already closed");
  });
});
